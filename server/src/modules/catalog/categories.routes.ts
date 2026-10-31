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
// Giới hạn theo tiền tố "/categories": .use() không kèm đường dẫn chạy cho
// MỌI request đi qua router này, kể cả của router khác đăng ký sau — ở đây
// cụ thể là chặn nhầm 401 lên endpoint công khai /rx-images (xem
// prescription-images.routes.ts).
categoriesRouter.use("/categories", authenticate, storeContext);

const createSchema = z.object({
  name: z.string().trim().min(1, "Thiếu tên nhóm").max(200),
  parentId: z.uuid().nullish(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  version: z.coerce.number().int().positive(),
});

/**
 * Trùng tên trong cùng nhóm cha, không phân biệt hoa thường (D28). Ràng buộc
 * unique của CSDL không bắt được nhóm gốc vì `parent_id` NULL khác nhau.
 */
async function assertCategoryFree(name: string, parentId: string | null, exceptId?: string) {
  const same = await prisma.category.findFirst({
    where: {
      parentId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true, isActive: true },
  });
  if (same) {
    throw new AppError(
      409,
      "DUPLICATE_NAME",
      `Đã có nhóm "${same.name}"${same.isActive ? "" : " (đang ngừng sử dụng, bấm Kích hoạt lại để dùng)"}`,
    );
  }
}

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
  await assertCategoryFree(input.name, input.parentId ?? null);
  const category = await withMappedErrors(
    () => prisma.category.create({ data: { name: input.name, parentId: input.parentId ?? null } }),
    { conflictMessage: "Nhóm sản phẩm này đã tồn tại" },
  );
  sendData(res, category, 201);
});

categoriesRouter.patch("/categories/:id", requirePermission("catalog.manage"), async (req, res) => {
  const id = String(req.params.id);
  const input = parseOrThrow(patchSchema, req.body);
  if (input.name) {
    const current = await prisma.category.findUnique({ where: { id }, select: { parentId: true } });
    if (current) await assertCategoryFree(input.name, current.parentId, id);
  }

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
