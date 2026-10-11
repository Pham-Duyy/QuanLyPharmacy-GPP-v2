import {
  baseCss,
  escapeHtml,
  htmlDocument,
  join,
  money,
  printDateTime,
  renderIssuerHeader,
  type PrintPaper,
} from "../printing/print-common.js";
import type { PrintTemplate } from "../settings/print-template.schema.js";
import type { ShiftView } from "./cash-shifts.service.js";

const row = (label: string, value: string, className = "") =>
  `<div class="row ${className}"><span>${label}</span><span class="num">${value}</span></div>`;
const kv = (label: string, value: string) =>
  `<div class="kv"><span>${label}</span><span>${value}</span></div>`;
const signed = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.abs(value))}`;

/**
 * Phiếu chốt ca trên máy in hóa đơn nhiệt (khổ của mẫu hóa đơn; A4/A5 thì in
 * K80). Ca chưa chốt vẫn in được để xem tạm, có ghi rõ "Chưa chốt".
 */
export function renderCashShiftHtml(
  shift: ShiftView,
  template: PrintTemplate,
  options: { autoPrint: boolean },
): string {
  const paper: PrintPaper = template.paperSize === "K58" ? "K58" : "K80";
  const t = shift.totals;
  const closed = shift.status === "CLOSED";
  const body = `
  ${renderIssuerHeader(template)}
  <h1>PHIẾU CHỐT CA</h1>
  <div class="doc-code">Số: <strong>${escapeHtml(shift.code)}</strong>${closed ? "" : " · Chưa chốt"}</div>
  ${join([
    kv("Mở ca:", `${printDateTime(shift.openedAt)} · ${escapeHtml(shift.openedBy.fullName)}`),
    closed && shift.closedAt && shift.closedBy
      ? kv("Chốt ca:", `${printDateTime(shift.closedAt)} · ${escapeHtml(shift.closedBy.fullName)}`)
      : null,
  ])}
  <hr/>
  ${join([
    row("Tiền đầu ca", money(t.openingCash)),
    row("+ Bán tiền mặt", money(t.cashSales)),
    t.cashVoided ? row("− Hủy hóa đơn tiền mặt", money(t.cashVoided)) : null,
    t.cashRefunds ? row("− Hoàn tiền trả hàng", money(t.cashRefunds)) : null,
    t.cashIn ? row("+ Thu khác", money(t.cashIn)) : null,
    t.cashOut ? row("− Chi khác", money(t.cashOut)) : null,
    row("Tiền mặt dự kiến", `${money(t.expectedCash)} đ`, "grand"),
    closed && shift.countedCash !== null
      ? row("Tiền đếm thực tế", `${money(shift.countedCash)} đ`, "grand")
      : null,
    closed && shift.difference !== null ? row("Chênh lệch", `${signed(shift.difference)} đ`) : null,
  ])}
  ${shift.closeNote ? `<div class="kv"><span>Lý do:</span><span>${escapeHtml(shift.closeNote)}</span></div>` : ""}
  <hr/>
  ${join([
    row(`Hóa đơn trong ca`, String(t.invoiceCount)),
    row("Doanh thu tiền mặt", money(t.salesByMethod.CASH)),
    t.salesByMethod.BANK_TRANSFER
      ? row("Doanh thu chuyển khoản", money(t.salesByMethod.BANK_TRANSFER))
      : null,
    t.salesByMethod.CARD ? row("Doanh thu thẻ", money(t.salesByMethod.CARD)) : null,
    t.voidedCount ? row("Hóa đơn bị hủy", String(t.voidedCount)) : null,
    t.refundCount ? row("Phiếu trả hàng", String(t.refundCount)) : null,
  ])}
  ${
    shift.movements.length
      ? `<hr/><div class="items-head">Thu chi khác</div>${shift.movements
          .map((move) =>
            row(
              `${move.direction === "IN" ? "Thu" : "Chi"}: ${escapeHtml(move.reason)}`,
              `${move.direction === "IN" ? "+" : "−"}${money(move.amount)}`,
            ),
          )
          .join("")}`
      : ""
  }
  <hr/>
  <div class="row"><span>Người giao ca</span><span>Người nhận / chủ nhà thuốc</span></div>
  <div style="height: 14mm"></div>`;
  return htmlDocument(`Phiếu chốt ca ${shift.code}`, baseCss(paper), body, options.autoPrint);
}
