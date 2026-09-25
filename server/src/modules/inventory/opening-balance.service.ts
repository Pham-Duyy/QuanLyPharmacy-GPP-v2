import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { markIdempotentResource } from "../../lib/idempotency-context.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import type { OpeningBalanceInput } from "./opening-balance.schema.js";

type Tx = Prisma.TransactionClient;

async function nextReceiptCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  return nextDocumentCode(tx, storeId, `PN-${storeCode}-${codeDay()}-`);
}

/**
 * Nhập tồn hiện có khi bắt đầu dùng hệ thống (contract §10.4, P3).
 *
 * Dùng lại đúng bảng `goods_receipts`/`goods_receipt_lines` với
 * `type = 'OPENING_BALANCE'` — schema đã lường trước việc này từ migration
 * đầu tiên (`goods_receipts_type_check`, `goods_receipts_supplier_required`
 * yêu cầu không có `supplierId`). Khác phiếu nhập mua hàng ở chỗ không có
 * bước nháp riêng: tạo và xác nhận trong cùng một transaction, vì đây chỉ
 * là một endpoint duy nhất, không có `/confirm`.
 */
export async function createOpeningBalance(
  storeId: string,
  userId: string,
  input: OpeningBalanceInput,
): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  return prisma.$transaction(
    async (tx) => {
      // Chỉ dùng được trước khi phát sinh hóa đơn đầu tiên của cửa hàng.
      const invoiceCount = await tx.invoice.count({ where: { storeId } });
      if (invoiceCount > 0) {
        throw new AppError(
          409,
          "INVALID_STATE",
          "Cửa hàng đã bán hàng, không nhập tồn đầu kỳ được nữa",
        );
      }

      const productIds = [...new Set(input.lines.map((line) => line.productId))];
      const units = await tx.productUnit.findMany({
        where: { id: { in: input.lines.map((line) => line.unitId) } },
        include: { product: { select: { id: true, isActive: true } } },
      });
      const unitById = new Map(units.map((unit) => [unit.id, unit]));

      const products = await tx.product.findMany({ where: { id: { in: productIds } } });
      if (products.some((product) => !product.isActive)) {
        throw AppError.validation("Không nhập được tồn đầu kỳ cho sản phẩm đã ngừng kinh doanh");
      }

      const lines = input.lines.map((line, index) => {
        const unit = unitById.get(line.unitId);
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
          expiryDate: line.expiryDate,
        };
      });

      const totalCost = lines.reduce((sum, line) => sum + line.lineCost, 0n);
      const now = new Date();

      const receipt = await tx.goodsReceipt.create({
        data: {
          storeId,
          code: await nextReceiptCode(tx, storeId, store.code),
          type: "OPENING_BALANCE",
          receivedAt: now,
          status: "CONFIRMED",
          confirmedBy: userId,
          confirmedAt: now,
          goodsAmount: totalCost,
          totalCost,
          createdBy: userId,
          lines: { create: lines },
        },
        include: { lines: true },
      });

      // Tạo lô AVAILABLE và ghi thẻ kho OPENING_BALANCE (contract §10.4).
      // Cùng logic gộp lô như phiếu nhập mua hàng (§9): cùng số lô đã có thì
      // cộng dồn thay vì tạo trùng, để hai dòng cùng số lô trong một lần
      // nhập tồn đầu kỳ không đụng ràng buộc duy nhất (store, product, lô).
      for (const line of receipt.lines) {
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
          if (existing.expiryDate.getTime() !== line.expiryDate.getTime()) {
            throw new AppError(
              409,
              "BATCH_EXPIRY_MISMATCH",
              `Lô ${line.batchNumber} đã tồn tại với hạn dùng khác, kiểm tra lại số lô và hạn dùng`,
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
              expiryDate: line.expiryDate,
              quantityOnHand: line.baseQuantity,
              unitCost: (Number(line.lineCost) / line.baseQuantity).toFixed(4),
              sourceType: "GOODS_RECEIPT",
              sourceId: receipt.id,
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
            type: "OPENING_BALANCE",
            baseQuantity: line.baseQuantity,
            balanceAfter,
            sourceType: "GOODS_RECEIPT",
            sourceId: receipt.id,
            sourceLineId: line.id,
            userId,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: userId,
          action: "OPENING_BALANCE_CREATE",
          resourceType: "goods_receipt",
          resourceId: receipt.id,
          after: { code: receipt.code, lineCount: lines.length },
        },
      });

      // Gắn chứng từ vào khóa idempotency ngay trong transaction: commit xong
      // là khóa đã mang id, gửi lại cùng khóa không tạo thêm bản thứ hai.
      await markIdempotentResource(tx, "goods_receipt", receipt.id);
      return receipt.id;
    },
    { timeout: 20_000 },
  );
}
