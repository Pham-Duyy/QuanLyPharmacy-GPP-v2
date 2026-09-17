import type { Request, Response } from "express";
import type { DocumentType } from "../settings/document-print.schema.js";
import { getDocumentSettings } from "../settings/document-print.service.js";
import { getEffectiveTemplate } from "../settings/print-template.service.js";
import { renderDocumentHtml, type PrintDocument } from "./document-print.js";

/**
 * Trả trang in của một chứng từ theo mẫu của cửa hàng hiện tại. Header
 * `X-Paper-Size` cho giao diện biết khổ giấy để hiển thị bản xem trước.
 * Chỉ đọc dữ liệu: in bao nhiêu lần cũng không đổi chứng từ hay tồn kho.
 */
export async function sendDocumentPrint(
  req: Request,
  res: Response,
  type: DocumentType,
  load: (storeId: string, id: string) => Promise<PrintDocument>,
): Promise<void> {
  const storeId = req.auth!.storeId!;
  const [doc, header, documents] = await Promise.all([
    load(storeId, String(req.params["id"])),
    getEffectiveTemplate(storeId),
    getDocumentSettings(storeId),
  ]);
  const config = documents.settings[type];
  res
    .set("X-Paper-Size", config.paperSize)
    .type("html")
    .send(
      renderDocumentHtml(doc, header.template, config, {
        autoPrint: req.query["autoprint"] !== "0",
      }),
    );
}
