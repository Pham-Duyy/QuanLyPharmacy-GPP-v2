import type { DocumentPrintConfig } from "../settings/document-print.schema.js";
import type { PrintTemplate } from "../settings/print-template.schema.js";
import {
  PAPER,
  baseCss,
  escapeHtml,
  htmlDocument,
  join,
  longDate,
  renderIssuerHeader,
  vndInWords,
  type PrintPaper,
} from "./print-common.js";

export type DocumentColumn = {
  label: string;
  /**
   * Vai trò của cột khi in khổ nhiệt (không đủ chỗ cho bảng): `name` in đậm
   * dòng đầu, `detail` gom thành dòng phụ, `amount` căn phải cùng dòng phụ.
   */
  role: "name" | "detail" | "amount";
  align?: "left" | "right" | "center";
  width?: string;
  /** Mã/ngày không được ngắt giữa chừng (số lô, hạn dùng). */
  nowrap?: boolean;
};

export type DocumentSignature = { title: string; name?: string | null };

/**
 * Chứng từ đã dựng sẵn nội dung, không phụ thuộc loại phiếu. Mọi ô trong
 * `rows` và giá trị trong `info` là văn bản thô — hàm render tự thoát ký tự.
 */
export type PrintDocument = {
  code: string;
  /** Ngày ghi ở dòng ký tên. */
  date: Date | string;
  /** Dòng cảnh báo trạng thái (bản nháp, đã hủy…) in nổi bật ở đầu phiếu. */
  stamp?: string | null;
  info: Array<{ label: string; value: string | null | undefined }>;
  columns: DocumentColumn[];
  rows: string[][];
  totals: Array<{ label: string; value: string; strong?: boolean }>;
  amountInWords?: number | bigint | null;
  note?: string | null;
  signatures: DocumentSignature[];
};

const DOCUMENT_CSS = `
  .stamp { margin: 6px 0; padding: 4px 6px; border: 1.5px solid #000; text-align: center; font-weight: 700; text-transform: uppercase; }
  .info { margin: 4px 0; }
  .words { margin-top: 4px; font-style: italic; }
  .doc-note { margin-top: 6px; white-space: pre-line; overflow-wrap: anywhere; }
  .sign-date { margin-top: 12px; text-align: right; font-style: italic; }
  .signs { display: grid; gap: 8px; margin-top: 4px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .sign strong { display: block; }
  .sign small { display: block; font-style: italic; font-size: 0.85em; }
  .sign .space { height: 18mm; }
  table.items td.nowrap { white-space: nowrap; word-break: normal; overflow-wrap: normal; }
  .sign .who { font-weight: 600; overflow-wrap: anywhere; }
`;

function cell(value: string): string {
  return escapeHtml(value);
}

function renderTable(doc: PrintDocument): string {
  const head = doc.columns
    .map(
      (column) =>
        `<th class="${column.align === "right" ? "num" : column.align === "center" ? "center" : ""}"${column.width ? ` style="width:${column.width}"` : ""}>${escapeHtml(column.label)}</th>`,
    )
    .join("");
  const body = doc.rows
    .map(
      (row, index) =>
        `<tr><td class="stt">${index + 1}</td>${row
          .map((value, col) => {
            const align = doc.columns[col]?.align;
            const className =
              (align === "right" ? "num" : align === "center" ? "center" : "name") +
              (doc.columns[col]?.nowrap ? " nowrap" : "");
            return `<td class="${className}">${cell(value)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="items"><thead><tr><th class="stt">STT</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderStacked(doc: PrintDocument): string {
  return `<div class="items">${doc.rows
    .map((row, index) => {
      const pick = (role: DocumentColumn["role"]) =>
        row.filter((value, col) => doc.columns[col]?.role === role && value.trim() !== "");
      const name = pick("name").map(cell).join(" · ");
      const detail = pick("detail").map(cell).join(" · ");
      const amount = pick("amount").map(cell).join(" ");
      return `<div class="item">
        <div class="name">${index + 1}. ${name}</div>
        ${detail || amount ? `<div class="row sub"><span>${detail}</span><span class="num">${amount}</span></div>` : ""}
      </div>`;
    })
    .join("")}</div>`;
}

/**
 * Dựng HTML in cho các chứng từ ngoài hóa đơn (phiếu nhập, phiếu trả,
 * phiếu điều chỉnh). Xem trước ở Cài đặt, in thử và in thật đều gọi hàm
 * này, khác nhau duy nhất ở dữ liệu đưa vào.
 */
export function renderDocumentHtml(
  doc: PrintDocument,
  header: PrintTemplate,
  config: DocumentPrintConfig,
  options: { autoPrint?: boolean } = {},
): string {
  const paper = config.paperSize as PrintPaper;
  const thermal = PAPER[paper].thermal;

  const info = join(
    doc.info.map(
      (row) =>
        row.value !== null &&
        row.value !== undefined &&
        row.value.trim() !== "" &&
        `<div class="kv"><span>${escapeHtml(row.label)}:</span><span>${escapeHtml(row.value)}</span></div>`,
    ),
  );

  const totals = join(
    doc.totals.map(
      (row) =>
        `<div class="row ${row.strong ? "grand" : ""}"><span>${escapeHtml(row.label)}</span><span class="num">${escapeHtml(row.value)}</span></div>`,
    ),
  );

  const signatures =
    config.showSignatures && doc.signatures.length > 0
      ? `<div class="sign-date">${longDate(doc.date)}</div>
       <div class="signs" style="grid-template-columns: repeat(${thermal ? Math.min(2, doc.signatures.length) : doc.signatures.length}, minmax(0, 1fr))">
         ${doc.signatures
           .map(
             (sign) => `<div class="sign">
               <strong>${escapeHtml(sign.title)}</strong>
               <small>(Ký, ghi rõ họ tên)</small>
               <div class="space"></div>
               ${sign.name ? `<div class="who">${escapeHtml(sign.name)}</div>` : ""}
             </div>`,
           )
           .join("")}
       </div>`
      : "";

  const body = `
  ${renderIssuerHeader(header)}
  <h1>${escapeHtml(config.title)}</h1>
  <div class="doc-code">Số: <strong>${escapeHtml(doc.code)}</strong></div>
  ${doc.stamp ? `<div class="stamp">${escapeHtml(doc.stamp)}</div>` : ""}
  <div class="info">${info}</div>
  <hr/>
  ${thermal ? renderStacked(doc) : renderTable(doc)}
  ${totals ? `<hr/><div class="totals">${totals}</div>` : ""}
  ${
    config.showAmountInWords && doc.amountInWords !== null && doc.amountInWords !== undefined
      ? `<div class="words">Số tiền bằng chữ: ${escapeHtml(vndInWords(doc.amountInWords))}.</div>`
      : ""
  }
  ${config.showNote && doc.note?.trim() ? `<div class="doc-note">Ghi chú: ${escapeHtml(doc.note.trim())}</div>` : ""}
  ${signatures}
  ${config.footer ? `<hr/><div class="footer">${escapeHtml(config.footer)}</div>` : ""}
`;

  return htmlDocument(doc.code, baseCss(paper) + DOCUMENT_CSS, body, Boolean(options.autoPrint));
}
