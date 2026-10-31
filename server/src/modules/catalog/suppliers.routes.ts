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
import { optionalPhone, optionalTaxCode } from "../../lib/validators.js";

export const suppliersRouter = Router();
// Giới hạn theo tiền tố thật sự dùng, cùng lý do đã ghi ở categories.routes.ts.
suppliersRouter.use("/suppliers", authenticate, storeContext);

const createSchema = z.object({
  name: z.string().trim().min(1, "Thiếu tên nhà cung cấp").max(300),
  taxCode: optionalTaxCode(),
  licenseNumber: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  phone: optionalPhone(),
  /** Email nhận đơn đặt hàng (Phase 7, D32). */
  email: z
    .email("Email không hợp lệ")
    .trim()
    .max(200)
    .nullish()
    .or(z.literal("").transform(() => null)),
});

/**
 * Hai nhà cung cấp trùng tên hoặc trùng mã số thuế gần như luôn là nhập hai lần
 * một nhà cung cấp: công nợ và phiếu nhập bị chia ra hai nơi (D28).
 */
async function assertSupplierFree(
  fields: { name?: string | undefined; taxCode?: string | null | undefined },
  exceptId?: string,
) {
  const notSelf = exceptId ? { id: { not: exceptId } } : {};
  if (fields.taxCode) {
    const other = await prisma.supplier.findFirst({
      where: { taxCode: fields.taxCode, ...notSelf },
      select: { name: true },
    });
    if (other) {
      throw new AppError(
        409,
        "DUPLICATE_TAX_CODE",
        `Mã số thuế ${fields.taxCode} đã thuộc nhà cung cấp "${other.name}"`,
      );
    }
  }
  if (fields.name) {
    const other = await prisma.supplier.findFirst({
      where: { name: { equals: fields.name, mode: "insensitive" }, ...notSelf },
      select: { name: true, isActive: true },
    });
    if (other) {
      throw new AppError(
        409,
        "DUPLICATE_NAME",
        `Đã có nhà cung cấp "${other.name}"${other.isActive ? "" : " (đang ngừng sử dụng, bấm Kích hoạt lại để dùng)"}`,
      );
    }
  }
}

const patchSchema = createSchema.partial().extend({
  version: z.coerce.number().int().positive(),
});

suppliersRouter.get("/suppliers", requirePermission("catalog.read"), async (req, res) => {
  const page = parsePageQuery(req.query, { sortable: ["name", "createdAt"], defaultSort: "name" });
  const search = typeof req.query["search"] === "string" ? req.query["search"].trim() : "";

  const where = {
    isActive: req.query["isActive"] !== "false",
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { phone: { contains: search } },
            { taxCode: { contains: search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      orderBy: { [page.sortBy]: page.order },
      skip: page.skip,
      take: page.limit,
    }),
    prisma.supplier.count({ where }),
  ]);

  sendData(res, pageResult(items, total, page));
});

suppliersRouter.get("/suppliers/:id", requirePermission("catalog.read"), async (req, res) => {
  const supplier = await prisma.supplier.findUnique({ where: { id: String(req.params.id) } });
  if (!supplier) throw AppError.notFound("Không tìm thấy nhà cung cấp");
  sendData(res, supplier);
});

suppliersRouter.post("/suppliers", requirePermission("catalog.manage"), async (req, res) => {
  const input = parseOrThrow(createSchema, req.body);
  await assertSupplierFree(input);
  const created = await withMappedErrors(() =>
    prisma.supplier.create({
      data: {
        name: input.name,
        taxCode: input.taxCode ?? null,
        licenseNumber: input.licenseNumber ?? null,
        address: input.address ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
      },
    }),
  );
  sendData(res, created, 201);
});

suppliersRouter.patch("/suppliers/:id", requirePermission("catalog.manage"), async (req, res) => {
  const id = String(req.params.id);
  const { version, ...fields } = parseOrThrow(patchSchema, req.body);
  await assertSupplierFree(fields, id);

  await updateWithVersion({
    notFoundMessage: "Không tìm thấy nhà cung cấp",
    update: () =>
      withMappedErrors(() =>
        prisma.supplier.updateMany({
          where: { id, version },
          data: { ...fields, version: { increment: 1 } },
        }),
      ),
    exists: async () => (await prisma.supplier.count({ where: { id } })) > 0,
  });

  sendData(res, await prisma.supplier.findUnique({ where: { id } }));
});

for (const [action, isActive] of [
  ["deactivate", false],
  ["activate", true],
] as const) {
  suppliersRouter.post(
    `/suppliers/:id/${action}`,
    requirePermission("catalog.manage"),
    async (req, res) => {
      const id = String(req.params.id);
      const result = await prisma.supplier.updateMany({ where: { id }, data: { isActive } });
      if (result.count === 0) throw AppError.notFound("Không tìm thấy nhà cung cấp");
      sendData(res, { id, isActive });
    },
  );
}
