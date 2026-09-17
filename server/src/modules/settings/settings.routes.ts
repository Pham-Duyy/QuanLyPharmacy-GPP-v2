import { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { renderInvoicePrintHtml, sampleInvoice } from "../sales/invoice-print.js";
import { renderDocumentHtml } from "../printing/document-print.js";
import { sampleDocument } from "../printing/documents.js";
import { documentPreviewSchema, documentPrintSettingsSchema } from "./document-print.schema.js";
import * as documentSettings from "./document-print.service.js";
import { previewSchema, printTemplateSchema } from "./print-template.schema.js";
import * as service from "./print-template.service.js";

export const settingsRouter = Router();

// Cài đặt mẫu in gắn với từng cửa hàng (chi nhánh), nên bắt buộc X-Store-Id.
settingsRouter.use("/settings", authenticate, storeContext, requireStore);

/**
 * GET /api/v1/settings/invoice-print-template: mẫu in đang áp dụng.
 * Nhân viên bán hàng cũng cần đọc (để biết khổ giấy khi in), nên nhận cả
 * `invoice.read`; chỉ quyền `settings.manage` mới được sửa.
 */
settingsRouter.get("/settings/invoice-print-template", async (req, res) => {
  const auth = req.auth!;
  if (!auth.can("settings.manage") && !auth.can("invoice.read")) {
    throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem mẫu in hóa đơn");
  }
  sendData(res, await service.getEffectiveTemplate(auth.storeId!));
});

/** PUT /api/v1/settings/invoice-print-template: lưu mẫu in cho cửa hàng hiện tại. */
settingsRouter.put(
  "/settings/invoice-print-template",
  requirePermission("settings.manage"),
  async (req, res) => {
    const input = parseOrThrow(printTemplateSchema, req.body);
    const auth = req.auth!;
    sendData(
      res,
      await service.saveTemplate(
        auth.storeId!,
        auth.userId,
        input,
        (res.locals.requestId as string | undefined) ?? null,
      ),
    );
  },
);

/**
 * POST /api/v1/settings/invoice-print-template/preview: dựng HTML từ mẫu
 * đang sửa (chưa lưu) với dữ liệu mẫu. Dùng đúng hàm render của in thật,
 * không tạo hóa đơn nào.
 */
settingsRouter.post(
  "/settings/invoice-print-template/preview",
  requirePermission("settings.manage"),
  async (req, res) => {
    const input = parseOrThrow(previewSchema, req.body);
    const template = { ...input.template, logo: service.sanitizeLogo(input.template.logo) };
    res.type("html").send(renderInvoicePrintHtml(sampleInvoice(input.sample), template));
  },
);

/** GET /api/v1/settings/document-print: cài đặt in phiếu nhập, phiếu trả, phiếu điều chỉnh. */
settingsRouter.get(
  "/settings/document-print",
  requirePermission("settings.manage"),
  async (req, res) => {
    sendData(res, await documentSettings.getDocumentSettings(req.auth!.storeId!));
  },
);

settingsRouter.put(
  "/settings/document-print",
  requirePermission("settings.manage"),
  async (req, res) => {
    const input = parseOrThrow(documentPrintSettingsSchema, req.body);
    const auth = req.auth!;
    sendData(
      res,
      await documentSettings.saveDocumentSettings(
        auth.storeId!,
        auth.userId,
        input,
        (res.locals.requestId as string | undefined) ?? null,
      ),
    );
  },
);

/**
 * POST /api/v1/settings/document-print/preview: dựng phiếu mẫu từ cài đặt
 * chưa lưu, dùng phần đầu (logo, tên đơn vị) của mẫu in hóa đơn đã lưu.
 */
settingsRouter.post(
  "/settings/document-print/preview",
  requirePermission("settings.manage"),
  async (req, res) => {
    const input = parseOrThrow(documentPreviewSchema, req.body);
    const header = await service.getEffectiveTemplate(req.auth!.storeId!);
    const config = input.settings[input.type];
    res
      .set("X-Paper-Size", config.paperSize)
      .type("html")
      .send(renderDocumentHtml(sampleDocument(input.type), header.template, config));
  },
);
