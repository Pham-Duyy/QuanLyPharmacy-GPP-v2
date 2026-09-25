import {
  baseCss,
  escapeHtml,
  htmlDocument,
  join,
  money,
  printDateTime,
  renderIssuerHeader,
} from "../printing/print-common.js";
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
  /** Phần khách trả bằng điểm, nằm trong discountAmount ở trên. */
  loyaltyPointsRedeemed?: number;
  loyaltyDiscountAmount?: number | bigint;
  loyaltyPointsEarned?: number;
  /** Số dư điểm sau hóa đơn này, in cho khách biết còn bao nhiêu. */
  loyaltyBalance?: number | null;
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
  const isA5 = paper === "A5";
  const show = template.display;
  const soldAt = printDateTime(invoice.soldAt);

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

  // Tiền khách trả bằng điểm được in thành dòng riêng, nên dòng "Giảm giá"
  // chỉ còn phần nhà thuốc giảm cho khách.
  const loyaltyDiscount = Number(invoice.loyaltyDiscountAmount ?? 0);
  const discount = Number(invoice.discountAmount) - loyaltyDiscount;
  const vat = Number(invoice.vatAmount);
  const customerName = invoice.customer?.fullName?.trim();

  const info = join([
    infoRow("Số HĐ:", escapeHtml(invoice.code)),
    infoRow("Ngày:", soldAt),
    show.seller && invoice.seller && infoRow("Nhân viên:", escapeHtml(invoice.seller.fullName)),
    show.customer && infoRow("Khách hàng:", customerName ? escapeHtml(customerName) : "Khách lẻ"),
  ]);

  const totals = join([
    totalRow("Tiền hàng", money(invoice.subtotal)),
    show.discount &&
      discount > 0 &&
      totalRow(
        `Giảm giá${invoice.discountReason ? ` (${escapeHtml(invoice.discountReason)})` : ""}`,
        `-${money(discount)}`,
      ),
    loyaltyDiscount > 0 &&
      totalRow(`Đổi ${invoice.loyaltyPointsRedeemed ?? 0} điểm`, `-${money(loyaltyDiscount)}`),
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

  // Dòng điểm tích lũy chỉ in khi hóa đơn thật sự có phát sinh điểm.
  const earned = invoice.loyaltyPointsEarned ?? 0;
  const loyaltyNote =
    earned > 0 || loyaltyDiscount > 0
      ? `<div class="footer">Điểm tích lũy: ${earned > 0 ? `+${earned} điểm` : "không phát sinh"}${
          invoice.loyaltyBalance != null ? ` · còn ${invoice.loyaltyBalance} điểm` : ""
        }</div>`
      : "";

  const body = `
  ${renderIssuerHeader(template)}
  <h1>${escapeHtml(template.title)}</h1>
  <div class="info">${info}</div>
  <hr/>
  ${items}
  <hr/>
  <div class="totals">${totals}</div>
  ${loyaltyNote ? `<hr/>${loyaltyNote}` : ""}
  ${template.footer ? `<hr/><div class="footer">${escapeHtml(template.footer)}</div>` : ""}
  <div class="note">Phiếu bán hàng · Không thay thế hóa đơn điện tử</div>
`;

  return htmlDocument(invoice.code, baseCss(paper), body, Boolean(options.autoPrint));
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
    {
      productName: "Siro ho Prospan chiết xuất lá thường xuân 100ml",
      unitName: "Chai",
      quantity: 1,
      unitPrice: 89_000,
    },
    {
      productName: "Dung dịch nhỏ mắt Natri Clorid 0,9% 10ml",
      unitName: "Lọ",
      quantity: 3,
      unitPrice: 4_000,
    },
    {
      productName: "Men vi sinh Enterogermina 2 tỷ/5ml",
      unitName: "Ống",
      quantity: 10,
      unitPrice: 8_500,
    },
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
  const amountTendered =
    Math.ceil(totalAmount / 50_000) * 50_000 + (kind === "walk_in" ? 0 : 50_000);

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
