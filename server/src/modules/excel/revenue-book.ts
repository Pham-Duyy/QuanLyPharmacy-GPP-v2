import ExcelJS from "exceljs";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { getEffectiveTemplate } from "../settings/print-template.service.js";

/**
 * Sổ doanh thu bán hàng hóa, dịch vụ của hộ kinh doanh theo Thông tư
 * 152/2025/TT-BTC (áp dụng từ 01/01/2026, thay Thông tư 88/2021).
 *
 *   - S1a-HKD: doanh thu năm không quá 500 triệu, không nộp GTGT, TNCN.
 *   - S2a-HKD: nộp GTGT, TNCN theo tỷ lệ % trên doanh thu, ghi theo nhóm
 *     ngành có cùng tỷ lệ. Nhà thuốc chỉ có một nhóm: phân phối, cung cấp
 *     hàng hóa.
 *
 * Thông tư cho phép ghi tổng hợp theo ngày, nên mỗi ngày một dòng bán hàng
 * và (nếu có) một dòng khách trả hàng. Doanh thu tính đúng như màn Báo cáo:
 * hóa đơn COMPLETED theo ngày làm việc, trừ tiền hoàn theo ngày lập phiếu trả.
 *
 * Phần mềm KHÔNG tự tính số thuế: thuế TNCN từ 2026 tính trên phần doanh thu
 * cả năm vượt 500 triệu, hộ còn được chọn cách tính theo lợi nhuận, nên một
 * sổ theo tháng/quý không đủ căn cứ. Hai dòng thuế của S2a để trống cho người
 * khai thuế điền, kèm ghi chú tỷ lệ tham khảo.
 */

export type RevenueBookForm = "S1a" | "S2a";

type DayRow = { date: Date; amount: bigint; count: bigint; first: string; last: string };

const day = (date: Date) => date.toISOString().slice(0, 10).split("-").reverse().join("/");
const range = (first: string, last: string) => (first === last ? first : `${first} → ${last}`);

/** Một dòng sổ: số hiệu chứng từ, ngày, diễn giải, số tiền (âm với phiếu trả). */
export type BookLine = { reference: string; date: Date; description: string; amount: number };

export async function revenueBookLines(storeId: string, from: Date, to: Date): Promise<BookLine[]> {
  const [sales, refunds] = await Promise.all([
    prisma.$queryRaw<DayRow[]>(Prisma.sql`
      SELECT business_date AS date, SUM(total_amount)::bigint AS amount, COUNT(*)::bigint AS count,
             MIN(code) AS first, MAX(code) AS last
      FROM invoices
      WHERE store_id = ${storeId}::uuid AND status = 'COMPLETED'
        AND business_date >= ${from}::date AND business_date <= ${to}::date
      GROUP BY business_date
    `),
    prisma.$queryRaw<DayRow[]>(Prisma.sql`
      SELECT business_date AS date, SUM(refund_amount)::bigint AS amount, COUNT(*)::bigint AS count,
             MIN(code) AS first, MAX(code) AS last
      FROM returns
      WHERE store_id = ${storeId}::uuid
        AND business_date >= ${from}::date AND business_date <= ${to}::date
      GROUP BY business_date
    `),
  ]);

  const lines = [
    ...sales.map((row) => ({
      reference: range(row.first, row.last),
      date: row.date,
      description: `Bán lẻ thuốc và hàng hóa – ${Number(row.count)} hóa đơn`,
      amount: Number(row.amount),
      order: 0,
    })),
    ...refunds
      .filter((row) => Number(row.amount) !== 0)
      .map((row) => ({
        reference: range(row.first, row.last),
        date: row.date,
        description: `Khách trả hàng, hoàn tiền – ${Number(row.count)} phiếu`,
        amount: -Number(row.amount),
        order: 1,
      })),
  ];
  lines.sort((a, b) => a.date.getTime() - b.date.getTime() || a.order - b.order);
  return lines.map(({ order: _order, ...line }) => line);
}

/** Dựng tệp sổ đúng bố cục mẫu: phần đầu, cột A–B–C–1, dòng tổng, chỗ ký. */
export async function buildRevenueBook(
  storeId: string,
  form: RevenueBookForm,
  from: Date,
  to: Date,
): Promise<{ buffer: Buffer; rows: number }> {
  const [lines, { template }, einvoice] = await Promise.all([
    revenueBookLines(storeId, from, to),
    getEffectiveTemplate(storeId),
    prisma.eInvoiceStoreConfig.findUnique({ where: { storeId }, select: { taxCode: true } }),
  ]);
  const owner = template.companyName || template.storeName;
  const taxCode = template.taxCode || einvoice?.taxCode || "";
  const total = lines.reduce((sum, line) => sum + line.amount, 0);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pharmacy GPP";
  const ws = workbook.addWorksheet(`Mẫu ${form}-HKD`, {
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  ws.columns = [{ width: 30 }, { width: 13 }, { width: 46 }, { width: 18 }];
  const money = "#,##0;-#,##0";

  const put = (
    values: Array<string | number | null>,
    style?: { bold?: boolean; italic?: boolean; center?: boolean; size?: number },
  ) => {
    const row = ws.addRow(values);
    row.font = {
      bold: style?.bold ?? false,
      italic: style?.italic ?? false,
      size: style?.size ?? 11,
    };
    if (style?.center) {
      ws.mergeCells(row.number, 1, row.number, 4);
      row.getCell(1).alignment = { horizontal: "center", wrapText: true };
    }
    return row;
  };

  // Phần đầu sổ.
  const head = ws.addRow([`HỘ, CÁ NHÂN KINH DOANH: ${owner}`, null, `Mẫu số ${form}-HKD`]);
  head.font = { bold: true };
  ws.mergeCells(head.number, 1, head.number, 2);
  ws.mergeCells(head.number, 3, head.number, 4);
  head.getCell(3).alignment = { horizontal: "center" };
  const sub = ws.addRow([
    `Địa chỉ: ${template.address}`,
    null,
    "(Kèm theo Thông tư số 152/2025/TT-BTC)",
  ]);
  ws.mergeCells(sub.number, 1, sub.number, 2);
  ws.mergeCells(sub.number, 3, sub.number, 4);
  sub.getCell(3).alignment = { horizontal: "center" };
  sub.getCell(3).font = { italic: true, size: 10 };
  put([`Mã số thuế: ${taxCode || "(chưa khai — nhập ở Cài đặt → Mẫu in hóa đơn)"}`]);
  ws.addRow([]);
  put(["SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ"], { bold: true, center: true, size: 14 });
  put([`Địa điểm kinh doanh: ${template.storeName}`], { center: true });
  put([`Kỳ: từ ngày ${day(from)} đến ngày ${day(to)}`], { center: true });
  ws.addRow([]);

  // Bảng.
  const header = ws.addRow(["Số hiệu chứng từ", "Ngày, tháng", "Diễn giải", "Số tiền"]);
  const letters = ws.addRow(["A", "B", "C", "1"]);
  for (const row of [header, letters]) {
    row.font = { bold: true };
    row.eachCell((cell) => {
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
  }
  const bordered = (row: ExcelJS.Row) =>
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });

  if (form === "S2a") {
    const group = ws.addRow([null, null, "Ngành nghề: Phân phối, cung cấp hàng hóa", null]);
    group.font = { bold: true };
    bordered(group);
  }
  for (const line of lines) {
    const row = ws.addRow([line.reference, day(line.date), line.description, line.amount]);
    row.getCell(4).numFmt = money;
    row.getCell(1).alignment = { wrapText: true };
    bordered(row);
  }
  if (lines.length === 0)
    bordered(ws.addRow([null, null, "Không phát sinh doanh thu trong kỳ", 0]));

  const totalRow = ws.addRow([null, null, form === "S2a" ? "Tổng cộng (1)" : "Tổng cộng", total]);
  totalRow.font = { bold: true };
  totalRow.getCell(4).numFmt = money;
  bordered(totalRow);

  if (form === "S2a") {
    for (const label of ["Thuế GTGT phải nộp", "Thuế TNCN phải nộp"]) {
      const row = ws.addRow([null, null, label, null]);
      row.font = { bold: true };
      bordered(row);
    }
    ws.addRow([]);
    put(
      [
        "Ghi chú: phần mềm không tự tính số thuế. Tham khảo cho phân phối, cung cấp hàng hóa: GTGT 1% doanh thu; TNCN 0,5% trên phần doanh thu cả năm vượt 500 triệu đồng (năm 2026). Đối chiếu hướng dẫn của cơ quan thuế trước khi khai.",
      ],
      { italic: true, center: true, size: 10 },
    ).height = 42;
  }

  // Chỗ ký.
  ws.addRow([]);
  const sign = ws.addRow([null, null, "Ngày ..... tháng ..... năm .........", null]);
  ws.mergeCells(sign.number, 3, sign.number, 4);
  sign.getCell(3).alignment = { horizontal: "center" };
  sign.getCell(3).font = { italic: true };
  const role = ws.addRow([null, null, "NGƯỜI ĐẠI DIỆN HỘ KINH DOANH", null]);
  ws.mergeCells(role.number, 3, role.number, 4);
  role.getCell(3).alignment = { horizontal: "center" };
  role.getCell(3).font = { bold: true };
  const hint = ws.addRow([null, null, "(Ký, họ tên, đóng dấu nếu có)", null]);
  ws.mergeCells(hint.number, 3, hint.number, 4);
  hint.getCell(3).alignment = { horizontal: "center" };
  hint.getCell(3).font = { italic: true, size: 10 };

  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), rows: lines.length };
}
