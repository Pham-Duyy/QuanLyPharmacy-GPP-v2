import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { REPORT_KINDS } from "./quality-reports.service.js";
import * as service from "./quality-reports.service.js";

/** Sổ khiếu nại và phản ứng có hại (contract §17.1). */
export const qualityReportsRouter = Router();
qualityReportsRouter.use("/quality-reports", authenticate, storeContext, requireStore);

/** Xem: người ghi sổ, hoặc kiểm toán (audit.read). */
const canRead: RequestHandler = (req, _res, next) => {
  const auth = req.auth!;
  if (!auth.can("quality_report.manage") && !auth.can("audit.read")) {
    throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem sổ khiếu nại");
  }
  next();
};

const day = z.coerce.date("Ngày không hợp lệ");
const text = (max: number) => z.string().trim().max(max);

const createSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  occurredOn: day,
  productId: z.uuid().nullish(),
  batchId: z.uuid().nullish(),
  reporterName: text(150).nullish(),
  reporterPhone: text(20)
    .regex(/^[0-9 +.-]*$/, "Số điện thoại không hợp lệ")
    .nullish(),
  description: text(2000).min(5, "Mô tả rõ sự việc (ít nhất 5 ký tự)"),
  actionTaken: text(2000).nullish(),
});

const updateSchema = z.object({
  version: z.coerce.number().int().positive(),
  actionTaken: text(2000).nullish(),
  adrReportedOn: day.nullish(),
});

qualityReportsRouter.get("/quality-reports", canRead, async (req, res) => {
  const query = parseOrThrow(
    z.object({
      status: z.enum(["OPEN", "CLOSED"]).optional(),
      kind: z.enum(REPORT_KINDS).optional(),
    }),
    req.query,
  );
  sendData(res, await service.list(req.auth!.storeId!, query));
});

qualityReportsRouter.get("/quality-reports/:id", canRead, async (req, res) => {
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
});

qualityReportsRouter.post(
  "/quality-reports",
  requirePermission("quality_report.manage"),
  async (req, res) => {
    const input = parseOrThrow(createSchema, req.body);
    const id = await service.create(req.auth!.storeId!, req.auth!, input);
    sendData(res, await service.getDetail(req.auth!.storeId!, id), 201);
  },
);

qualityReportsRouter.patch(
  "/quality-reports/:id",
  requirePermission("quality_report.manage"),
  async (req, res) => {
    const input = parseOrThrow(updateSchema, req.body);
    await service.update(req.auth!.storeId!, String(req.params.id), req.auth!, input);
    sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
  },
);

qualityReportsRouter.post(
  "/quality-reports/:id/close",
  requirePermission("quality_report.manage"),
  async (req, res) => {
    const input = parseOrThrow(z.object({ actionTaken: text(2000).nullish() }), req.body);
    await service.close(
      req.auth!.storeId!,
      String(req.params.id),
      req.auth!,
      input.actionTaken || null,
    );
    sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
  },
);
