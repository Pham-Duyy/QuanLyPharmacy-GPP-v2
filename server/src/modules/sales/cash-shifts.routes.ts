import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { getEffectiveTemplate } from "../settings/print-template.service.js";
import { renderCashShiftHtml } from "./cash-shift-print.js";
import * as service from "./cash-shifts.service.js";

/** Ca thu ngân, chốt két (contract §14.5). */
export const cashShiftsRouter = Router();
cashShiftsRouter.use("/cash-shifts", authenticate, storeContext, requireStore);

/** Xem lịch sử ca: người đứng quầy, hoặc người xem báo cáo doanh thu. */
const canRead: RequestHandler = (req, _res, next) => {
  const auth = req.auth!;
  if (!auth.can("cash_shift.manage") && !auth.can("report.sales")) {
    throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem ca thu ngân");
  }
  next();
};

const money = (label: string) =>
  z.coerce.number().int(`${label} phải là số nguyên`).min(0, `${label} không được âm`).max(1e12);

cashShiftsRouter.get(
  "/cash-shifts/current",
  requirePermission("cash_shift.manage"),
  async (req, res) => {
    sendData(res, await service.current(req.auth!.storeId!));
  },
);

cashShiftsRouter.get("/cash-shifts", canRead, async (req, res) => {
  const query = parseOrThrow(
    z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
    req.query,
  );
  sendData(res, await service.list(req.auth!.storeId!, query));
});

cashShiftsRouter.get("/cash-shifts/:id", canRead, async (req, res) => {
  sendData(res, await service.detail(req.auth!.storeId!, String(req.params.id)));
});

cashShiftsRouter.get("/cash-shifts/:id/print", canRead, async (req, res) => {
  const storeId = req.auth!.storeId!;
  const [shift, effective] = await Promise.all([
    service.detail(storeId, String(req.params.id)),
    getEffectiveTemplate(storeId),
  ]);
  res
    .set("X-Paper-Size", effective.template.paperSize === "K58" ? "K58" : "K80")
    .type("html")
    .send(
      renderCashShiftHtml(shift, effective.template, { autoPrint: req.query["autoprint"] !== "0" }),
    );
});

cashShiftsRouter.post(
  "/cash-shifts",
  requirePermission("cash_shift.manage"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(z.object({ openingCash: money("Tiền đầu ca") }), req.body);
    sendData(res, await service.open(req.auth!.storeId!, req.auth!, input.openingCash), 201);
  },
);

cashShiftsRouter.post(
  "/cash-shifts/:id/movements",
  requirePermission("cash_shift.manage"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(
      z.object({
        direction: z.enum(["IN", "OUT"]),
        amount: money("Số tiền").min(1, "Số tiền phải lớn hơn 0"),
        reason: z.string().trim().min(1, "Ghi lý do thu chi").max(300),
      }),
      req.body,
    );
    sendData(
      res,
      await service.addMovement(req.auth!.storeId!, String(req.params.id), req.auth!, input),
    );
  },
);

cashShiftsRouter.post(
  "/cash-shifts/:id/close",
  requirePermission("cash_shift.manage"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(
      z.object({
        countedCash: money("Tiền đếm thực tế"),
        note: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    sendData(res, await service.close(req.auth!.storeId!, String(req.params.id), req.auth!, input));
  },
);
