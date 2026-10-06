import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { markIdempotentResource } from "../../lib/idempotency-context.js";
import { lockStockTransfer } from "../../lib/locks.js";
import { businessDateNow } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import { addToBatch, insertBatchIfAbsent, readBatchByNumber } from "./batch-value.js";

type Tx = Prisma.TransactionClient;

/**
 * Chuyển hàng giữa hai cửa hàng trong chuỗi (contract §10.9).
 *
 * Mỗi cửa hàng là một cơ sở có kho riêng, nên chuyển hàng là **xuất ở kho gửi
 * rồi nhập ở kho nhận**, do hai người ở hai nơi làm:
 *
 *   DRAFT ──xuất──▶ IN_TRANSIT ──nhận, kiểm nhập──▶ RECEIVED
 *     │                 │
 *     └──hủy──▶ CANCELLED ◀──thu hồi phiếu (trả tồn về lô cũ)
 *
 * Hàng đang trên đường không thuộc tồn của cửa hàng nào; phiếu là nơi duy nhất
 * giữ số hàng đó. Cửa hàng nhận ghi số **thực nhận**: phần thiếu là hao hụt khi
 * chuyển, không cộng trả lại cửa hàng gửi vì hàng không còn nữa.
 *
 * Không chuyển: lô thu hồi, lô biệt trữ, lô hết hạn và thuốc kiểm soát đặc
 * biệt (quy định chuyển giao giữa các cơ sở bán lẻ chưa được đối chiếu).
 */

export type TransferLineInput = { batchId: string; unitId: string; quantity: number };
export type CreateTransferInput = {
  toStoreId: string;
  note: string | null;
  lines: TransferLineInput[];
};
export type ReceiveLineInput = {
  lineId: string;
  receivedBaseQuantity: number;
  passed: boolean;
  rejectReason?: string | null | undefined;
};

const num = (value: bigint | null | undefined) => Number(value ?? 0n);

function lineValue(unitCost: Prisma.Decimal | null, baseQuantity: number): bigint {
  if (unitCost === null) return 0n;
  return BigInt(unitCost.mul(baseQuantity).toDecimalPlaces(0).toFixed(0));
}

/** Lý do một lô không chuyển được, hoặc `null` nếu chuyển được. */
function blockReason(
  batch: {
    batchNumber: string;
    status: string;
    expiryDate: Date;
    product: { drugClass: string | null };
  },
  today: Date,
): string | null {
  if (batch.product.drugClass === "CONTROLLED") {
    return `Lô ${batch.batchNumber} là thuốc kiểm soát đặc biệt, chưa hỗ trợ chuyển giữa các cửa hàng`;
  }
  if (batch.status === "RECALLED")
    return `Lô ${batch.batchNumber} đang bị thu hồi, không chuyển được`;
  if (batch.status === "QUARANTINED")
    return `Lô ${batch.batchNumber} đang biệt trữ, không chuyển được`;
  if (batch.expiryDate < today) return `Lô ${batch.batchNumber} đã hết hạn, không chuyển được`;
  return null;
}

/** Cửa hàng nhận: mọi cửa hàng đang hoạt động khác cửa hàng hiện tại. */
export async function listDestinations(storeId: string) {
  return prisma.store.findMany({
    where: { isActive: true, id: { not: storeId } },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, address: true },
  });
}

/** Lô còn tồn chuyển được, theo hạn dùng gần nhất trước (FEFO). */
export async function listTransferable(storeId: string, search: string | undefined) {
  const today = businessDateNow();
  const batches = await prisma.batch.findMany({
    where: {
      storeId,
      status: "AVAILABLE",
      quantityOnHand: { gt: 0 },
      expiryDate: { gte: today },
      product: {
        OR: [{ drugClass: null }, { drugClass: { not: "CONTROLLED" } }],
        ...(search
          ? {
              AND: [
                {
                  OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { code: { contains: search, mode: "insensitive" } },
                  ],
                },
              ],
            }
          : {}),
      },
    },
    orderBy: [{ expiryDate: "asc" }, { batchNumber: "asc" }],
    take: 300,
    include: {
      product: {
        select: {
          id: true,
          code: true,
          name: true,
          units: {
            where: { isActive: true },
            select: { id: true, name: true, conversionToBase: true },
            orderBy: { conversionToBase: "asc" },
          },
        },
      },
    },
  });

  return batches.map((batch) => ({
    batchId: batch.id,
    productId: batch.product.id,
    productCode: batch.product.code,
    productName: batch.product.name,
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate,
    quantityOnHand: batch.quantityOnHand,
    units: batch.product.units,
  }));
}

export async function createDraft(
  storeId: string,
  auth: AuthContext,
  input: CreateTransferInput,
): Promise<string> {
  if (input.toStoreId === storeId) {
    throw AppError.validation("Cửa hàng nhận phải khác cửa hàng đang chuyển đi");
  }
  const [store, destination] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: storeId } }),
    prisma.store.findUnique({ where: { id: input.toStoreId } }),
  ]);
  if (!destination || !destination.isActive)
    throw AppError.notFound("Không tìm thấy cửa hàng nhận");

  const batchIds = input.lines.map((line) => line.batchId);
  if (new Set(batchIds).size !== batchIds.length) {
    throw AppError.validation("Mỗi lô chỉ ghi một dòng trên phiếu chuyển");
  }

  return prisma.$transaction(async (tx) => {
    const today = businessDateNow();
    const batches = await tx.batch.findMany({
      where: { id: { in: batchIds }, storeId },
      include: {
        product: {
          select: {
            drugClass: true,
            units: {
              where: { isActive: true },
              select: { id: true, productId: true, conversionToBase: true },
            },
          },
        },
      },
    });
    const byId = new Map(batches.map((batch) => [batch.id, batch]));

    const lines = input.lines.map((line, index) => {
      const batch = byId.get(line.batchId);
      if (!batch)
        throw AppError.notFound(`Dòng ${index + 1}: không tìm thấy lô trong kho cửa hàng`);
      const blocked = blockReason(batch, today);
      if (blocked)
        throw new AppError(422, "BATCH_NOT_TRANSFERABLE", `Dòng ${index + 1}: ${blocked}`);
      const unit = batch.product.units.find((item) => item.id === line.unitId);
      if (!unit)
        throw new AppError(
          422,
          "UNIT_NOT_IN_PRODUCT",
          `Dòng ${index + 1}: đơn vị không thuộc sản phẩm của lô`,
        );
      const baseQuantity = line.quantity * unit.conversionToBase;
      if (baseQuantity > batch.quantityOnHand) {
        throw new AppError(
          409,
          "INSUFFICIENT_STOCK",
          `Dòng ${index + 1}: lô ${batch.batchNumber} chỉ còn ${batch.quantityOnHand}, không chuyển ${baseQuantity} được`,
        );
      }
      return {
        lineNo: index + 1,
        sourceBatchId: batch.id,
        productId: batch.productId,
        productUnitId: unit.id,
        quantity: line.quantity,
        baseQuantity,
        batchNumber: batch.batchNumber,
        manufactureDate: batch.manufactureDate,
        expiryDate: batch.expiryDate,
        unitCost: batch.unitCost,
      };
    });

    const created = await tx.stockTransfer.create({
      data: {
        code: await nextDocumentCode(tx, storeId, `CK-${store.code}-${codeDay()}-`),
        fromStoreId: storeId,
        toStoreId: input.toStoreId,
        note: input.note,
        totalValue: lines.reduce(
          (sum, line) => sum + lineValue(line.unitCost, line.baseQuantity),
          0n,
        ),
        createdBy: auth.userId,
        lines: { create: lines },
      },
    });
    await markIdempotentResource(tx, "stock_transfer", created.id);
    return created.id;
  });
}

/**
 * Xác nhận xuất: trừ tồn từng lô và ghi thẻ kho. Từ lúc này hàng ở trên đường.
 * Điều kiện tồn, trạng thái và hạn dùng nằm ngay trong lệnh UPDATE nên được
 * xét dưới khóa hàng: một quầy vừa bán lô cuối thì lệnh xuất không trừ âm.
 */
export async function ship(storeId: string, transferId: string, auth: AuthContext): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await lockStockTransfer(tx, transferId);
      const existing = await tx.stockTransfer.findFirst({
        where: { id: transferId, fromStoreId: storeId },
        include: { lines: { include: { product: { select: { drugClass: true } } } } },
      });
      if (!existing) throw AppError.notFound("Không tìm thấy phiếu chuyển hàng");
      if (existing.status !== "DRAFT") {
        throw AppError.invalidState(
          `Phiếu đang ở trạng thái ${existing.status}, không xuất lại được`,
        );
      }

      const today = businessDateNow();
      let totalValue = 0n;
      // Khóa lô theo cùng một thứ tự ở mọi luồng để không khóa chéo nhau.
      const ordered = [...existing.lines].sort((a, b) =>
        a.sourceBatchId.localeCompare(b.sourceBatchId),
      );
      for (const line of ordered) {
        if (line.product.drugClass === "CONTROLLED") {
          throw new AppError(
            422,
            "BATCH_NOT_TRANSFERABLE",
            `Lô ${line.batchNumber} là thuốc kiểm soát đặc biệt, chưa hỗ trợ chuyển giữa các cửa hàng`,
          );
        }
        const rows = await tx.$queryRaw<
          Array<{ quantity_on_hand: number; unit_cost: Prisma.Decimal | null }>
        >(Prisma.sql`
          UPDATE batches SET quantity_on_hand = quantity_on_hand - ${line.baseQuantity}, updated_at = now()
          WHERE id = ${line.sourceBatchId}::uuid
            AND store_id = ${storeId}::uuid
            AND status = 'AVAILABLE'
            AND expiry_date >= ${today}::date
            AND quantity_on_hand >= ${line.baseQuantity}
          RETURNING quantity_on_hand, unit_cost
        `);
        const updated = rows[0];
        if (!updated) {
          const batch = await tx.batch.findUniqueOrThrow({
            where: { id: line.sourceBatchId },
            include: { product: { select: { drugClass: true } } },
          });
          const blocked = blockReason(batch, today);
          if (blocked) throw new AppError(422, "BATCH_NOT_TRANSFERABLE", blocked);
          throw new AppError(
            409,
            "INSUFFICIENT_STOCK",
            `Lô ${batch.batchNumber} chỉ còn ${batch.quantityOnHand}, không chuyển ${line.baseQuantity} được`,
          );
        }

        // Giá vốn chụp đúng lúc hàng rời kho, không phải lúc lập nháp.
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { unitCost: updated.unit_cost },
        });
        totalValue += lineValue(updated.unit_cost, line.baseQuantity);

        await tx.stockMovement.create({
          data: {
            storeId,
            batchId: line.sourceBatchId,
            productId: line.productId,
            type: "TRANSFER_OUT",
            baseQuantity: -line.baseQuantity,
            balanceAfter: updated.quantity_on_hand,
            sourceType: "STOCK_TRANSFER",
            sourceId: transferId,
            sourceLineId: line.id,
            userId: auth.userId,
            note: `Chuyển đi ${existing.code}`,
          },
        });
      }

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: "IN_TRANSIT",
          shippedBy: auth.userId,
          shippedAt: new Date(),
          totalValue,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "STOCK_TRANSFER_SHIP",
          resourceType: "stock_transfer",
          resourceId: transferId,
          after: {
            code: existing.code,
            toStoreId: existing.toStoreId,
            lines: existing.lines.length,
            totalValue: num(totalValue),
          },
        },
      });
    },
    { timeout: 20_000 },
  );
}

/** Thu hồi đang mở cho đúng mặt hàng và số lô: hàng về tới nơi cũng phải khóa ngay. */
async function openRecallFor(
  tx: Tx,
  productId: string,
  batchNumber: string,
): Promise<string | null> {
  const item = await tx.recallItem.findFirst({
    where: { productId, batchNumber, recall: { status: "OPEN" } },
    select: { recallId: true },
  });
  return item?.recallId ?? null;
}

/**
 * Nhận hàng và kiểm nhập ở cửa hàng nhận. Hàng đạt vào lô cùng số lô, hạn
 * dùng, giá vốn; hàng không đạt vào lô ở trạng thái biệt trữ (giống kiểm nhập
 * phiếu nhập). Lô đang có thông báo thu hồi thì khóa ngay khi về.
 */
export async function receive(
  storeId: string,
  transferId: string,
  auth: AuthContext,
  input: { note: string | null; lines: ReceiveLineInput[] },
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await lockStockTransfer(tx, transferId);
      const existing = await tx.stockTransfer.findFirst({
        where: { id: transferId, toStoreId: storeId },
        include: { lines: true },
      });
      if (!existing) throw AppError.notFound("Không tìm thấy phiếu chuyển hàng");
      if (existing.status !== "IN_TRANSIT") {
        throw AppError.invalidState(
          existing.status === "DRAFT"
            ? "Cửa hàng gửi chưa xác nhận xuất, chưa nhận được"
            : `Phiếu đang ở trạng thái ${existing.status}, không nhận được`,
        );
      }

      const resultByLine = new Map(input.lines.map((line) => [line.lineId, line]));
      if (
        resultByLine.size !== input.lines.length ||
        existing.lines.some((line) => !resultByLine.has(line.id))
      ) {
        throw AppError.validation("Phải ghi kết quả nhận cho đúng và đủ các dòng của phiếu");
      }
      if (input.lines.length !== existing.lines.length) {
        throw AppError.validation("Kết quả nhận có dòng không thuộc phiếu này");
      }

      const shortages: Array<{ batchNumber: string; sent: number; received: number }> = [];
      for (const line of existing.lines) {
        const result = resultByLine.get(line.id)!;
        if (result.receivedBaseQuantity > line.baseQuantity) {
          throw AppError.validation(
            `Lô ${line.batchNumber}: nhận ${result.receivedBaseQuantity} nhiều hơn số đã gửi ${line.baseQuantity}`,
          );
        }
        if (!result.passed && !result.rejectReason) {
          throw AppError.validation(`Lô ${line.batchNumber}: hàng không đạt phải ghi lý do`);
        }
        if (result.receivedBaseQuantity < line.baseQuantity) {
          shortages.push({
            batchNumber: line.batchNumber,
            sent: line.baseQuantity,
            received: result.receivedBaseQuantity,
          });
        }
      }
      if (shortages.length > 0 && !input.note) {
        throw AppError.validation("Nhận thiếu so với số đã gửi: phải ghi lý do hao hụt");
      }

      const ordered = [...existing.lines].sort(
        (a, b) =>
          a.productId.localeCompare(b.productId) || a.batchNumber.localeCompare(b.batchNumber),
      );
      for (const line of ordered) {
        const result = resultByLine.get(line.id)!;
        const received = result.receivedBaseQuantity;
        let destinationBatchId: string | null = null;

        if (received > 0) {
          const recallId = await openRecallFor(tx, line.productId, line.batchNumber);
          const status = recallId ? "RECALLED" : result.passed ? "AVAILABLE" : "QUARANTINED";
          const note = result.passed ? null : (result.rejectReason ?? null);

          let batch = await readBatchByNumber(tx, storeId, line.productId, line.batchNumber);
          let balanceAfter: number;
          if (!batch) {
            const created = await insertBatchIfAbsent(tx, {
              storeId,
              productId: line.productId,
              batchNumber: line.batchNumber,
              manufactureDate: line.manufactureDate,
              expiryDate: line.expiryDate,
              baseQuantity: received,
              unitCost: line.unitCost,
              status,
              note,
              sourceType: "STOCK_TRANSFER",
              sourceId: transferId,
            });
            if (created) {
              if (recallId)
                await tx.batch.update({ where: { id: created.id }, data: { recallId } });
              destinationBatchId = created.id;
              balanceAfter = created.quantityOnHand;
            } else {
              batch = await readBatchByNumber(tx, storeId, line.productId, line.batchNumber);
            }
          }

          if (!destinationBatchId) {
            if (!batch)
              throw AppError.invalidState(`Không khóa được lô ${line.batchNumber} để nhận hàng`);
            if (batch.expiryDate.getTime() !== line.expiryDate.getTime()) {
              throw new AppError(
                409,
                "BATCH_EXPIRY_MISMATCH",
                `Lô ${line.batchNumber} ở cửa hàng nhận có hạn dùng khác lô gửi đến; sửa thông tin lô trước khi nhận`,
              );
            }
            // Hàng thật đã về tới nơi, kể cả lô đang thu hồi: thẻ kho phải phản ánh đúng.
            const updated = await addToBatch(tx, batch.id, received, line.unitCost, {
              expectedExpiryDate: line.expiryDate,
              allowRecalled: true,
            });
            if (!updated) {
              throw new AppError(
                409,
                "BATCH_EXPIRY_MISMATCH",
                `Lô ${line.batchNumber} ở cửa hàng nhận có hạn dùng khác lô gửi đến; sửa thông tin lô trước khi nhận`,
              );
            }
            if (recallId && batch.status !== "RECALLED") {
              await tx.batch.update({
                where: { id: batch.id },
                data: { status: "RECALLED", recallId },
              });
            } else if (!result.passed && batch.status === "AVAILABLE") {
              // Không đạt thì biệt trữ cả lô; lô đã biệt trữ thì giữ nguyên.
              await tx.batch.update({
                where: { id: batch.id },
                data: { status: "QUARANTINED", note },
              });
            }
            destinationBatchId = updated.id;
            balanceAfter = updated.quantityOnHand;
          }

          await tx.stockMovement.create({
            data: {
              storeId,
              batchId: destinationBatchId,
              productId: line.productId,
              type: "TRANSFER_IN",
              baseQuantity: received,
              balanceAfter: balanceAfter!,
              sourceType: "STOCK_TRANSFER",
              sourceId: transferId,
              sourceLineId: line.id,
              userId: auth.userId,
              note: `Nhận chuyển kho ${existing.code}`,
            },
          });
        }

        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: {
            receivedBaseQuantity: received,
            passed: result.passed,
            rejectReason: result.passed ? null : (result.rejectReason ?? null),
            destinationBatchId,
          },
        });
      }

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: "RECEIVED",
          receivedBy: auth.userId,
          receivedAt: new Date(),
          receiveNote: input.note,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "STOCK_TRANSFER_RECEIVE",
          resourceType: "stock_transfer",
          resourceId: transferId,
          reason: input.note,
          after: {
            code: existing.code,
            fromStoreId: existing.fromStoreId,
            shortages,
            rejected: input.lines.filter((line) => !line.passed).length,
          },
        },
      });
    },
    { timeout: 20_000 },
  );
}

/**
 * Hủy phiếu ở cửa hàng gửi. Phiếu nháp hủy tự do; phiếu đang chuyển mà cửa
 * hàng nhận chưa nhận thì hàng về lại đúng lô cũ (kể cả lô vừa bị thu hồi —
 * hàng thật nằm ở đó). Đã nhận thì không hủy; muốn trả lại thì chuyển ngược.
 */
export async function cancel(
  storeId: string,
  transferId: string,
  auth: AuthContext,
  reason: string,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await lockStockTransfer(tx, transferId);
      const existing = await tx.stockTransfer.findFirst({
        where: { id: transferId, fromStoreId: storeId },
        include: { lines: true },
      });
      if (!existing) throw AppError.notFound("Không tìm thấy phiếu chuyển hàng");
      if (existing.status !== "DRAFT" && existing.status !== "IN_TRANSIT") {
        throw AppError.invalidState(
          existing.status === "RECEIVED"
            ? "Cửa hàng nhận đã nhận hàng, không hủy được. Muốn lấy hàng về thì lập phiếu chuyển ngược lại."
            : "Phiếu đã hủy từ trước",
        );
      }

      if (existing.status === "IN_TRANSIT") {
        const ordered = [...existing.lines].sort((a, b) =>
          a.sourceBatchId.localeCompare(b.sourceBatchId),
        );
        for (const line of ordered) {
          const updated = await addToBatch(
            tx,
            line.sourceBatchId,
            line.baseQuantity,
            line.unitCost,
            { allowRecalled: true },
          );
          if (!updated)
            throw AppError.invalidState(`Không trả được hàng về lô ${line.batchNumber}`);
          await tx.stockMovement.create({
            data: {
              storeId,
              batchId: line.sourceBatchId,
              productId: line.productId,
              type: "TRANSFER_CANCEL",
              baseQuantity: line.baseQuantity,
              balanceAfter: updated.quantityOnHand,
              sourceType: "STOCK_TRANSFER",
              sourceId: transferId,
              sourceLineId: line.id,
              userId: auth.userId,
              note: `Hủy chuyển ${existing.code}: ${reason}`.slice(0, 500),
            },
          });
        }
      }

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: "CANCELLED",
          cancelledBy: auth.userId,
          cancelledAt: new Date(),
          cancelReason: reason,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "STOCK_TRANSFER_CANCEL",
          resourceType: "stock_transfer",
          resourceId: transferId,
          reason,
          before: { code: existing.code, status: existing.status },
        },
      });
    },
    { timeout: 20_000 },
  );
}

const detailInclude = {
  fromStore: { select: { id: true, code: true, name: true, address: true } },
  toStore: { select: { id: true, code: true, name: true, address: true } },
  createdByUser: { select: { fullName: true } },
  shippedByUser: { select: { fullName: true } },
  receivedByUser: { select: { fullName: true } },
  cancelledByUser: { select: { fullName: true } },
  lines: {
    orderBy: { lineNo: "asc" },
    include: {
      product: {
        select: {
          code: true,
          name: true,
          units: { where: { conversionToBase: 1 }, select: { name: true }, take: 1 },
        },
      },
      productUnit: { select: { name: true, conversionToBase: true } },
    },
  },
} satisfies Prisma.StockTransferInclude;

type TransferRow = Prisma.StockTransferGetPayload<{ include: typeof detailInclude }>;

function toView(row: TransferRow, storeId: string, showCost: boolean) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    direction: row.fromStoreId === storeId ? ("OUT" as const) : ("IN" as const),
    fromStore: row.fromStore,
    toStore: row.toStore,
    note: row.note,
    totalValue: showCost ? num(row.totalValue) : null,
    createdAt: row.createdAt,
    createdByName: row.createdByUser.fullName,
    shippedAt: row.shippedAt,
    shippedByName: row.shippedByUser?.fullName ?? null,
    receivedAt: row.receivedAt,
    receivedByName: row.receivedByUser?.fullName ?? null,
    receiveNote: row.receiveNote,
    cancelledAt: row.cancelledAt,
    cancelledByName: row.cancelledByUser?.fullName ?? null,
    cancelReason: row.cancelReason,
    version: row.version,
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      productCode: line.product.code,
      productName: line.product.name,
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
      unitName: line.productUnit.name,
      conversionToBase: line.productUnit.conversionToBase,
      baseUnitName: line.product.units[0]?.name ?? "",
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      unitCost: showCost && line.unitCost !== null ? Math.round(Number(line.unitCost)) : null,
      receivedBaseQuantity: line.receivedBaseQuantity,
      shortageBaseQuantity:
        line.receivedBaseQuantity === null ? null : line.baseQuantity - line.receivedBaseQuantity,
      passed: line.passed,
      rejectReason: line.rejectReason,
    })),
  };
}

/** Phiếu xem được từ cả cửa hàng gửi lẫn cửa hàng nhận; nơi khác thì 404. */
export async function getDetail(storeId: string, transferId: string, auth: AuthContext) {
  const found = await prisma.stockTransfer.findFirst({
    // Nháp còn là việc riêng của cửa hàng gửi; cửa hàng nhận chỉ thấy từ lúc xuất.
    where: {
      id: transferId,
      OR: [{ fromStoreId: storeId }, { toStoreId: storeId, status: { not: "DRAFT" } }],
    },
    include: detailInclude,
  });
  if (!found) throw AppError.notFound("Không tìm thấy phiếu chuyển hàng");
  return toView(found, storeId, auth.can("stock.cost.read"));
}

/**
 * Danh sách theo chiều: OUT là phiếu cửa hàng này chuyển đi, IN là phiếu
 * chuyển đến. Phiếu nháp của cửa hàng gửi không hiện ở cửa hàng nhận.
 */
export async function list(
  storeId: string,
  auth: AuthContext,
  query: { direction: "OUT" | "IN"; status?: string | undefined },
) {
  if (query.direction === "IN" && query.status === "DRAFT") return [];
  const where: Prisma.StockTransferWhereInput =
    query.direction === "OUT"
      ? { fromStoreId: storeId, ...(query.status ? { status: query.status } : {}) }
      : { toStoreId: storeId, status: query.status ?? { not: "DRAFT" } };
  const rows = await prisma.stockTransfer.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      fromStore: { select: { id: true, code: true, name: true } },
      toStore: { select: { id: true, code: true, name: true } },
      createdByUser: { select: { fullName: true } },
      _count: { select: { lines: true } },
    },
  });
  const showCost = auth.can("stock.cost.read");
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    fromStore: row.fromStore,
    toStore: row.toStore,
    totalValue: showCost ? num(row.totalValue) : null,
    createdAt: row.createdAt,
    shippedAt: row.shippedAt,
    receivedAt: row.receivedAt,
    createdByName: row.createdByUser.fullName,
    lineCount: row._count.lines,
  }));
}

/** Số phiếu đang trên đường tới cửa hàng này, để nhắc nhận hàng. */
export async function incomingCount(storeId: string): Promise<number> {
  return prisma.stockTransfer.count({ where: { toStoreId: storeId, status: "IN_TRANSIT" } });
}
