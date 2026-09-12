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

export const categoriesRouter = Router();
categoriesRouter.use(authenticate, storeContext);

const createSchema = z.object({
  name: z.string().trim().min(1, "Thiếu tên nhóm").max(200),
  parentId: z.uuid().nullish(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  version: z.coerce.number().int().positive(),
});

categoriesRouter.get("/categories", requirePermission("catalog.read"), async (req, res) => {
  const page = parsePageQuery(req.query, { sortable: ["name", "createdAt"], defaultSort: "name" });
  const search = typeof req.query["search"] === "string" ? req.query["search"].trim() : "";
  const where = {
    ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
    ...(req.query["isActive"] === "false" ? { isActive: false } : { isActive: true }),
  };

  const [items, total] = await Promise.all([
    prisma.category.findMany({
      where,
      orderBy: { [page.sortBy]: page.order },
      skip: page.skip,
      take: page.limit,
    }),
    prisma.category.count({ where }),
  ]);

  sendData(res, pageResult(items, total, page));
});

categoriesRouter.get("/categories/:id", requirePermission("catalog.read"), async (req, res) => {
  const category = await prisma.category.findUnique({ where: { id: String(req.params.id) } });
  if (!category) throw AppError.notFound("Không tìm thấy nhóm sản phẩm");
  sendData(res, category);
});

categoriesRouter.post("/categories", requirePermission("catalog.manage"), async (req, res) => {
  const input = parseOrThrow(createSchema, req.body);
  const category = await withMappedErrors(
    () => prisma.category.create({ data: { name: input.name, parentId: input.parentId ?? null } }),
    { conflictMessage: "Nhóm sản phẩm này đã tồn tại" },
  );
  sendData(res, category, 201);
});

categoriesRouter.patch("/categories/:id", requirePermission("catalog.manage"), async (req, res) => {
  const id = String(req.params.id);
  const input = parseOrThrow(patchSchema, req.body);

  await updateWithVersion({
    notFoundMessage: "Không tìm thấy nhóm sản phẩm",
    update: () =>
      withMappedErrors(() =>
        prisma.category.updateMany({
          where: { id, version: input.version },
          data: { ...(input.name ? { name: input.name } : {}), version: { increment: 1 } },
        }),
      ),
    exists: async () => (await prisma.category.count({ where: { id } })) > 0,
  });

  sendData(res, await prisma.category.findUnique({ where: { id } }));
});

categoriesRouter.post(
  "/categories/:id/deactivate",
  requirePermission("catalog.manage"),
  async (req, res) => {
    const id = String(req.params.id);
    const inUse = await prisma.product.count({ where: { categoryId: id, isActive: true } });
    if (inUse > 0) {
      throw new AppError(
        409,
        "INVALID_STATE",
        `Còn ${inUse} sản phẩm đang kinh doanh thuộc nhóm này`,
      );
    }
    const result = await prisma.category.updateMany({ where: { id }, data: { isActive: false } });
    if (result.count === 0) throw AppError.notFound("Không tìm thấy nhóm sản phẩm");
    sendData(res, { id, isActive: false });
  },
);

categoriesRouter.post(
  "/categories/:id/activate",
  requirePermission("catalog.manage"),
  async (req, res) => {
    const id = String(req.params.id);
    const result = await prisma.category.updateMany({ where: { id }, data: { isActive: true } });
    if (result.count === 0) throw AppError.notFound("Không tìm thấy nhóm sản phẩm");
    sendData(res, { id, isActive: true });
  },
);
