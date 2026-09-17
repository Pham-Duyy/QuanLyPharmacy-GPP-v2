import type { PaperSize, PrintTemplate } from "../settings/print-template.schema.js";

/**
 * Dữ liệu tối thiểu để in một hóa đơn. Cố ý không gắn với kiểu trả về của
 * getDetail: xem trước ở màn Cài đặt dùng dữ liệu mẫu cùng hình dạng này,
 * nhờ vậy xem trước, in thử và in thật đi qua đúng MỘT hàm render.
 */
export type PrintableInvoice = {
  code: string;
  soldAt: Date | string;
  seller: { fullName: string } | null;
  customer: { fullName: string | null; phone?: string | null } | null;
  lines: Array<{
    productName: string;
    unitName: string;
    quantity: number;
    unitPrice: number | bigint;
    lineTotal: number | bigint;
  }>;
  subtotal: number | bigint;
  discountAmount: number | bigint;
  discountReason: string | null;
  vatAmount: number | bigint;
  totalAmount: number | bigint;
  paymentMethod: string;
  amountTendered: number | bigint | null;
  changeAmount: number | bigint | null;
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  CARD: "Thẻ",
};

/**
 * Định dạng tiền Việt, không có ký hiệu ₫ để khớp cách trình bày hóa đơn
 * giấy. Cột tiền trong CSDL là BigInt (ERD §1.3); chuyển sang Number để in
 * an toàn vì số tiền một nhà thuốc nằm rất xa giới hạn an toàn của JS
 * (giống lý do đã áp dụng ở bigint-json.ts).
 */
function money(value: number | bigint): string {
  return new Intl.NumberFormat("vi-VN").format(Number(value));
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Chỉ nhận data URL ảnh PNG/JPEG đã được kiểm tra khi lưu; mọi thứ khác bị bỏ qua. */
function safeLogo(logo: string | null): string | null {
  return logo && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo) ? logo : null;
}

const PAGE: Record<PaperSize, { page: string; margin: string; width: string; font: string }> = {
  K80: { page: "80mm auto", margin: "3mm", width: "74mm", font: "12px" },
  K58: { page: "58mm auto", margin: "2mm", width: "54mm", font: "11px" },
  A5: { page: "A5", margin: "10mm", width: "auto", font: "13px" },
};

/** Ghép các dòng có nội dung; dòng rỗng hoặc bị tắt không để lại khoảng trống. */
function lines(items: Array<string | false | null | undefined>): string {
  return items.filter((item): item is string => Boolean(item)).join("");
}

function infoRow(label: string, value: string): string {
  return `<div class="kv"><span>${label}</span><span>${value}</span></div>`;
}

function totalRow(label: string, value: string, className = ""): string {
  return `<div class="row ${className}"><span>${label}</span><span class="num">${value}</span></div>`;
}

export type RenderOptions = {
  /** Mở hộp thoại in ngay khi trang tải xong. Xem trước thì tắt. */
  autoPrint?: boolean;
  /** Ghi đè khổ giấy của mẫu (giữ tương thích tham số `format` cũ). */
  paperSize?: PaperSize;
};

/**
 * Dựng trang HTML để in hóa đơn bán lẻ tại quầy (contract §14,
 * `GET /invoices/{id}/print`). Đây là phiếu thanh toán, không phải hóa đơn
 * điện tử.
 *
 * Không dùng thư viện tạo PDF: máy in nhiệt và máy in khổ A5 ở nhà thuốc
 * đều in được thẳng từ hộp thoại in của trình duyệt. Mọi số tiền lấy nguyên
 * từ hóa đơn đã lưu, hàm này không tính lại gì — kể cả quy đổi hộp/vỉ/viên.
 */
export function renderInvoicePrintHtml(
  invoice: PrintableInvoice,
  template: PrintTemplate,
  options: RenderOptions = {},
): string {
  const paper = options.paperSize ?? template.paperSize;
  const size = PAGE[paper];
  const isA5 = paper === "A5";
  const show = template.display;
  const logo = show.logo ? safeLogo(template.logo) : null;

  const soldAt = new Date(invoice.soldAt).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const qty = (line: PrintableInvoice["lines"][number]) =>
    show.unit ? `${line.quantity} ${escapeHtml(line.unitName)}` : String(line.quantity);

  const items = isA5
    ? `<table class="items">
        <thead><tr>
          <th class="stt">STT</th><th>Tên thuốc</th>
          ${show.unit ? "<th>ĐVT</th>" : ""}
          <th class="num">SL</th><th class="num">Đơn giá</th><th class="num">Thành tiền</th>
        </tr></thead>
        <tbody>${invoice.lines
          .map(
            (line, index) => `<tr>
              <td class="stt">${index + 1}</td>
              <td class="name">${escapeHtml(line.productName)}</td>
              ${show.unit ? `<td>${escapeHtml(line.unitName)}</td>` : ""}
              <td class="num">${line.quantity}</td>
              <td class="num">${money(line.unitPrice)}</td>
              <td class="num">${money(line.lineTotal)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>`
    : `<div class="row items-head"><span>${paper === "K58" ? "SL × Đơn giá" : "Sản phẩm / SL × Đơn giá"}</span><span class="num">Thành tiền</span></div>
      <div class="items">${invoice.lines
        .map(
          (line) => `<div class="item">
            <div class="name">${escapeHtml(line.productName)}</div>
            <div class="row"><span>${qty(line)} × ${money(line.unitPrice)}</span><span class="num">${money(line.lineTotal)}</span></div>
          </div>`,
        )
        .join("")}</div>`;

  const discount = Number(invoice.discountAmount);
  const vat = Number(invoice.vatAmount);
  const customerName = invoice.customer?.fullName?.trim();

  const header = lines([
    logo && `<img class="logo" src="${logo}" alt="" />`,
    template.companyName && `<div class="company">${escapeHtml(template.companyName)}</div>`,
    `<div class="store">${escapeHtml(template.storeName)}</div>`,
    template.address && `<div>${escapeHtml(template.address)}</div>`,
    template.phone && `<div>ĐT: ${escapeHtml(template.phone)}</div>`,
    template.taxCode && `<div>MST: ${escapeHtml(template.taxCode)}</div>`,
  ]);

  const info = lines([
    infoRow("Số HĐ:", escapeHtml(invoice.code)),
    infoRow("Ngày:", soldAt),
    show.seller && invoice.seller && infoRow("Nhân viên:", escapeHtml(invoice.seller.fullName)),
    show.customer && infoRow("Khách hàng:", customerName ? escapeHtml(customerName) : "Khách lẻ"),
  ]);

  const totals = lines([
    totalRow("Tiền hàng", money(invoice.subtotal)),
    show.discount &&
      discount > 0 &&
      totalRow(
        `Giảm giá${invoice.discountReason ? ` (${escapeHtml(invoice.discountReason)})` : ""}`,
        `-${money(discount)}`,
      ),
    vat > 0 && totalRow("Trong đó thuế GTGT", money(vat)),
    totalRow("TỔNG THANH TOÁN", `${money(invoice.totalAmount)} đ`, "grand"),
    show.paymentMethod &&
      totalRow(
        "Hình thức",
        escapeHtml(PAYMENT_METHOD_LABEL[invoice.paymentMethod] ?? invoice.paymentMethod),
      ),
    show.cashChange &&
      invoice.amountTendered !== null &&
      totalRow("Khách đưa", money(invoice.amountTendered)),
    show.cashChange &&
      invoice.amountTendered !== null &&
      totalRow("Tiền thừa", money(invoice.changeAmount ?? 0)),
  ]);

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(invoice.code)}</title>
<style>
  @page { size: ${size.page}; margin: ${size.margin}; }
  * { box-sizing: border-box; }
  html { background: #fff; }
  body {
    font-family: Arial, "Helvetica Neue", "Segoe UI", Roboto, "Noto Sans", sans-serif;
    width: ${size.width};
    max-width: 100%;
    margin: 0 auto;
    padding: ${isA5 ? "0" : "2mm 0"};
    font-size: ${size.font};
    line-height: 1.35;
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .head { text-align: center; }
  .logo { display: block; max-width: ${isA5 ? "40mm" : "60%"}; max-height: 22mm; margin: 0 auto 4px; object-fit: contain; }
  .company { font-size: 0.92em; text-transform: uppercase; }
  .store { font-weight: 700; font-size: 1.15em; }
  h1 { font-size: ${isA5 ? "1.6em" : "1.25em"}; text-align: center; margin: 8px 0 6px; letter-spacing: 0.02em; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .name { overflow-wrap: anywhere; word-break: break-word; }
  .kv { display: grid; grid-template-columns: ${isA5 ? "28mm" : "21mm"} 1fr; gap: 4px; }
  .kv > span:last-child { overflow-wrap: anywhere; }
  .items-head { font-weight: 700; padding-bottom: 3px; border-bottom: 1px dashed #000; margin-bottom: 2px; }
  .item { padding: 3px 0; break-inside: avoid; page-break-inside: avoid; }
  .item .name { font-weight: 600; }
  .grand { font-weight: 700; font-size: ${paper === "K58" ? "1.05em" : "1.15em"}; margin: 3px 0; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th, table.items td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
  table.items th { background: #f2f2f2; font-weight: 700; }
  table.items th.num, table.items td.num { text-align: right; }
  table.items .stt { width: 8mm; text-align: center; }
  table.items thead { display: table-header-group; }
  table.items tr { break-inside: avoid; page-break-inside: avoid; }
  .totals { ${isA5 ? "width: 60%; margin-left: auto;" : ""} }
  .footer { text-align: center; margin-top: 6px; font-style: italic; white-space: pre-line; overflow-wrap: anywhere; }
  .note { text-align: center; font-size: 0.8em; margin-top: 6px; }
  @media screen { body { padding: ${isA5 ? "10mm" : "3mm"}; } }
  @media print { .no-print { display: none !important; } }
</style>
</head>
<body${options.autoPrint ? ' onload="window.print()"' : ""}>
  <div class="head">${header}</div>
  <h1>${escapeHtml(template.title)}</h1>
  <div class="info">${info}</div>
  <hr/>
  ${items}
  <hr/>
  <div class="totals">${totals}</div>
  ${template.footer ? `<hr/><div class="footer">${escapeHtml(template.footer)}</div>` : ""}
  <div class="note">Phiếu bán hàng · Không thay thế hóa đơn điện tử</div>
</body>
</html>`;
}

/** Dữ liệu mẫu cho xem trước ở màn Cài đặt; không tạo giao dịch thật nào. */
export function sampleInvoice(kind: "standard" | "long" | "walk_in"): PrintableInvoice {
  const base = [
    { productName: "Paracetamol 500mg (Hapacol)", unitName: "Vỉ", quantity: 2, unitPrice: 15_000 },
    { productName: "Vitamin C 1000mg sủi", unitName: "Tuýp", quantity: 1, unitPrice: 45_000 },
    { productName: "Khẩu trang y tế 4 lớp", unitName: "Hộp", quantity: 1, unitPrice: 35_000 },
  ];
  const long = [
    {
      productName:
        "Amoxicillin + Acid Clavulanic 875mg/125mg (Augmentin) viên nén bao phim — hộp 2 vỉ x 7 viên",
      unitName: "Viên",
      quantity: 14,
      unitPrice: 18_500,
    },
    { productName: "Siro ho Prospan chiết xuất lá thường xuân 100ml", unitName: "Chai", quantity: 1, unitPrice: 89_000 },
    { productName: "Dung dịch nhỏ mắt Natri Clorid 0,9% 10ml", unitName: "Lọ", quantity: 3, unitPrice: 4_000 },
    { productName: "Men vi sinh Enterogermina 2 tỷ/5ml", unitName: "Ống", quantity: 10, unitPrice: 8_500 },
    { productName: "Oresol 245 hương cam", unitName: "Gói", quantity: 5, unitPrice: 2_500 },
    ...base,
  ];

  const picked = (kind === "long" ? long : base).map((line) => ({
    ...line,
    lineTotal: line.quantity * line.unitPrice,
  }));
  const subtotal = picked.reduce((sum, line) => sum + line.lineTotal, 0);
  const discountAmount = kind === "walk_in" ? 0 : 5_000;
  const totalAmount = subtotal - discountAmount;
  const amountTendered = Math.ceil(totalAmount / 50_000) * 50_000 + (kind === "walk_in" ? 0 : 50_000);

  return {
    code: "HD-NT01-260917-0001",
    soldAt: new Date(),
    seller: { fullName: "Nguyễn Thị Dược" },
    customer: kind === "walk_in" ? null : { fullName: "Trần Văn An", phone: "0901234567" },
    lines: picked,
    subtotal,
    discountAmount,
    discountReason: discountAmount > 0 ? "Khách thân thiết" : null,
    vatAmount: Math.round(totalAmount - totalAmount / 1.05),
    totalAmount,
    paymentMethod: "CASH",
    amountTendered,
    changeAmount: amountTendered - totalAmount,
  };
}
