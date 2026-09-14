import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type {
  ConfirmReceiptInput,
  CreateReceiptInput,
  PatchReceiptInput,
} from "./goods-receipts.schema.js";

type Tx = Prisma.TransactionClient;
type LineInput = CreateReceiptInput["lines"][number];

type ResolvedLine = {
  lineNo: number;
  productId: string;
  productUnitId: string;
  quantity: number;
  baseQuantity: number;
  unitCost: bigint;
  lineCost: bigint;
  batchNumber: string;
  manufactureDate: Date | null;
  expiryDate: Date;
};

/**
 * Kiểm tra và quy đổi các dòng của phiếu nhập: sản phẩm phải đang kinh
 * doanh, đơn vị phải thuộc đúng sản phẩm. Dùng chung cho tạo mới và sửa,
 * để hai chỗ không lệch luật với nhau.
 */
async function resolveLines(tx: Tx, lines: LineInput[]): Promise<ResolvedLine[]> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const units = await tx.productUnit.findMany({
    where: { id: { in: lines.map((line) => line.unitId) } },
    include: { product: { select: { id: true, isActive: true } } },
  });
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  const products = await tx.product.findMany({ where: { id: { in: productIds } } });
  if (products.length !== productIds.length) {
    throw new AppError(422, "VALIDATION_ERROR", "Có sản phẩm không tồn tại trong danh mục");
  }
  if (products.some((product) => !product.isActive)) {
    throw new AppError(422, "VALIDATION_ERROR", "Không nhập được sản phẩm đã ngừng kinh doanh");
  }

  return lines.map((line, index) => {
    const unit = unitById.get(line.unitId);
    // Đơn vị phải thuộc đúng sản phẩm, nếu không số lượng quy đổi sẽ sai hoàn toàn.
    if (!unit || unit.product.id !== line.productId) {
      throw new AppError(
        422,
        "UNIT_NOT_IN_PRODUCT",
        `Dòng ${index + 1}: đơn vị tính không thuộc sản phẩm đã chọn`,
      );
    }

    return {
      lineNo: index + 1,
      productId: line.productId,
      productUnitId: line.unitId,
      quantity: line.quantity,
      baseQuantity: line.quantity * unit.conversionToBase,
      unitCost: BigInt(line.unitCost),
      lineCost: BigInt(line.unitCost) * BigInt(line.quantity),
      batchNumber: line.batchNumber,
      manufactureDate: line.manufactureDate ?? null,
      expiryDate: line.expiryDate,
    };
  });
}

/** Số chứng từ có tiền tố mã cửa hàng, theo ERD §1.8. */
async function nextReceiptCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  const today = new Date();
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(today)
    .replace(/-/g, "");

  const countToday = await tx.goodsReceipt.count({
    where: { storeId, code: { startsWith: `PN-${storeCode}-${day}-` } },
  });

  return `PN-${storeCode}-${day}-${String(countToday + 1).padStart(4, "0")}`;
}

export async function createDraft(
  storeId: string,
  userId: string,
  input: CreateReceiptInput,
): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  const receipt = await prisma.$transaction(async (tx) => {
    const lines = await resolveLines(tx, input.lines);
    const totalCost = lines.reduce((sum, line) => sum + line.lineCost, 0n);

    return tx.goodsReceipt.create({
      data: {
        storeId,
        code: await nextReceiptCode(tx, storeId, store.code),
        type: "PURCHASE",
        supplierId: input.supplierId,
        supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
        supplierInvoiceDate: input.supplierInvoiceDate ?? null,
        receivedAt: input.receivedAt,
        note: input.note ?? null,
        totalCost,
        createdBy: userId,
        lines: { create: lines },
      },
    });
  });

  return receipt.id;
}

/**
 * Sửa phiếu khi còn `DRAFT` (contract §9, §2.5). Chuyển trạng thái có điều
 * kiện làm trước (id + storeId + status DRAFT + đúng version) để hai người
 * sửa cùng lúc không đè lên nhau; chỉ khi đó mới thay dữ liệu. Không gửi
 * `lines` thì giữ nguyên các dòng cũ.
 */
export async function updateDraft(
  storeId: string,
  receiptId: string,
  input: PatchReceiptInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Kiểm tra và quy đổi dòng mới trước, để lỗi dữ liệu dừng sớm, chưa
    // đụng gì tới phiếu.
    const lines = input.lines ? await resolveLines(tx, input.lines) : null;
    const totalCost = lines ? lines.reduce((sum, line) => sum + line.lineCost, 0n) : undefined;

    const moved = await tx.goodsReceipt.updateMany({
      where: { id: receiptId, storeId, status: "DRAFT", version: input.version },
      data: {
        ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
        ...(input.supplierInvoiceNumber !== undefined
          ? { supplierInvoiceNumber: input.supplierInvoiceNumber }
          : {}),
        ...(input.supplierInvoiceDate !== undefined
          ? { supplierInvoiceDate: input.supplierInvoiceDate }
          : {}),
        ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(totalCost !== undefined ? { totalCost } : {}),
        version: { increment: 1 },
      },
    });

    if (moved.count === 0) {
      const existing = await tx.goodsReceipt.findFirst({ where: { id: receiptId, storeId } });
      if (!existing) throw AppError.notFound("Không tìm thấy phiếu nhập");
      if (existing.status !== "DRAFT") {
        throw new AppError(
          409,
          "INVALID_STATE",
          `Phiếu đang ở trạng thái ${existing.status}, chỉ sửa được phiếu còn nháp`,
        );
      }
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "Phiếu đã được người khác sửa, hãy tải lại rồi thử lại",
      );
    }

    if (lines) {
      await tx.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: receiptId } });
      await tx.goodsReceiptLine.createMany({
        data: lines.map((line) => ({ ...line, goodsReceiptId: receiptId })),
      });
    }
  });
}

/**
 * Xác nhận phiếu nhập: đây là chỗ xử lý vấn đề Critical C1.
 *
 * Toàn bộ nằm trong một transaction, và bước đầu tiên là chuyển trạng thái
 * có điều kiện. Hai người bấm xác nhận cùng lúc thì người thứ hai không tìm
 * thấy phiếu ở trạng thái DRAFT nữa nên bị chặn, tồn chỉ cộng đúng một lần.
 *
 * Kiểm nhập cảm quan (thực hành GPP): mỗi dòng phải có kết quả đạt/không đạt
 * do người xác nhận (dược sĩ phụ trách) ghi nhận. Dòng đạt vào lô AVAILABLE
 * như trước; dòng không đạt vào thẳng lô QUARANTINED — không có khoảnh khắc
 * nào hàng có vấn đề ở trạng thái bán được. Lô đã tồn tại mà lần nhập này
 * không đạt thì cả lô chuyển biệt trữ, vì cùng số lô sản xuất nên vấn đề
 * chất lượng phải coi là ảnh hưởng toàn bộ, không tách riêng phần mới.
 */
export async function confirm(
  storeId: string,
  receiptId: string,
  userId: string,
  input: ConfirmReceiptInput,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const moved = await tx.goodsReceipt.updateMany({
        where: { id: receiptId, storeId, status: "DRAFT" },
        data: { status: "CONFIRMED", confirmedBy: userId, confirmedAt: new Date() },
      });

      if (moved.count === 0) {
        const existing = await tx.goodsReceipt.findFirst({ where: { id: receiptId, storeId } });
        if (!existing) throw AppError.notFound("Không tìm thấy phiếu nhập");
        throw new AppError(
          409,
          "INVALID_STATE",
          `Phiếu đang ở trạng thái ${existing.status}, không xác nhận lại được`,
        );
      }

      const lines = await tx.goodsReceiptLine.findMany({
        where: { goodsReceiptId: receiptId },
        orderBy: { lineNo: "asc" },
      });

      const resultByLineId = new Map(input.lines.map((line) => [line.lineId, line]));
      for (const line of lines) {
        if (!resultByLineId.has(line.id)) {
          throw AppError.validation(`Thiếu kết quả kiểm nhập cho dòng ${line.lineNo}`);
        }
      }
      if (resultByLineId.size !== lines.length) {
        throw AppError.validation("Kết quả kiểm nhập có dòng không thuộc phiếu này");
      }

      for (const line of lines) {
        const result = resultByLineId.get(line.id)!;

        const existing = await tx.batch.findUnique({
          where: {
            storeId_productId_batchNumber: {
              storeId,
              productId: line.productId,
              batchNumber: line.batchNumber,
            },
          },
        });

        let batchId: string;
        let balanceAfter: number;

        if (existing) {
          // Cùng số lô mà khác hạn dùng nghĩa là nhập sai dữ liệu: dừng cả phiếu.
          if (existing.expiryDate.getTime() !== line.expiryDate.getTime()) {
            throw new AppError(
              409,
              "BATCH_EXPIRY_MISMATCH",
              `Lô ${line.batchNumber} đã tồn tại với hạn dùng khác, kiểm tra lại số lô và hạn dùng`,
            );
          }
          if (existing.status === "RECALLED") {
            throw new AppError(
              422,
              "BATCH_NOT_SELLABLE",
              `Lô ${line.batchNumber} đang bị thu hồi, không nhập thêm được`,
            );
          }

          const updated = await tx.batch.update({
            where: { id: existing.id },
            data: {
              quantityOnHand: { increment: line.baseQuantity },
              // Không đạt thì biệt trữ ngay; đã biệt trữ từ trước thì giữ
              // nguyên, không tự mở lại chỉ vì đợt nhập này đạt kiểm nhập.
              ...(result.passed ? {} : { status: "QUARANTINED", note: result.rejectReason }),
            },
          });
          batchId = updated.id;
          balanceAfter = updated.quantityOnHand;
        } else {
          const created = await tx.batch.create({
            data: {
              storeId,
              productId: line.productId,
              batchNumber: line.batchNumber,
              manufactureDate: line.manufactureDate,
              expiryDate: line.expiryDate,
              quantityOnHand: line.baseQuantity,
              unitCost: (Number(line.lineCost) / line.baseQuantity).toFixed(4),
              status: result.passed ? "AVAILABLE" : "QUARANTINED",
              note: result.passed ? null : result.rejectReason,
              sourceType: "GOODS_RECEIPT",
              sourceId: receiptId,
            },
          });
          batchId = created.id;
          balanceAfter = created.quantityOnHand;
        }

        await tx.goodsReceiptLine.update({ where: { id: line.id }, data: { batchId } });

        await tx.stockMovement.create({
          data: {
            storeId,
            batchId,
            productId: line.productId,
            type: "RECEIPT",
            baseQuantity: line.baseQuantity,
            balanceAfter,
            sourceType: "GOODS_RECEIPT",
            sourceId: receiptId,
            sourceLineId: line.id,
            userId,
          },
        });

        if (!result.passed) {
          await tx.auditLog.create({
            data: {
              storeId,
              actorId: userId,
              action: "GOODS_RECEIPT_LINE_REJECTED",
              resourceType: "batch",
              resourceId: batchId,
              reason: result.rejectReason,
              after: { batchNumber: line.batchNumber, baseQuantity: line.baseQuantity },
            },
          });
        }
      }
    },
    { timeout: 20_000 },
  );
}

export async function cancel(
  storeId: string,
  receiptId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const result = await prisma.goodsReceipt.updateMany({
    where: { id: receiptId, storeId, status: "DRAFT" },
    data: {
      status: "CANCELLED",
      cancelledBy: userId,
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  });

  if (result.count === 0) {
    const existing = await prisma.goodsReceipt.findFirst({ where: { id: receiptId, storeId } });
    if (!existing) throw AppError.notFound("Không tìm thấy phiếu nhập");
    throw new AppError(
      409,
      "INVALID_STATE",
      `Phiếu đang ở trạng thái ${existing.status}, chỉ hủy được phiếu còn nháp`,
    );
  }
}

/** Chi tiết phiếu, kèm tên sản phẩm và đơn vị để in ra đọc được. */
export async function getDetail(storeId: string, receiptId: string) {
  const receipt = await prisma.goodsReceipt.findFirst({
    where: { id: receiptId, storeId },
    include: {
      supplier: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          product: { select: { code: true, name: true } },
          productUnit: { select: { name: true, conversionToBase: true } },
        },
      },
    },
  });

  if (!receipt) throw AppError.notFound("Không tìm thấy phiếu nhập");

  return {
    id: receipt.id,
    code: receipt.code,
    type: receipt.type,
    status: receipt.status,
    supplier: receipt.supplier,
    supplierInvoiceNumber: receipt.supplierInvoiceNumber,
    supplierInvoiceDate: receipt.supplierInvoiceDate,
    receivedAt: receipt.receivedAt,
    note: receipt.note,
    totalCost: receipt.totalCost,
    version: receipt.version,
    confirmedAt: receipt.confirmedAt,
    cancelledAt: receipt.cancelledAt,
    cancelReason: receipt.cancelReason,
    lines: receipt.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      productId: line.productId,
      productCode: line.product.code,
      productName: line.product.name,
      unitId: line.productUnitId,
      unitName: line.productUnit.name,
      conversionToBase: line.productUnit.conversionToBase,
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      unitCost: line.unitCost,
      lineCost: line.lineCost,
      batchNumber: line.batchNumber,
      manufactureDate: line.manufactureDate,
      expiryDate: line.expiryDate,
      batchId: line.batchId,
    })),
  };
}
