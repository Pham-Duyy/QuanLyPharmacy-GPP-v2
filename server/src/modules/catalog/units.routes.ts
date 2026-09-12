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

export const unitsRouter = Router();
unitsRouter.use(authenticate, storeContext);

const createSchema = z.object({
  name: z.string().trim().min(1, "Thiếu tên đơn vị").max(50),
  conversionToBase: z.coerce.number().int().min(1, "Hệ số quy đổi phải từ 1 trở lên"),
  isSellable: z.boolean().default(true),
  isDefaultSaleUnit: z.boolean().default(false),
  barcodes: z.array(z.string().trim().min(6).max(50)).default([]),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  isSellable: z.boolean().optional(),
  isDefaultSaleUnit: z.boolean().optional(),
  barcodes: z.array(z.string().trim().min(6).max(50)).optional(),
});

async function ensureProduct(productId: string): Promise<void> {
  const exists = await prisma.product.count({ where: { id: productId } });
  if (exists === 0) throw AppError.notFound("Không tìm thấy sản phẩm");
}

unitsRouter.get("/products/:id/units", requirePermission("catalog.read"), async (req, res) => {
  const productId = String(req.params.id);
  await ensureProduct(productId);

  const units = await prisma.productUnit.findMany({
    where: { productId },
    include: { barcodes: true },
    orderBy: { conversionToBase: "asc" },
  });
  const prices = await getCurrentPrices(
    units.map((unit) => unit.id),
    req.auth?.storeId ?? null,
  );

  sendData(res, {
    items: units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      conversionToBase: unit.conversionToBase,
      isSellable: unit.isSellable,
      isDefaultSaleUnit: unit.isDefaultSaleUnit,
      isActive: unit.isActive,
      barcodes: unit.barcodes.map((item) => item.barcode),
      currentPrice: prices.get(unit.id) ?? null,
    })),
  });
});

unitsRouter.post("/products/:id/units", requirePermission("catalog.manage"), async (req, res) => {
  const productId = String(req.params.id);
  await ensureProduct(productId);
  const input = parseOrThrow(createSchema, req.body);

  const unit = await withMappedErrors(
    () =>
      prisma.$transaction(async (tx) => {
        // Chỉ mục duy nhất từng phần chỉ cho một đơn vị mặc định mỗi sản phẩm,
        // nên phải bỏ cờ ở đơn vị cũ trước khi đặt cờ mới.
        if (input.isDefaultSaleUnit) {
          await tx.productUnit.updateMany({
            where: { productId, isDefaultSaleUnit: true },
            data: { isDefaultSaleUnit: false },
          });
        }

        const created = await tx.productUnit.create({
          data: {
            productId,
            name: input.name,
            conversionToBase: input.conversionToBase,
            isSellable: input.isSellable,
            isDefaultSaleUnit: input.isDefaultSaleUnit,
          },
        });

        if (input.barcodes.length > 0) {
          await tx.productBarcode.createMany({
            data: input.barcodes.map((barcode) => ({ productUnitId: created.id, barcode })),
          });
        }

        return created;
      }),
    { conflictMessage: "Đơn vị hoặc mã vạch đã tồn tại" },
  );

  sendData(res, unit, 201);
});

unitsRouter.patch(
  "/products/:id/units/:unitId",
  requirePermission("catalog.manage"),
  async (req, res) => {
    const productId = String(req.params.id);
    const unitId = String(req.params.unitId);
    const input = parseOrThrow(patchSchema, req.body);

    const unit = await prisma.productUnit.findFirst({ where: { id: unitId, productId } });
    if (!unit) throw AppError.notFound("Không tìm thấy đơn vị tính của sản phẩm này");

    // Hệ số quy đổi không sửa được sau khi đã tạo: mọi số lượng đã ghi theo
    // đơn vị nhỏ nhất sẽ sai nếu đổi. Muốn khác thì tạo đơn vị mới (contract §6.3).
    await withMappedErrors(
      () =>
        prisma.$transaction(async (tx) => {
          if (input.isDefaultSaleUnit) {
            await tx.productUnit.updateMany({
              where: { productId, isDefaultSaleUnit: true },
              data: { isDefaultSaleUnit: false },
            });
          }

          await tx.productUnit.update({
            where: { id: unitId },
            data: {
              ...(input.name ? { name: input.name } : {}),
              ...(input.isSellable !== undefined ? { isSellable: input.isSellable } : {}),
              ...(input.isDefaultSaleUnit !== undefined
                ? { isDefaultSaleUnit: input.isDefaultSaleUnit }
                : {}),
            },
          });

          if (input.barcodes) {
            await tx.productBarcode.deleteMany({ where: { productUnitId: unitId } });
            if (input.barcodes.length > 0) {
              await tx.productBarcode.createMany({
                data: input.barcodes.map((barcode) => ({ productUnitId: unitId, barcode })),
              });
            }
          }
        }),
      { conflictMessage: "Tên đơn vị hoặc mã vạch đã được dùng" },
    );

    sendData(
      res,
      await prisma.productUnit.findUnique({ where: { id: unitId }, include: { barcodes: true } }),
    );
  },
);

/** Quét mã vạch ở quầy: trả về đúng sản phẩm và đơn vị của mã đó (contract §6.3). */
unitsRouter.get(
  "/product-units/by-barcode/:barcode",
  requirePermission("catalog.read"),
  async (req, res) => {
    const barcode = String(req.params.barcode);
    const found = await prisma.productBarcode.findUnique({
      where: { barcode },
      include: { productUnit: { include: { product: true } } },
    });
    if (!found) throw AppError.notFound("Không tìm thấy mã vạch này");

    const prices = await getCurrentPrices([found.productUnitId], req.auth?.storeId ?? null);

    sendData(res, {
      barcode,
      product: {
        id: found.productUnit.product.id,
        code: found.productUnit.product.code,
        name: found.productUnit.product.name,
        drugClass: found.productUnit.product.drugClass,
        isActive: found.productUnit.product.isActive,
      },
      unit: {
        id: found.productUnit.id,
        name: found.productUnit.name,
        conversionToBase: found.productUnit.conversionToBase,
        isSellable: found.productUnit.isSellable,
      },
      currentPrice: prices.get(found.productUnitId) ?? null,
    });
  },
);
