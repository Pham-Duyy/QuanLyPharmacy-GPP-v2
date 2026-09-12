import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type { CreateReceiptInput } from "./goods-receipts.schema.js";

type Tx = Prisma.TransactionClient;

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

  const productIds = [...new Set(input.lines.map((line) => line.productId))];
  const units = await prisma.productUnit.findMany({
    where: { id: { in: input.lines.map((line) => line.unitId) } },
    include: { product: { select: { id: true, isActive: true } } },
  });
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
  if (products.length !== productIds.length) {
    throw new AppError(422, "VALIDATION_ERROR", "Có sản phẩm không tồn tại trong danh mục");
  }
  if (products.some((product) => !product.isActive)) {
    throw new AppError(422, "VALIDATION_ERROR", "Không nhập được sản phẩm đã ngừng kinh doanh");
  }

  const lines = input.lines.map((line, index) => {
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

  const totalCost = lines.reduce((sum, line) => sum + line.lineCost, 0n);

  const receipt = await prisma.$transaction(async (tx) => {
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
 * Xác nhận phiếu nhập: đây là chỗ xử lý vấn đề Critical C1.
 *
 * Toàn bộ nằm trong một transaction, và bước đầu tiên là chuyển trạng thái
 * có điều kiện. Hai người bấm xác nhận cùng lúc thì người thứ hai không tìm
 * thấy phiếu ở trạng thái DRAFT nữa nên bị chặn, tồn chỉ cộng đúng một lần.
 */
export async function confirm(storeId: string, receiptId: string, userId: string): Promise<void> {
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

      for (const line of lines) {
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
            data: { quantityOnHand: { increment: line.baseQuantity } },
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
