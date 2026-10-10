import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import type { AuthContext } from "../auth/auth.context.js";

/**
 * Sổ khiếu nại và theo dõi phản ứng có hại của thuốc (GPP, TT 02/2018 Phụ lục
 * I mục III.4): lưu thông tin thuốc bị khiếu nại, theo dõi tác dụng không mong
 * muốn và việc đã báo cơ quan y tế.
 *
 * Phần mềm chỉ ghi sổ. Báo cáo ADR gửi Trung tâm DI&ADR quốc gia theo mẫu của
 * Trung tâm; ở đây chỉ ghi ngày đã gửi để tra lại, không tự dựng mẫu báo cáo.
 * Nghi lỗi chất lượng thì biệt trữ lô bằng chức năng biệt trữ sẵn có.
 */

export const REPORT_KINDS = ["COMPLAINT", "ADR"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type CreateReportInput = {
  kind: ReportKind;
  occurredOn: Date;
  productId?: string | null | undefined;
  batchId?: string | null | undefined;
  reporterName?: string | null | undefined;
  reporterPhone?: string | null | undefined;
  description: string;
  actionTaken?: string | null | undefined;
};

export type UpdateReportInput = {
  version: number;
  actionTaken?: string | null | undefined;
  adrReportedOn?: Date | null | undefined;
};

/** Lô phải thuộc cửa hàng; có cả sản phẩm và lô thì lô phải của đúng sản phẩm đó. */
async function resolveProduct(storeId: string, productId: string | null, batchId: string | null) {
  if (batchId) {
    const batch = await prisma.batch.findFirst({
      where: { id: batchId, storeId },
      select: { productId: true },
    });
    if (!batch) throw AppError.notFound("Không tìm thấy lô trong kho cửa hàng");
    if (productId && productId !== batch.productId) {
      throw AppError.validation("Lô không thuộc sản phẩm đã chọn");
    }
    return batch.productId;
  }
  if (productId) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw AppError.notFound("Không tìm thấy sản phẩm");
  }
  return productId;
}

export async function create(
  storeId: string,
  auth: AuthContext,
  input: CreateReportInput,
): Promise<string> {
  const productId = await resolveProduct(storeId, input.productId ?? null, input.batchId ?? null);
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { code: true },
  });

  return prisma.$transaction(async (tx) => {
    const created = await tx.qualityReport.create({
      data: {
        storeId,
        code: await nextDocumentCode(tx, storeId, `KN-${store.code}-${codeDay()}-`),
        kind: input.kind,
        occurredOn: input.occurredOn,
        productId,
        batchId: input.batchId ?? null,
        reporterName: input.reporterName || null,
        reporterPhone: input.reporterPhone || null,
        description: input.description,
        actionTaken: input.actionTaken || null,
        createdBy: auth.userId,
      },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "QUALITY_REPORT_CREATE",
        resourceType: "quality_report",
        resourceId: created.id,
        after: { code: created.code, kind: created.kind, productId, batchId: created.batchId },
      },
    });
    return created.id;
  });
}

/** Cập nhật cách xử lý và ngày đã báo ADR; phiếu đã đóng thì không sửa. */
export async function update(
  storeId: string,
  id: string,
  auth: AuthContext,
  input: UpdateReportInput,
): Promise<void> {
  const existing = await prisma.qualityReport.findFirst({ where: { id, storeId } });
  if (!existing) throw AppError.notFound("Không tìm thấy phiếu");
  if (existing.status === "CLOSED") throw AppError.invalidState("Phiếu đã đóng, không sửa được");
  if (input.adrReportedOn && existing.kind !== "ADR") {
    throw AppError.validation("Chỉ phiếu phản ứng có hại mới ghi ngày báo cáo ADR");
  }

  const moved = await prisma.qualityReport.updateMany({
    where: { id, storeId, version: input.version, status: "OPEN" },
    data: {
      ...(input.actionTaken === undefined ? {} : { actionTaken: input.actionTaken || null }),
      ...(input.adrReportedOn === undefined ? {} : { adrReportedOn: input.adrReportedOn }),
      version: { increment: 1 },
    },
  });
  if (moved.count === 0) {
    throw new AppError(
      409,
      "VERSION_CONFLICT",
      "Phiếu vừa được người khác cập nhật, tải lại rồi sửa tiếp",
    );
  }
  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: auth.userId,
      action: "QUALITY_REPORT_UPDATE",
      resourceType: "quality_report",
      resourceId: id,
      after: { actionTaken: input.actionTaken, adrReportedOn: input.adrReportedOn },
    },
  });
}

/** Đóng phiếu khi đã xử lý xong: bắt buộc có cách xử lý. */
export async function close(
  storeId: string,
  id: string,
  auth: AuthContext,
  actionTaken: string | null,
): Promise<void> {
  const existing = await prisma.qualityReport.findFirst({ where: { id, storeId } });
  if (!existing) throw AppError.notFound("Không tìm thấy phiếu");
  const action = actionTaken || existing.actionTaken;
  if (!action) throw AppError.validation("Ghi cách đã xử lý trước khi đóng phiếu");

  const moved = await prisma.qualityReport.updateMany({
    where: { id, storeId, status: "OPEN" },
    data: {
      status: "CLOSED",
      actionTaken: action,
      closedBy: auth.userId,
      closedAt: new Date(),
      version: { increment: 1 },
    },
  });
  if (moved.count === 0) throw AppError.invalidState("Phiếu đã đóng từ trước");
  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: auth.userId,
      action: "QUALITY_REPORT_CLOSE",
      resourceType: "quality_report",
      resourceId: id,
    },
  });
}

const include = {
  product: { select: { id: true, code: true, name: true } },
  batch: { select: { id: true, batchNumber: true, expiryDate: true, status: true, version: true } },
  createdByUser: { select: { fullName: true } },
  closedByUser: { select: { fullName: true } },
} as const;

type Row = Awaited<
  ReturnType<typeof prisma.qualityReport.findFirstOrThrow<{ include: typeof include }>>
>;

function toView(row: Row) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    occurredOn: row.occurredOn,
    product: row.product,
    batch: row.batch,
    reporterName: row.reporterName,
    reporterPhone: row.reporterPhone,
    description: row.description,
    actionTaken: row.actionTaken,
    status: row.status,
    adrReportedOn: row.adrReportedOn,
    createdAt: row.createdAt,
    createdByName: row.createdByUser.fullName,
    closedAt: row.closedAt,
    closedByName: row.closedByUser?.fullName ?? null,
    version: row.version,
  };
}

export async function getDetail(storeId: string, id: string) {
  const row = await prisma.qualityReport.findFirst({ where: { id, storeId }, include });
  if (!row) throw AppError.notFound("Không tìm thấy phiếu");
  return toView(row);
}

export async function list(
  storeId: string,
  query: { status?: string | undefined; kind?: string | undefined },
) {
  const rows = await prisma.qualityReport.findMany({
    where: {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    },
    orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
    take: 200,
    include,
  });
  return rows.map(toView);
}
