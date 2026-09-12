import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { pageResult, parsePageQuery } from "../../lib/pagination.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { updateWithVersion } from "../../lib/optimistic.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import { searchProductIds } from "./search.js";
import { getCurrentPrices, getStockSummary } from "./products.service.js";

export const productsRouter = Router();
productsRouter.use(authenticate, storeContext);

const PRODUCT_TYPES = ["DRUG", "SUPPLEMENT", "MEDICAL_DEVICE", "COSMETIC", "OTHER"] as const;
const DRUG_CLASSES = ["OTC", "RX", "CONTROLLED"] as const;

const createSchema = z
  .object({
    code: z.string().trim().min(1, "Thiếu mã sản phẩm").max(50),
    name: z.string().trim().min(1, "Thiếu tên sản phẩm").max(300),
    productType: z.enum(PRODUCT_TYPES),
    drugClass: z.enum(DRUG_CLASSES).nullish(),
    categoryId: z.uuid("categoryId không hợp lệ"),
    registrationNumber: z.string().trim().max(50).nullish(),
    dosageForm: z.string().trim().max(100).nullish(),
    strengthText: z.string().trim().max(100).nullish(),
    packagingText: z.string().trim().max(200).nullish(),
    manufacturer: z.string().trim().max(200).nullish(),
    countryOfOrigin: z.string().trim().max(100).nullish(),
    storageCondition: z.string().trim().max(200).nullish(),
    minStockBaseQuantity: z.coerce.number().int().min(0).default(0),
    baseUnitName: z.string().trim().min(1, "Thiếu tên đơn vị cơ bản").max(50),
    ingredients: z
      .array(
        z.object({ ingredientId: z.uuid(), strengthText: z.string().trim().max(100).nullish() }),
      )
      .default([]),
  })
  // Ràng buộc nghiệp vụ GPP, cũng được CSDL chặn lần nữa (ERD §9).
  .refine((value) => (value.productType === "DRUG") === Boolean(value.drugClass), {
    message: "Thuốc bắt buộc có phân loại kê đơn; hàng không phải thuốc thì không có",
    path: ["drugClass"],
  });

const patchSchema = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  categoryId: z.uuid().optional(),
  registrationNumber: z.string().trim().max(50).nullish(),
  dosageForm: z.string().trim().max(100).nullish(),
  strengthText: z.string().trim().max(100).nullish(),
  packagingText: z.string().trim().max(200).nullish(),
  manufacturer: z.string().trim().max(200).nullish(),
  countryOfOrigin: z.string().trim().max(100).nullish(),
  storageCondition: z.string().trim().max(200).nullish(),
  minStockBaseQuantity: z.coerce.number().int().min(0).optional(),
  version: z.coerce.number().int().positive(),
});

productsRouter.get("/products", requirePermission("catalog.read"), async (req, res) => {
  const page = parsePageQuery(req.query, {
    sortable: ["name", "code", "createdAt"],
    defaultSort: "name",
  });
  const query = req.query as Record<string, string | undefined>;
  const search = query["search"]?.trim() ?? "";
  const ids = search ? await searchProductIds(search, 500) : null;

  const where = {
    isActive: query["isActive"] !== "false",
    ...(ids ? { id: { in: ids } } : {}),
    ...(query["categoryId"] ? { categoryId: query["categoryId"] } : {}),
    ...(query["productType"] ? { productType: query["productType"] } : {}),
    ...(query["drugClass"] ? { drugClass: query["drugClass"] } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { [page.sortBy]: page.order },
      skip: page.skip,
      take: page.limit,
      include: { units: { where: { isActive: true } }, category: { select: { name: true } } },
    }),
    prisma.product.count({ where }),
  ]);

  const storeId = req.auth?.storeId ?? null;
  const unitIds = products.flatMap((product) => product.units.map((unit) => unit.id));
  const [prices, stock] = await Promise.all([
    getCurrentPrices(unitIds, storeId),
    storeId
      ? getStockSummary(
          products.map((p) => p.id),
          storeId,
        )
      : new Map(),
  ]);

  const items = products.map((product) => {
    const defaultUnit =
      product.units.find((unit) => unit.isDefaultSaleUnit) ??
      product.units.find((unit) => unit.conversionToBase === 1);
    const price = defaultUnit ? prices.get(defaultUnit.id) : undefined;

    return {
      id: product.id,
      code: product.code,
      name: product.name,
      productType: product.productType,
      drugClass: product.drugClass,
      categoryName: product.category.name,
      minStockBaseQuantity: product.minStockBaseQuantity,
      isActive: product.isActive,
      version: product.version,
      defaultUnit: defaultUnit
        ? {
            id: defaultUnit.id,
            name: defaultUnit.name,
            conversionToBase: defaultUnit.conversionToBase,
          }
        : null,
      currentPrice: price
        ? {
            salePrice: price.salePrice,
            vatRatePercent: price.vatRatePercent,
            isStoreOverride: price.isStoreOverride,
          }
        : null,
      stock: stock.get(product.id) ?? null,
    };
  });

  sendData(res, pageResult(items, total, page));
});

productsRouter.get("/products/:id", requirePermission("catalog.read"), async (req, res) => {
  const id = String(req.params.id);
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      ingredients: { include: { ingredient: { select: { id: true, name: true } } } },
      units: { include: { barcodes: true }, orderBy: { conversionToBase: "asc" } },
    },
  });
  if (!product) throw AppError.notFound("Không tìm thấy sản phẩm");

  const storeId = req.auth?.storeId ?? null;
  const [prices, stock] = await Promise.all([
    getCurrentPrices(
      product.units.map((unit) => unit.id),
      storeId,
    ),
    storeId ? getStockSummary([product.id], storeId) : new Map(),
  ]);

  sendData(res, {
    ...product,
    category: product.category,
    ingredients: product.ingredients.map((item) => ({
      ingredientId: item.ingredientId,
      name: item.ingredient.name,
      strengthText: item.strengthText,
    })),
    units: product.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      conversionToBase: unit.conversionToBase,
      isSellable: unit.isSellable,
      isDefaultSaleUnit: unit.isDefaultSaleUnit,
      isActive: unit.isActive,
      barcodes: unit.barcodes.map((barcode) => barcode.barcode),
      currentPrice: prices.get(unit.id) ?? null,
    })),
    stock: stock.get(product.id) ?? null,
  });
});

productsRouter.post("/products", requirePermission("catalog.manage"), async (req, res) => {
  const input = parseOrThrow(createSchema, req.body);

  // Sản phẩm và đơn vị cơ bản tạo cùng nhau: không có đơn vị cơ bản thì
  // không quy đổi được số lượng, nên không được phép tồn tại nửa vời.
  const created = await withMappedErrors(
    () =>
      prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            code: input.code,
            name: input.name,
            productType: input.productType,
            drugClass: input.drugClass ?? null,
            categoryId: input.categoryId,
            registrationNumber: input.registrationNumber ?? null,
            dosageForm: input.dosageForm ?? null,
            strengthText: input.strengthText ?? null,
            packagingText: input.packagingText ?? null,
            manufacturer: input.manufacturer ?? null,
            countryOfOrigin: input.countryOfOrigin ?? null,
            storageCondition: input.storageCondition ?? null,
            minStockBaseQuantity: input.minStockBaseQuantity,
          },
        });

        await tx.productUnit.create({
          data: {
            productId: product.id,
            name: input.baseUnitName,
            conversionToBase: 1,
            isSellable: true,
            isDefaultSaleUnit: true,
          },
        });

        if (input.ingredients.length > 0) {
          await tx.productIngredient.createMany({
            data: input.ingredients.map((item) => ({
              productId: product.id,
              ingredientId: item.ingredientId,
              strengthText: item.strengthText ?? null,
            })),
          });
        }

        return product;
      }),
    { conflictMessage: "Mã sản phẩm đã tồn tại" },
  );

  sendData(res, created, 201);
});

productsRouter.patch("/products/:id", requirePermission("catalog.manage"), async (req, res) => {
  const id = String(req.params.id);
  const { version, ...fields } = parseOrThrow(patchSchema, req.body);

  await updateWithVersion({
    notFoundMessage: "Không tìm thấy sản phẩm",
    update: () =>
      withMappedErrors(() =>
        prisma.product.updateMany({
          where: { id, version },
          data: { ...fields, version: { increment: 1 } },
        }),
      ),
    exists: async () => (await prisma.product.count({ where: { id } })) > 0,
  });

  sendData(res, await prisma.product.findUnique({ where: { id } }));
});

for (const [action, isActive] of [
  ["deactivate", false],
  ["activate", true],
] as const) {
  productsRouter.post(
    `/products/:id/${action}`,
    requirePermission("catalog.manage"),
    async (req, res) => {
      const id = String(req.params.id);
      const result = await prisma.product.updateMany({ where: { id }, data: { isActive } });
      if (result.count === 0) throw AppError.notFound("Không tìm thấy sản phẩm");
      sendData(res, { id, isActive });
    },
  );
}
