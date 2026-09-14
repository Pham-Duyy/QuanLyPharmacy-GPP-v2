import type { getDetail } from "./invoices.service.js";

// Không có type Invoice riêng: lấy thẳng kiểu trả về của getDetail, để hai
// nơi không bao giờ lệch hình dạng dữ liệu với nhau.
type Invoice = Awaited<ReturnType<typeof getDetail>>;
type Store = { name: string; address: string | null; phone: string | null };

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
    .replaceAll('"', "&quot;");
}

/**
 * Dựng trang HTML để in hóa đơn (contract §14, `GET /invoices/{id}/print`).
 *
 * Không dùng thư viện tạo PDF: máy in nhiệt và máy in khổ A5 ở nhà thuốc
 * đều in được thẳng từ hộp thoại in của trình duyệt, nên chỉ cần một trang
 * HTML định dạng đúng khổ giấy. `format` chỉ đổi khổ giấy và cỡ chữ qua CSS,
 * nội dung và cách tính hoàn toàn giống nhau giữa hai khổ.
 */
export function renderInvoicePrintHtml(
  invoice: Invoice,
  store: Store,
  format: "k80" | "a5",
): string {
  const isK80 = format === "k80";

  const rows = invoice.lines
    .map(
      (line) => `
        <tr>
          <td colspan="${isK80 ? 2 : 1}">${escapeHtml(line.productName)}</td>
          ${isK80 ? "" : `<td class="num">${line.quantity} ${escapeHtml(line.unitName)}</td>`}
          <td class="num">${money(line.unitPrice)}</td>
          <td class="num">${money(line.lineTotal)}</td>
        </tr>
        ${
          isK80
            ? `<tr class="sub"><td colspan="3">${line.quantity} ${escapeHtml(line.unitName)} x ${money(line.unitPrice)}</td></tr>`
            : ""
        }`,
    )
    .join("");

  const soldAt = new Date(invoice.soldAt).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
  });

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(invoice.code)}</title>
<style>
  @page { size: ${isK80 ? "80mm auto" : "A5"}; margin: ${isK80 ? "2mm" : "10mm"}; }
  body {
    font-family: "Courier New", monospace;
    width: ${isK80 ? "76mm" : "auto"};
    margin: 0 auto;
    font-size: ${isK80 ? "11px" : "13px"};
    color: #000;
  }
  h1 { font-size: ${isK80 ? "13px" : "18px"}; text-align: center; margin: 4px 0; }
  .center { text-align: center; }
  .muted { color: #444; font-size: 0.9em; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  td.num { text-align: right; white-space: nowrap; }
  tr.sub td { padding-top: 0; color: #444; font-size: 0.9em; }
  .totals td { padding: 2px 0; }
  .totals td.num { font-weight: normal; }
  .grand td { font-weight: bold; font-size: ${isK80 ? "13px" : "16px"}; }
  .footer { text-align: center; margin-top: 10px; font-size: 0.9em; }
</style>
</head>
<body onload="window.print()">
  <h1>${escapeHtml(store.name)}</h1>
  <p class="center muted">
    ${store.address ? `${escapeHtml(store.address)}<br/>` : ""}
    ${store.phone ? `ĐT: ${escapeHtml(store.phone)}` : ""}
  </p>
  <h1>HÓA ĐƠN BÁN HÀNG</h1>
  <p class="muted">
    Số: ${escapeHtml(invoice.code)}<br/>
    Ngày: ${soldAt}<br/>
    Người bán: ${escapeHtml(invoice.seller.fullName)}<br/>
    ${invoice.customer ? `Khách: ${escapeHtml(invoice.customer.fullName ?? "")}<br/>` : ""}
  </p>
  <hr/>
  <table>
    ${isK80 ? "" : '<tr><td><strong>Sản phẩm</strong></td><td class="num"><strong>SL</strong></td><td class="num"><strong>Đơn giá</strong></td><td class="num"><strong>Thành tiền</strong></td></tr>'}
    ${rows}
  </table>
  <hr/>
  <table class="totals">
    <tr><td>Tạm tính</td><td class="num">${money(invoice.subtotal)}</td></tr>
    ${
      invoice.discountAmount > 0
        ? `<tr><td>Giảm giá${invoice.discountReason ? ` (${escapeHtml(invoice.discountReason)})` : ""}</td><td class="num">-${money(invoice.discountAmount)}</td></tr>`
        : ""
    }
    <tr><td>Trong đó VAT</td><td class="num">${money(invoice.vatAmount)}</td></tr>
    <tr class="grand"><td>TỔNG TIỀN</td><td class="num">${money(invoice.totalAmount)}</td></tr>
    ${
      invoice.amountTendered !== null
        ? `<tr><td>Khách đưa</td><td class="num">${money(invoice.amountTendered)}</td></tr>
           <tr><td>Tiền thừa</td><td class="num">${money(invoice.changeAmount ?? 0)}</td></tr>`
        : ""
    }
  </table>
  <p class="footer">Cảm ơn quý khách. Vui lòng giữ hóa đơn khi cần trả hàng.</p>
</body>
</html>`;
}
