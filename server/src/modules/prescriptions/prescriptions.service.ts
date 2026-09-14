import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { getSetting } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import type {
  CreatePrescriptionInput,
  PatchPrescriptionInput,
  VerifyPrescriptionInput,
} from "./prescriptions.schema.js";

type Tx = Prisma.TransactionClient;
type ItemInput = CreatePrescriptionInput["items"][number];

type ResolvedItem = {
  lineNo: number;
  productId: string | null;
  drugNameText: string;
  productUnitId: string | null;
  quantity: number;
  baseQuantity: number | null;
  dosageInstruction: string | null;
};

/**
 * Kiểm tra và quy đổi các dòng thuốc. Thuốc mới kê bằng tay chưa khớp được
 * sản phẩm trong danh mục vẫn hợp lệ (`productId` bỏ trống) — dùng chung
 * cho tạo mới và sửa, để hai chỗ không lệch luật với nhau.
 */
async function resolveItems(tx: Tx, items: ItemInput[]): Promise<ResolvedItem[]> {
  const unitIds = items.filter((item) => item.unitId).map((item) => item.unitId!);
  const units = await tx.productUnit.findMany({ where: { id: { in: unitIds } } });
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  return items.map((item, index) => {
    if (!item.unitId || !item.productId) {
      return {
        lineNo: index + 1,
        productId: null,
        drugNameText: item.drugNameText,
        productUnitId: null,
        quantity: item.quantity,
        baseQuantity: null,
        dosageInstruction: item.dosageInstruction ?? null,
      };
    }

    const unit = unitById.get(item.unitId);
    if (!unit || unit.productId !== item.productId) {
      throw new AppError(
        422,
        "UNIT_NOT_IN_PRODUCT",
        `Dòng ${index + 1}: đơn vị tính không thuộc sản phẩm đã chọn`,
      );
    }

    return {
      lineNo: index + 1,
      productId: item.productId,
      drugNameText: item.drugNameText,
      productUnitId: unit.id,
      quantity: item.quantity,
      baseQuantity: item.quantity * unit.conversionToBase,
      dosageInstruction: item.dosageInstruction ?? null,
    };
  });
}

async function nextCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(new Date())
    .replace(/-/g, "");
  const prefix = `DT-${storeCode}-${day}-`;
  const countToday = await tx.prescription.count({
    where: { storeId, code: { startsWith: prefix } },
  });
  return `${prefix}${String(countToday + 1).padStart(4, "0")}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Tạo đơn `DRAFT` (contract §12). Đơn thuốc là tài nguyên toàn chuỗi khi
 * đọc và dùng (§2.8), nhưng vẫn phải ghi nhận **cửa hàng tiếp nhận** lúc
 * tạo, nên riêng hành động này cần chọn cửa hàng qua X-Store-Id.
 */
export async function createDraft(
  storeId: string | null,
  userId: string,
  input: CreatePrescriptionInput,
): Promise<string> {
  if (!storeId) {
    throw new AppError(400, "STORE_REQUIRED", "Cần chọn cửa hàng đang tiếp nhận để tạo đơn thuốc");
  }
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  return prisma.$transaction(async (tx) => {
    const items = await resolveItems(tx, input.items);

    const validityDays = await getSetting("prescriptionValidityDays", storeId);
    const validUntil = input.validUntil ?? addDays(input.prescribedDate, validityDays);

    const prescription = await tx.prescription.create({
      data: {
        storeId,
        code: await nextCode(tx, storeId, store.code),
        externalCode: input.externalCode ?? null,
        customerId: input.customerId ?? null,
        prescriberName: input.prescriberName ?? null,
        facilityName: input.facilityName ?? null,
        diagnosisText: input.diagnosisText ?? null,
        prescribedDate: input.prescribedDate,
        validUntil,
        createdBy: userId,
        items: { create: items },
      },
    });

    return prescription.id;
  });
}

/** Sửa khi còn `DRAFT` hoặc `PENDING_REVIEW`; cần đúng `version` (contract §12, §2.5). */
export async function updateDraft(
  prescriptionId: string,
  input: PatchPrescriptionInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const items = input.items ? await resolveItems(tx, input.items) : null;

    // Gán vào biến có kiểu rõ ràng trước: object literal rải rác từ nhiều
    // spread điều kiện khiến TypeScript không suy luận đúng kiểu "Unchecked"
    // cần thiết để sửa thẳng customerId (khóa ngoại) qua updateMany.
    const data: Prisma.PrescriptionUncheckedUpdateManyInput = {
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.externalCode !== undefined ? { externalCode: input.externalCode } : {}),
      ...(input.prescriberName !== undefined ? { prescriberName: input.prescriberName } : {}),
      ...(input.facilityName !== undefined ? { facilityName: input.facilityName } : {}),
      ...(input.diagnosisText !== undefined ? { diagnosisText: input.diagnosisText } : {}),
      ...(input.prescribedDate !== undefined ? { prescribedDate: input.prescribedDate } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      version: { increment: 1 },
    };

    const moved = await tx.prescription.updateMany({
      where: {
        id: prescriptionId,
        status: { in: ["DRAFT", "PENDING_REVIEW"] },
        version: input.version,
      },
      data,
    });

    if (moved.count === 0) {
      const existing = await tx.prescription.findUnique({ where: { id: prescriptionId } });
      if (!existing) throw AppError.notFound("Không tìm thấy đơn thuốc");
      if (!["DRAFT", "PENDING_REVIEW"].includes(existing.status)) {
        throw new AppError(
          409,
          "INVALID_STATE",
          `Đơn đang ở trạng thái ${existing.status}, không sửa được`,
        );
      }
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "Đơn đã được người khác sửa, hãy tải lại rồi thử lại",
      );
    }

    if (items) {
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId } });
      await tx.prescriptionItem.createMany({
        data: items.map((item) => ({ ...item, prescriptionId })),
      });
    }
  });
}

/** Chuyển trạng thái có điều kiện, dùng chung cho submit/verify/reject. */
async function transition(
  tx: Tx,
  prescriptionId: string,
  fromStatuses: string[],
  data: Prisma.PrescriptionUncheckedUpdateManyInput,
): Promise<void> {
  const moved = await tx.prescription.updateMany({
    where: { id: prescriptionId, status: { in: fromStatuses } },
    data,
  });
  if (moved.count === 0) {
    const existing = await tx.prescription.findUnique({ where: { id: prescriptionId } });
    if (!existing) throw AppError.notFound("Không tìm thấy đơn thuốc");
    throw new AppError(
      409,
      "INVALID_STATE",
      `Đơn đang ở trạng thái ${existing.status}, không thực hiện được thao tác này`,
    );
  }
}

export async function submit(prescriptionId: string): Promise<void> {
  await prisma.$transaction((tx) =>
    transition(tx, prescriptionId, ["DRAFT"], { status: "PENDING_REVIEW" }),
  );
}

/**
 * Dược sĩ xác nhận đơn (contract §12): mọi dòng phải đã khớp `productId`,
 * vì sau bước này đơn được dùng để bán hàng — dòng chưa khớp sản phẩm thì
 * không tính được tồn hay giá. `verifiedBy` luôn lấy từ phiên đăng nhập.
 */
export async function verify(
  prescriptionId: string,
  auth: AuthContext,
  input: VerifyPrescriptionInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const items = await tx.prescriptionItem.findMany({ where: { prescriptionId } });
    if (items.length === 0) throw AppError.notFound("Không tìm thấy đơn thuốc");
    if (items.some((item) => !item.productId)) {
      throw new AppError(
        422,
        "VALIDATION_ERROR",
        "Mọi dòng thuốc phải khớp sản phẩm trong danh mục trước khi xác nhận",
      );
    }

    await transition(tx, prescriptionId, ["DRAFT", "PENDING_REVIEW"], {
      status: "VERIFIED",
      verifiedBy: auth.userId,
      verifiedAt: new Date(),
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    });
  });
}

export async function reject(prescriptionId: string, reason: string): Promise<void> {
  await prisma.$transaction((tx) =>
    transition(tx, prescriptionId, ["DRAFT", "PENDING_REVIEW"], {
      status: "REJECTED",
      rejectedReason: reason,
    }),
  );
}

/** Chi tiết đơn, kèm số lượng đã bán từng dòng. Mỗi lần xem đều ghi audit (contract §12, §18). */
export async function getDetail(prescriptionId: string, auth: AuthContext) {
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      customer: { select: { id: true, fullName: true, phone: true } },
      createdByUser: { select: { id: true, fullName: true } },
      verifiedByUser: { select: { id: true, fullName: true } },
      images: {
        orderBy: { versionNo: "desc" },
        select: { id: true, versionNo: true, uploadedAt: true },
      },
      items: {
        orderBy: { lineNo: "asc" },
        include: {
          product: { select: { code: true, name: true, drugClass: true } },
          productUnit: { select: { name: true, conversionToBase: true } },
        },
      },
    },
  });
  if (!prescription) throw AppError.notFound("Không tìm thấy đơn thuốc");

  await prisma.auditLog.create({
    data: {
      storeId: prescription.storeId,
      actorId: auth.userId,
      action: "PRESCRIPTION_VIEW",
      resourceType: "prescription",
      resourceId: prescriptionId,
    },
  });

  return {
    id: prescription.id,
    code: prescription.code,
    externalCode: prescription.externalCode,
    status: prescription.status,
    customer: prescription.customer,
    prescriberName: prescription.prescriberName,
    facilityName: prescription.facilityName,
    diagnosisText: prescription.diagnosisText,
    prescribedDate: prescription.prescribedDate,
    validUntil: prescription.validUntil,
    createdBy: prescription.createdByUser,
    verifiedBy: prescription.verifiedByUser,
    verifiedAt: prescription.verifiedAt,
    rejectedReason: prescription.rejectedReason,
    version: prescription.version,
    images: prescription.images,
    items: prescription.items.map((item) => ({
      id: item.id,
      lineNo: item.lineNo,
      productId: item.productId,
      productCode: item.product?.code ?? null,
      productName: item.product?.name ?? null,
      drugClass: item.product?.drugClass ?? null,
      drugNameText: item.drugNameText,
      unitId: item.productUnitId,
      unitName: item.productUnit?.name ?? null,
      quantity: item.quantity,
      baseQuantity: item.baseQuantity,
      dosageInstruction: item.dosageInstruction,
      dispensedBaseQuantity: item.dispensedBaseQuantity,
    })),
  };
}

export async function list(query: { customerId?: string; status?: string }) {
  return prisma.prescription.findMany({
    where: {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      customer: { select: { fullName: true } },
      _count: { select: { items: true } },
    },
    take: 100,
  });
}
