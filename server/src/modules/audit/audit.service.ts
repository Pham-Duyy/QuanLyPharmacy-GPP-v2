import { prisma } from "../../db/prisma.js";
import type { ListAuditLogsQuery } from "./audit.schema.js";

/**
 * Xem audit log (contract §18). Chỉ đọc — không có API tạo/sửa/xóa, backend
 * tự ghi ở từng nghiệp vụ. Phân trang con trỏ theo `id` (tăng dần theo thời
 * gian ghi), giống thẻ kho ở §10.2, vì dữ liệu chỉ tăng liên tục.
 */
export async function list(query: ListAuditLogsQuery) {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.from || query.to ? { occurredAt: { gte: query.from, lte: query.to } } : {}),
      ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: query.limit + 1,
    include: { actor: { select: { id: true, fullName: true } } },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: page.map((row) => ({
      id: row.id.toString(),
      occurredAt: row.occurredAt,
      actorId: row.actorId,
      actorName: row.actor?.fullName ?? null,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      requestId: row.requestId,
      ip: row.ip,
      userAgent: row.userAgent,
      before: row.before,
      after: row.after,
      reason: row.reason,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id.toString() : null,
  };
}
