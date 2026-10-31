import { Router, type Request } from "express";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { isMailConfigured, mailFrom, sendMail } from "../../lib/mailer.js";
import { pageResult, parsePageQuery } from "../../lib/pagination.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { buildWorkbook } from "../excel/workbook.js";
import { renderDocumentHtml } from "../printing/document-print.js";
import { loadPurchaseOrderDocument, purchaseOrderDocument } from "../printing/documents.js";
import { escapeHtml } from "../printing/print-common.js";
import { sendDocumentPrint } from "../printing/send-print.js";
import { getDocumentSettings } from "../settings/document-print.service.js";
import { getEffectiveTemplate } from "../settings/print-template.service.js";
import {
  cancelPurchaseOrderSchema,
  createPurchaseOrderSchema,
  fromSuggestionsSchema,
  patchPurchaseOrderSchema,
  sendPurchaseOrderSchema,
} from "./purchase-orders.schema.js";
import * as service from "./purchase-orders.service.js";

/**
 * Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32). Quyền dùng lại của phiếu
 * nhập: lập, sửa nháp như lập phiếu nhập (`goods_receipt.create`); gửi đi và
 * hủy là cam kết mua nên cần quyền xác nhận phiếu nhập (`goods_receipt.confirm`).
 */
export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.use("/purchase-orders", authenticate, storeContext, requireStore);

async function audit(req: Request, action: string, id: string, after?: object) {
  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      storeId: req.auth!.storeId,
      action,
      resourceType: "purchase_order",
      resourceId: id,
      ...(after ? { after } : {}),
    },
  });
}

/** Tệp Excel của một đơn: gửi kèm email, hoặc tải về để gửi Zalo. */
async function orderWorkbook(order: service.PurchaseOrderDetail): Promise<Buffer> {
  return buildWorkbook([
    {
      name: "Đơn đặt hàng",
      columns: [
        { key: "lineNo", header: "STT", kind: "int", width: 6 },
        { key: "code", header: "Mã hàng", width: 12 },
        { key: "name", header: "Tên hàng", width: 44 },
        { key: "unit", header: "Đơn vị", width: 10 },
        { key: "quantity", header: "Số lượng", kind: "int", width: 10 },
        { key: "unitPrice", header: "Đơn giá dự kiến", kind: "money", width: 16 },
        { key: "amount", header: "Thành tiền", kind: "money", width: 16 },
      ],
      rows: order.lines.map((line) => ({
        lineNo: line.lineNo,
        code: line.productCode,
        name: line.productName,
        unit: line.unitName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.lineAmount,
      })),
    },
  ]);
}

const fileName = (code: string) => `don-dat-hang-${code}.xlsx`;

purchaseOrdersRouter.get(
  "/purchase-orders",
  requirePermission("goods_receipt.read"),
  async (req, res) => {
    const page = parsePageQuery(req.query, { sortable: ["createdAt"], defaultSort: "createdAt" });
    const query = req.query as Record<string, string | undefined>;
    const result = await service.list(req.auth!.storeId!, {
      status: query["status"],
      supplierId: query["supplierId"],
      search: query["search"]?.trim() || undefined,
      skip: page.skip,
      take: page.limit,
    });
    sendData(res, {
      ...pageResult(result.items, result.total, page),
      mailEnabled: isMailConfigured(),
    });
  },
);

purchaseOrdersRouter.get(
  "/purchase-orders/:id",
  requirePermission("goods_receipt.read"),
  async (req, res) => {
    const detail = await service.getDetail(req.auth!.storeId!, String(req.params.id));
    sendData(res, { ...detail, mailEnabled: isMailConfigured(), mailFrom: mailFrom() });
  },
);

purchaseOrdersRouter.post(
  "/purchase-orders",
  requirePermission("goods_receipt.create"),
  async (req, res) => {
    const input = parseOrThrow(createPurchaseOrderSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = await withMappedErrors(() => service.create(storeId, req.auth!.userId, input));
    await audit(req, "PURCHASE_ORDER_CREATE", id);
    sendData(res, await service.getDetail(storeId, id), 201);
  },
);

purchaseOrdersRouter.post(
  "/purchase-orders/from-suggestions",
  requirePermission("goods_receipt.create"),
  async (req, res) => {
    const input = parseOrThrow(fromSuggestionsSchema, req.body);
    const storeId = req.auth!.storeId!;
    const ids = await withMappedErrors(() =>
      service.createFromSuggestions(storeId, req.auth!.userId, input.items),
    );
    for (const id of ids) await audit(req, "PURCHASE_ORDER_CREATE", id);
    sendData(res, { ids }, 201);
  },
);

purchaseOrdersRouter.patch(
  "/purchase-orders/:id",
  requirePermission("goods_receipt.create"),
  async (req, res) => {
    const input = parseOrThrow(patchPurchaseOrderSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await withMappedErrors(() => service.update(storeId, id, input));
    sendData(res, await service.getDetail(storeId, id));
  },
);

/**
 * Gửi đơn. EMAIL: gửi thư kèm tệp Excel, gửi được mới chuyển sang Đã gửi
 * (gửi lại cho đơn đã gửi thì giữ trạng thái). MANUAL: đã tự gửi bằng cách
 * khác, chỉ ghi nhận.
 */
purchaseOrdersRouter.post(
  "/purchase-orders/:id/send",
  requirePermission("goods_receipt.confirm"),
  async (req, res) => {
    const input = parseOrThrow(sendPurchaseOrderSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    const order = await service.getDetail(storeId, id);
    if (order.status === "CANCELLED") throw AppError.invalidState("Đơn đã hủy, không gửi được");

    if (input.channel === "EMAIL") {
      const [header, documents] = await Promise.all([
        getEffectiveTemplate(storeId),
        getDocumentSettings(storeId),
      ]);
      const html = renderDocumentHtml(
        purchaseOrderDocument(order),
        header.template,
        documents.settings.purchaseOrder,
        { autoPrint: false },
      );
      const intro = input.message?.trim()
        ? `<p style="white-space:pre-line">${escapeHtml(input.message.trim())}</p><hr/>`
        : "";
      await sendMail({
        to: input.to,
        subject: `Đơn đặt hàng ${order.code} – ${order.store.name}`,
        html: html.replace("<body>", `<body>${intro}`),
        text: [
          input.message?.trim() ?? "",
          `Đơn đặt hàng ${order.code} của ${order.store.name}.`,
          ...order.lines.map((line) => `- ${line.productName}: ${line.quantity} ${line.unitName}`),
          "Chi tiết trong tệp Excel đính kèm.",
        ]
          .filter(Boolean)
          .join("\n"),
        attachments: [
          {
            filename: fileName(order.code),
            content: await orderWorkbook(order),
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        ],
      });
    }

    await service.markSent(
      storeId,
      id,
      req.auth!.userId,
      input.channel,
      input.channel === "EMAIL" ? input.to : null,
    );
    await audit(req, "PURCHASE_ORDER_SEND", id, {
      channel: input.channel,
      ...(input.channel === "EMAIL" ? { to: input.to } : {}),
    });
    sendData(res, await service.getDetail(storeId, id));
  },
);

purchaseOrdersRouter.post(
  "/purchase-orders/:id/cancel",
  requirePermission("goods_receipt.confirm"),
  async (req, res) => {
    const input = parseOrThrow(cancelPurchaseOrderSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await service.cancel(storeId, id, req.auth!.userId, input.reason);
    await audit(req, "PURCHASE_ORDER_CANCEL", id, { reason: input.reason });
    sendData(res, await service.getDetail(storeId, id));
  },
);

purchaseOrdersRouter.get(
  "/purchase-orders/:id/print",
  requirePermission("goods_receipt.read"),
  async (req, res) => {
    await sendDocumentPrint(req, res, "purchaseOrder", loadPurchaseOrderDocument);
  },
);

purchaseOrdersRouter.get(
  "/purchase-orders/:id/excel",
  requirePermission("goods_receipt.read"),
  async (req, res) => {
    const order = await service.getDetail(req.auth!.storeId!, String(req.params.id));
    const name = fileName(order.code);
    res
      .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", `attachment; filename="${name}"`)
      .send(await orderWorkbook(order));
  },
);
