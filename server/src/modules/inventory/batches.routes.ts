import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { pageResult, parsePageQuery } from "../../lib/pagination.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";

export const batchesRouter = Router();

// Lô luôn thuộc một cửa hàng cụ thể; không được đọc hoặc đổi trạng thái chéo cửa hàng.
batchesRouter.use("/inventory/batches", authenticate, storeContext, requireStore);

const statusSchema = z.enum(["AVAILABLE", "QUARANTINED", "RECALLED"]);
const actionSchema = z.object({
  reason: z.string().trim().min(3, "Cần ghi rõ lý do").max(500),
  version: z.coerce.number().int().positive(),
});

batchesRouter.get("/inventory/batches", requirePermission("stock.read"), async (req, res) => {
  const page = parsePageQuery(req.query, {
    sortable: ["expiryDate", "batchNumber", "createdAt"],
    defaultSort: "expiryDate",
  });
  const query = req.query as Record<string, string | undefined>;
  const search = query["search"]?.trim();
  const status = query["status"] ? parseOrThrow(statusSchema, query["status"]) : undefined;
  const where = {
    storeId: req.auth!.storeId!,
    ...(status ? { status } : {}),
    ...(query["productId"] ? { productId: query["productId"] } : {}),
    ...(search
      ? {
          OR: [
            { batchNumber: { contains: search, mode: "insensitive" as const } },
            { product: { name: { contains: search, mode: "insensitive" as const } } },
            { product: { code: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [batches, total] = await Promise.all([
    prisma.batch.findMany({
      where,
      orderBy: { [page.sortBy]: page.order },
      skip: page.skip,
      take: page.limit,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            units: { where: { conversionToBase: 1 }, select: { name: true }, take: 1 },
          },
        },
      },
    }),
    prisma.batch.count({ where }),
  ]);
  sendData(
    res,
    pageResult(
      batches.map((batch) => ({
        id: batch.id,
        productId: batch.product.id,
        productCode: batch.product.code,
        productName: batch.product.name,
        baseUnitName: batch.product.units[0]?.name ?? "Đơn vị cơ bản",
        batchNumber: batch.batchNumber,
        manufactureDate: batch.manufactureDate,
        expiryDate: batch.expiryDate,
        status: batch.status,
        quantityOnHand: batch.quantityOnHand,
        shelfLocation: batch.shelfLocation,
        note: batch.note,
        version: batch.version,
      })),
      total,
      page,
    ),
  );
});

async function changeStatus(
  storeId: string,
  batchId: string,
  expected: "AVAILABLE" | "QUARANTINED",
  next: "AVAILABLE" | "QUARANTINED",
  input: z.infer<typeof actionSchema>,
  actorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({ where: { id: batchId, storeId } });
    if (!batch) throw AppError.notFound("Không tìm thấy lô tại cửa hàng này");
    if (batch.status !== expected)
      throw AppError.invalidState(
        `Lô đang ở trạng thái ${batch.status}, không thể thực hiện thao tác này`,
      );
    const updated = await tx.batch.updateMany({
      where: { id: batchId, storeId, status: expected, version: input.version },
      data: { status: next, note: input.reason, version: { increment: 1 } },
    });
    if (updated.count === 0)
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "Dữ liệu lô đã được người khác cập nhật; hãy tải lại",
      );
    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        action: next === "QUARANTINED" ? "BATCH_QUARANTINE" : "BATCH_RELEASE",
        resourceType: "batch",
        resourceId: batchId,
        before: { status: batch.status },
        after: { status: next },
        reason: input.reason,
      },
    });
  });
}

batchesRouter.post(
  "/inventory/batches/:id/quarantine",
  requirePermission("batch.quarantine"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(actionSchema, req.body);
    await changeStatus(
      req.auth!.storeId!,
      String(req.params.id),
      "AVAILABLE",
      "QUARANTINED",
      input,
      req.auth!.userId,
    );
    sendData(res, { id: String(req.params.id), status: "QUARANTINED" });
  },
);

batchesRouter.post(
  "/inventory/batches/:id/release",
  requirePermission("batch.quarantine"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(actionSchema, req.body);
    await changeStatus(
      req.auth!.storeId!,
      String(req.params.id),
      "QUARANTINED",
      "AVAILABLE",
      input,
      req.auth!.userId,
    );
    sendData(res, { id: String(req.params.id), status: "AVAILABLE" });
  },
);
