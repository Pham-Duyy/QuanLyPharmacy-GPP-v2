import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import * as service from "./supplier-debts.service.js";

export const supplierDebtsRouter = Router();
supplierDebtsRouter.use(["/supplier-debts", "/supplier-payments"], authenticate, storeContext, requireStore);

const debtQuerySchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ").optional(),
  onlyOutstanding: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  dueSoonDays: z.coerce.number().int().min(1).max(90).default(7),
});

const paymentSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ"),
  paidAt: z.coerce.date().default(() => new Date()),
  method: z.enum(["CASH", "BANK_TRANSFER"]).default("BANK_TRANSFER"),
  reference: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
  allocations: z
    .array(
      z.object({
        goodsReceiptId: z.uuid("goodsReceiptId không hợp lệ"),
        amount: z.coerce.number().int().positive("Số tiền phải lớn hơn 0"),
      }),
    )
    .min(1, "Phải chọn ít nhất một phiếu nhập để trả tiền"),
});

const listPaymentsSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ").optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** GET /api/v1/supplier-debts: công nợ theo từng nhà cung cấp, kèm phiếu còn nợ. */
supplierDebtsRouter.get("/supplier-debts", requirePermission("supplier_debt.read"), async (req, res) => {
  const query = parseOrThrow(debtQuerySchema, req.query);
  sendData(res, await service.listDebts(req.auth!.storeId!, query));
});

/** PUT /api/v1/supplier-debts/{supplierId}/term: đổi kỳ hạn thanh toán. */
supplierDebtsRouter.put("/supplier-debts/:supplierId/term", requirePermission("supplier_payment.manage"), async (req, res) => {
  const input = parseOrThrow(z.object({ paymentTermDays: z.coerce.number().int().min(0).max(365) }), req.body);
  await service.setPaymentTerm(String(req.params.supplierId), input.paymentTermDays, req.auth!, req.auth!.storeId!);
  sendData(res, { ok: true });
});

/** GET /api/v1/supplier-payments: lịch sử trả tiền nhà cung cấp. */
supplierDebtsRouter.get("/supplier-payments", requirePermission("supplier_debt.read"), async (req, res) => {
  const query = parseOrThrow(listPaymentsSchema, req.query);
  sendData(res, await service.listPayments(req.auth!.storeId!, query));
});

/** POST /api/v1/supplier-payments: ghi nhận một lần trả tiền, phân bổ về từng phiếu nhập. */
supplierDebtsRouter.post("/supplier-payments", requirePermission("supplier_payment.manage"), async (req, res) => {
  const input = parseOrThrow(paymentSchema, req.body);
  const id = await service.createPayment(req.auth!.storeId!, req.auth!, {
    supplierId: input.supplierId,
    paidAt: input.paidAt,
    method: input.method,
    reference: input.reference ?? null,
    note: input.note ?? null,
    allocations: input.allocations,
  });
  sendData(res, { id }, 201);
});

/** POST /api/v1/supplier-payments/{id}/void: hủy phiếu chi ghi nhầm, bắt buộc có lý do. */
supplierDebtsRouter.post("/supplier-payments/:id/void", requirePermission("supplier_payment.manage"), async (req, res) => {
  const input = parseOrThrow(z.object({ reason: z.string().trim().min(1, "Phải ghi lý do hủy phiếu chi").max(500) }), req.body);
  await service.voidPayment(req.auth!.storeId!, String(req.params.id), req.auth!, input.reason);
  sendData(res, { ok: true });
});
