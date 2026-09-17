import type { PrintTemplate } from "../settings/print-template.schema.js";

/**
 * Phần dùng chung của mọi bản in (hóa đơn, phiếu nhập, phiếu trả, phiếu
 * điều chỉnh): thoát ký tự, định dạng tiền/ngày, đọc số tiền bằng chữ, khối
 * thông tin đơn vị và CSS theo khổ giấy. Thông tin đơn vị (logo, tên, địa
 * chỉ, MST) lấy từ Mẫu in hóa đơn để mọi chứng từ của cửa hàng thống nhất.
 */

export type PrintPaper = "K80" | "K58" | "A5" | "A4";

export const PAPER: Record<
  PrintPaper,
  { page: string; margin: string; width: string; font: string; thermal: boolean }
> = {
  K80: { page: "80mm auto", margin: "3mm", width: "74mm", font: "12px", thermal: true },
  K58: { page: "58mm auto", margin: "2mm", width: "54mm", font: "11px", thermal: true },
  A5: { page: "A5", margin: "10mm", width: "auto", font: "12.5px", thermal: false },
  A4: { page: "A4", margin: "12mm", width: "auto", font: "13px", thermal: false },
};

/**
 * Định dạng tiền Việt, không có ký hiệu ₫ để khớp cách trình bày chứng từ
 * giấy. Cột tiền trong CSDL là BigInt (ERD §1.3); chuyển sang Number để in
 * an toàn vì số tiền một nhà thuốc nằm rất xa giới hạn an toàn của JS
 * (giống lý do đã áp dụng ở bigint-json.ts).
 */
export function money(value: number | bigint): string {
  return new Intl.NumberFormat("vi-VN").format(Number(value));
}

export function num(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(value);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const VN_TIME = { timeZone: "Asia/Ho_Chi_Minh" } as const;

export function printDateTime(value: Date | string): string {
  return new Date(value).toLocaleString("vi-VN", {
    ...VN_TIME,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Cột kiểu `date` lưu nửa đêm UTC: đọc theo UTC để không lệch ngày. */
export function printDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("vi-VN", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** "Ngày 17 tháng 09 năm 2026" cho dòng ký tên. */
export function longDate(value: Date | string): string {
  const [day, month, year] = new Date(value)
    .toLocaleDateString("vi-VN", { ...VN_TIME, day: "2-digit", month: "2-digit", year: "numeric" })
    .split("/");
  return `Ngày ${day} tháng ${month} năm ${year}`;
}

/** Chỉ nhận data URL ảnh PNG/JPEG đã được kiểm tra khi lưu; mọi thứ khác bị bỏ qua. */
export function safeLogo(logo: string | null): string | null {
  return logo && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo) ? logo : null;
}

const DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

function readTriple(value: number, full: boolean): string {
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor(value / 10) % 10;
  const ones = value % 10;
  const parts: string[] = [];

  if (full || hundreds > 0) parts.push(`${DIGITS[hundreds]} trăm`);
  if (tens === 0) {
    if (ones > 0) {
      if (full || hundreds > 0) parts.push("lẻ");
      parts.push(DIGITS[ones]!);
    }
    return parts.join(" ");
  }

  parts.push(tens === 1 ? "mười" : `${DIGITS[tens]} mươi`);
  if (ones === 1) parts.push(tens === 1 ? "một" : "mốt");
  else if (ones === 4) parts.push(tens === 1 ? "bốn" : "tư");
  else if (ones === 5) parts.push("lăm");
  else if (ones > 0) parts.push(DIGITS[ones]!);
  return parts.join(" ");
}

/** Đọc số tiền bằng chữ theo cách viết trên chứng từ kế toán: "Một trăm lẻ năm nghìn đồng". */
export function vndInWords(value: number | bigint): string {
  const amount = Number(value);
  let rest = Math.round(Math.abs(amount));
  if (rest === 0) return "Không đồng";

  const groups: number[] = [];
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const units = ["", " nghìn", " triệu"];
  const words: string[] = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group === 0) continue;
    const unit = units[index % 3]! + " tỷ".repeat(Math.floor(index / 3));
    words.push(readTriple(group, index < groups.length - 1) + unit);
  }

  const sentence = `${amount < 0 ? "âm " : ""}${words.join(" ")} đồng`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Ghép các đoạn có nội dung; đoạn rỗng hoặc bị tắt không để lại khoảng trống. */
export function join(items: Array<string | false | null | undefined>): string {
  return items.filter((item): item is string => Boolean(item)).join("");
}

/** Khối thông tin đơn vị ở đầu mọi chứng từ. */
export function renderIssuerHeader(template: PrintTemplate): string {
  const logo = template.display.logo ? safeLogo(template.logo) : null;
  return `<div class="head">${join([
    logo && `<img class="logo" src="${logo}" alt="" />`,
    template.companyName && `<div class="company">${escapeHtml(template.companyName)}</div>`,
    `<div class="store">${escapeHtml(template.storeName)}</div>`,
    template.address && `<div>${escapeHtml(template.address)}</div>`,
    template.phone && `<div>ĐT: ${escapeHtml(template.phone)}</div>`,
    template.taxCode && `<div>MST: ${escapeHtml(template.taxCode)}</div>`,
  ])}</div>`;
}

/** CSS nền: font có dấu tiếng Việt, khổ giấy, chữ đen trên nền trắng, không cắt nội dung. */
export function baseCss(paper: PrintPaper): string {
  const size = PAPER[paper];
  return `
  @page { size: ${size.page}; margin: ${size.margin}; }
  * { box-sizing: border-box; }
  html { background: #fff; }
  body {
    font-family: Arial, "Helvetica Neue", "Segoe UI", Roboto, "Noto Sans", sans-serif;
    width: ${size.width};
    max-width: 100%;
    margin: 0 auto;
    padding: ${size.thermal ? "2mm 0" : "0"};
    font-size: ${size.font};
    line-height: 1.35;
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .head { text-align: center; }
  .logo { display: block; max-width: ${size.thermal ? "60%" : "40mm"}; max-height: 22mm; margin: 0 auto 4px; object-fit: contain; }
  .company { font-size: 0.92em; text-transform: uppercase; }
  .store { font-weight: 700; font-size: 1.15em; }
  h1 { font-size: ${size.thermal ? "1.25em" : "1.6em"}; text-align: center; margin: 8px 0 2px; letter-spacing: 0.02em; }
  .doc-code { text-align: center; margin-bottom: 6px; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .name { overflow-wrap: anywhere; word-break: break-word; }
  .kv { display: grid; grid-template-columns: ${size.thermal ? "21mm" : "32mm"} 1fr; gap: 4px; }
  .kv > span:last-child { overflow-wrap: anywhere; }
  .grand { font-weight: 700; font-size: ${paper === "K58" ? "1.05em" : "1.15em"}; margin: 3px 0; }
  .items-head { font-weight: 700; padding-bottom: 3px; border-bottom: 1px dashed #000; margin-bottom: 2px; }
  .item { padding: 3px 0; break-inside: avoid; page-break-inside: avoid; }
  .item .name { font-weight: 600; }
  .item .sub { font-size: 0.92em; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th, table.items td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
  table.items th { background: #f2f2f2; font-weight: 700; }
  table.items th.num, table.items td.num { text-align: right; }
  table.items .stt { width: 8mm; text-align: center; }
  table.items .center { text-align: center; }
  table.items thead { display: table-header-group; }
  table.items tr { break-inside: avoid; page-break-inside: avoid; }
  .totals { ${size.thermal ? "" : "width: 60%; margin-left: auto;"} }
  .footer { text-align: center; margin-top: 6px; font-style: italic; white-space: pre-line; overflow-wrap: anywhere; }
  .note { text-align: center; font-size: 0.8em; margin-top: 6px; }
  @media screen { body { padding: ${size.thermal ? "3mm" : "10mm"}; } }
  @media print { .no-print { display: none !important; } }`;
}

export function htmlDocument(title: string, css: string, body: string, autoPrint: boolean): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${css}
</style>
</head>
<body${autoPrint ? ' onload="window.print()"' : ""}>
${body}
</body>
</html>`;
}
