import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import { getCurrentPrices } from "./products.service.js";

export const pricesRouter = Router();
pricesRouter.use(authenticate, storeContext);

const createSchema = z.object({
  unitId: z.uuid("unitId không hợp lệ"),
  salePrice: z.coerce.number().int().min(0, "Giá bán không được âm"),
  vatRatePercent: z.coerce.number().min(0).max(100),
  effectiveFrom: z.coerce.date().optional(),
  /** CHAIN là giá chung toàn chuỗi, STORE là giá riêng của cửa hàng đang chọn. */
  scope: z.enum(["CHAIN", "STORE"]).default("CHAIN"),
});

pricesRouter.get("/products/:id/prices", requirePermission("catalog.read"), async (req, res) => {
  const productId = String(req.params.id);
  const query = req.query as Record<string, string | undefined>;

  const units = await prisma.productUnit.findMany({
    where: { productId, ...(query["unitId"] ? { id: query["unitId"] } : {}) },
    select: { id: true, name: true, conversionToBase: true },
  });
  if (units.length === 0) throw AppError.notFound("Không tìm thấy đơn vị tính của sản phẩm này");

  const unitIds = units.map((unit) => unit.id);
  const at = query["at"] ? new Date(query["at"]) : new Date();

  const [history, current] = await Promise.all([
    prisma.productPrice.findMany({
      where: { productUnitId: { in: unitIds } },
      orderBy: [{ productUnitId: "asc" }, { effectiveFrom: "desc" }],
      take: 200,
    }),
    getCurrentPrices(unitIds, req.auth?.storeId ?? null, at),
  ]);

  sendData(res, {
    at: at.toISOString(),
    units: units.map((unit) => ({
      ...unit,
      currentPrice: current.get(unit.id) ?? null,
      history: history
        .filter((price) => price.productUnitId === unit.id)
        .map((price) => ({
          id: price.id,
          salePrice: price.salePrice,
          vatRatePercent: price.vatRatePercent.toString(),
          effectiveFrom: price.effectiveFrom,
          scope: price.storeId ? "STORE" : "CHAIN",
        })),
    })),
  });
});

/**
 * Đổi giá là tạo một phiên bản giá mới, không sửa bản cũ (contract §6.5).
 * Nhờ vậy hóa đơn cũ vẫn tra được giá tại thời điểm bán.
 */
pricesRouter.post("/products/:id/prices", requirePermission("price.manage"), async (req, res) => {
  const productId = String(req.params.id);
  const input = parseOrThrow(createSchema, req.body);

  const unit = await prisma.productUnit.findFirst({ where: { id: input.unitId, productId } });
  if (!unit) throw AppError.notFound("Đơn vị tính không thuộc sản phẩm này");

  let storeId: string | null = null;
  if (input.scope === "STORE") {
    if (!req.auth?.storeId) {
      throw new AppError(
        400,
        "STORE_REQUIRED",
        "Đặt giá riêng cho cửa hàng cần header X-Store-Id",
      );
    }
    storeId = req.auth.storeId;
  }

  const created = await withMappedErrors(
    () =>
      prisma.productPrice.create({
        data: {
          productUnitId: input.unitId,
          storeId,
          salePrice: BigInt(input.salePrice),
          vatRatePercent: input.vatRatePercent,
          effectiveFrom: input.effectiveFrom ?? new Date(),
          createdBy: req.auth?.userId ?? null,
        },
      }),
    { conflictMessage: "Đã có bản giá cho đơn vị này tại đúng thời điểm đó" },
  );

  sendData(
    res,
    {
      id: created.id,
      productUnitId: created.productUnitId,
      salePrice: created.salePrice,
      vatRatePercent: created.vatRatePercent.toString(),
      effectiveFrom: created.effectiveFrom,
      scope: created.storeId ? "STORE" : "CHAIN",
    },
    201,
  );
});
