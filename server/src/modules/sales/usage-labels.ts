import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import {
  baseCss,
  escapeHtml,
  htmlDocument,
  num,
  printDate,
  printDateTime,
  type PrintPaper,
} from "../printing/print-common.js";
import type { PrintTemplate } from "../settings/print-template.schema.js";

/**
 * Nhãn cách dùng khi bán lẻ thuốc ngoài bao bì gốc (GPP, TT 02/2018 Phụ lục I
 * mục II.3d): tên thuốc, dạng bào chế, hàm lượng, liều dùng, số lần và cách
 * dùng. In trên máy in hóa đơn nhiệt sẵn có, mỗi dòng thuốc một nhãn, có
 * đường cắt giữa các nhãn. Chỉ in dòng đã ghi cách dùng.
 */

export type UsageLabel = {
  productName: string;
  dosageForm: string | null;
  strength: string | null;
  quantity: number;
  unitName: string;
  usage: string;
  expiryDate: Date | null;
};

export async function loadUsageLabels(storeId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, storeId },
    select: {
      code: true,
      soldAt: true,
      customer: { select: { fullName: true } },
      lines: {
        where: { usageInstruction: { not: null } },
        orderBy: { lineNo: "asc" },
        select: {
          productName: true,
          quantity: true,
          unitName: true,
          usageInstruction: true,
          product: { select: { dosageForm: true, strengthText: true } },
          allocations: { select: { batch: { select: { expiryDate: true } } } },
        },
      },
    },
  });
  if (!invoice) throw AppError.notFound("Không tìm thấy hóa đơn");

  const labels: UsageLabel[] = invoice.lines.map((line) => {
    // Nhiều lô thì in hạn dùng sớm nhất: an toàn cho người dùng thuốc.
    const expiries = line.allocations.map((allocation) => allocation.batch.expiryDate.getTime());
    return {
      productName: line.productName,
      dosageForm: line.product.dosageForm,
      strength: line.product.strengthText,
      quantity: line.quantity,
      unitName: line.unitName,
      usage: line.usageInstruction!,
      expiryDate: expiries.length > 0 ? new Date(Math.min(...expiries)) : null,
    };
  });
  return {
    code: invoice.code,
    soldAt: invoice.soldAt,
    customerName: invoice.customer?.fullName ?? null,
    labels,
  };
}

const LABEL_CSS = `
  .label { border: 1px solid #000; border-radius: 2mm; padding: 2.5mm; break-inside: avoid; page-break-inside: avoid; }
  .label + .cut { border-top: 1px dashed #000; margin: 3mm 0; position: relative; }
  .label .shop { font-size: 0.85em; text-align: center; border-bottom: 1px solid #000; padding-bottom: 1.5mm; margin-bottom: 1.5mm; }
  .label .drug { font-weight: 700; font-size: 1.1em; overflow-wrap: anywhere; }
  .label .meta { font-size: 0.92em; }
  .label .usage { font-size: 1.15em; font-weight: 700; margin: 2mm 0; white-space: pre-line; overflow-wrap: anywhere; }
  .label .foot { display: flex; justify-content: space-between; gap: 4px; font-size: 0.85em; }
  .empty { text-align: center; padding: 6mm 0; }`;

export function renderUsageLabelsHtml(
  data: Awaited<ReturnType<typeof loadUsageLabels>>,
  template: PrintTemplate,
  options: { autoPrint: boolean },
): string {
  // Nhãn luôn in trên máy in nhiệt; mẫu hóa đơn khổ A4/A5 thì dùng K80.
  const paper: PrintPaper = template.paperSize === "K58" ? "K58" : "K80";
  const dot = (parts: Array<string | null>) =>
    parts.filter((part): part is string => Boolean(part)).join(" · ");
  const shop = dot([
    escapeHtml(template.storeName),
    template.phone ? `ĐT ${escapeHtml(template.phone)}` : null,
  ]);
  const body =
    data.labels.length === 0
      ? `<p class="empty">Hóa đơn ${escapeHtml(data.code)} không có dòng nào ghi cách dùng.</p>`
      : data.labels
          .map((label) => {
            const meta = dot([
              label.dosageForm ? escapeHtml(label.dosageForm) : null,
              label.strength ? escapeHtml(label.strength) : null,
            ]);
            return `<section class="label">
  <div class="shop">${shop}</div>
  <div class="drug">${escapeHtml(label.productName)}</div>
  ${meta ? `<div class="meta">${meta}</div>` : ""}
  <div class="meta">Số lượng: ${num(label.quantity)} ${escapeHtml(label.unitName)}</div>
  <div class="usage">${escapeHtml(label.usage)}</div>
  <div class="foot"><span>${label.expiryDate ? `HSD: ${printDate(label.expiryDate)}` : ""}</span><span>${printDateTime(data.soldAt)}</span></div>
  ${data.customerName ? `<div class="foot"><span>Người dùng: ${escapeHtml(data.customerName)}</span><span></span></div>` : ""}
</section>`;
          })
          .join('\n<div class="cut"></div>\n');
  return htmlDocument(
    `Nhãn cách dùng ${data.code}`,
    baseCss(paper) + LABEL_CSS,
    body,
    options.autoPrint,
  );
}
