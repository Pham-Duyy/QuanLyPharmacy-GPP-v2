import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { pageResult, parsePageQuery } from "../../lib/pagination.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import { orderByIds, searchIngredientPage } from "./search.js";

export const ingredientsRouter = Router();
// Giới hạn theo tiền tố thật sự dùng, cùng lý do đã ghi ở categories.routes.ts.
ingredientsRouter.use("/active-ingredients", authenticate, storeContext);

const bodySchema = z.object({
  name: z.string().trim().min(1, "Thiếu tên hoạt chất").max(200),
  atcCode: z.string().trim().max(20).nullish(),
});

ingredientsRouter.get(
  "/active-ingredients",
  requirePermission("catalog.read"),
  async (req, res) => {
    const page = parsePageQuery(req.query, { sortable: ["name"], defaultSort: "name" });
    const search = typeof req.query["search"] === "string" ? req.query["search"].trim() : "";

    // Tìm không dấu dùng chỉ mục trigram (ERD §1.6); lọc, đếm và phân
    // trang trong cùng một câu lệnh nên tổng số không bị chặn ở mức trần.
    const { ids, total } = await searchIngredientPage(search || null, page);
    const items = orderByIds(
      await prisma.activeIngredient.findMany({ where: { id: { in: ids } } }),
      ids,
    );

    sendData(res, pageResult(items, total, page));
  },
);

ingredientsRouter.post(
  "/active-ingredients",
  requirePermission("catalog.manage"),
  async (req, res) => {
    const input = parseOrThrow(bodySchema, req.body);
    const created = await withMappedErrors(
      () =>
        prisma.activeIngredient.create({
          data: { name: input.name, atcCode: input.atcCode ?? null },
        }),
      { conflictMessage: "Hoạt chất này đã có trong danh mục" },
    );
    sendData(res, created, 201);
  },
);

ingredientsRouter.patch(
  "/active-ingredients/:id",
  requirePermission("catalog.manage"),
  async (req, res) => {
    const id = String(req.params.id);
    const input = parseOrThrow(bodySchema.partial(), req.body);

    const result = await withMappedErrors(() =>
      prisma.activeIngredient.updateMany({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.atcCode !== undefined ? { atcCode: input.atcCode ?? null } : {}),
        },
      }),
    );
    if (result.count === 0) throw AppError.notFound("Không tìm thấy hoạt chất");

    sendData(res, await prisma.activeIngredient.findUnique({ where: { id } }));
  },
);
