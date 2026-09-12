import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { businessDateNow, getSetting } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import type { CreateReturnInput } from "./returns.schema.js";

type Tx = Prisma.TransactionClient;

async function nextReturnCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(new Date())
    .replace(/-/g, "");
  const prefix = `TH-${storeCode}-${day}-`;
  const countToday = await tx.return.count({ where: { storeId, code: { startsWith: prefix } } });
  return `${prefix}${String(countToday + 1).padStart(4, "0")}`;
}

/** Làm tròn nửa lên trên số nguyên đồng. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

type PlannedLine = {
  lineNo: number;
  invoiceLineId: string;
  allocationId: string;
  batchId: string;
  productId: string;
  productUnitId: string;
  quantity: number;
  baseQuantity: number;
  refundAmount: bigint;
};

/**
 * Nhận hàng khách trả (contract §15). Cả phiếu nằm trong một transaction.
 *
 * Hai điểm dễ sai nhất được xử lý ở đây: tiền hoàn luôn tính theo đơn giá và
 * giảm giá **đã lưu trên hóa đơn gốc** chứ không theo bảng giá hiện hành, và
 * hàng luôn quay về **đúng lô đã xuất** chứ không phải lô bất kỳ của sản phẩm.
 */
export async function createReturn(
  storeId: string,
  invoiceId: string,
  auth: AuthContext,
  input: CreateReturnInput,
): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  return prisma.$transaction(
    async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, storeId },
        include: {
          lines: {
            include: {
              allocations: true,
              product: { select: { id: true, name: true, drugClass: true } },
              productUnit: { select: { id: true, productId: true } },
            },
          },
        },
      });
      if (!invoice) throw AppError.notFound("Không tìm thấy hóa đơn");
      if (invoice.status !== "COMPLETED") {
        throw AppError.invalidState("Hóa đơn đã hủy, không nhận trả hàng được");
      }

      // Hạn nhận trả tính từ ngày bán (contract §15, P6).
      const windowDays = await getSetting("returnWindowDays", storeId);
      const deadline = new Date(invoice.businessDate);
      deadline.setUTCDate(deadline.getUTCDate() + windowDays);
      if (businessDateNow() > deadline) {
        throw new AppError(
          422,
          "RETURN_WINDOW_EXPIRED",
          `Chỉ nhận trả trong ${windowDays} ngày kể từ ngày bán`,
        );
      }

      // Khóa các phân bổ của hóa đơn: hai quầy nhận trả cùng lúc thì người sau
      // đọc được số đã trả mới nhất, không cộng vượt số đã xuất.
      await tx.$queryRaw(Prisma.sql`
        SELECT a.id FROM invoice_allocations a
        JOIN invoice_lines l ON l.id = a.invoice_line_id
        WHERE l.invoice_id = ${invoiceId}::uuid
        ORDER BY a.id
        FOR UPDATE OF a
      `);

      const fresh = await tx.invoiceAllocation.findMany({
        where: { invoiceLine: { invoiceId } },
      });
      const allocationById = new Map(fresh.map((item) => [item.id, item]));

      const planned: PlannedLine[] = [];
      const takenPerAllocation = new Map<string, number>();

      input.lines.forEach((line, index) => {
        const invoiceLine = invoice.lines.find((item) => item.id === line.invoiceLineId);
        if (!invoiceLine) {
          throw AppError.validation(`Dòng ${index + 1}: không thuộc hóa đơn này`);
        }

        // Thuốc kê đơn chỉ nhận trả khi có lỗi chất lượng, và hàng phải bị hủy
        // chứ không quay lại kệ bán (contract §15, P6).
        const drugClass = invoiceLine.product.drugClass;
        if (
          (drugClass === "RX" || drugClass === "CONTROLLED") &&
          (input.disposition !== "DISPOSE" || !input.reason)
        ) {
          throw new AppError(
            422,
            "RETURN_NOT_ALLOWED_FOR_RX",
            `${invoiceLine.product.name} là thuốc kê đơn: chỉ nhận trả khi hàng có lỗi chất lượng, phải chọn hủy hàng và ghi rõ lý do`,
          );
        }

        if (line.unitId !== invoiceLine.productUnitId) {
          throw new AppError(
            422,
            "UNIT_NOT_IN_PRODUCT",
            `Dòng ${index + 1}: phải trả theo đúng đơn vị đã bán`,
          );
        }

        // Dòng bán từ nhiều lô thì phải chỉ rõ lô in trên hàng khách mang trả.
        if (!line.allocationId && invoiceLine.allocations.length > 1) {
          throw AppError.validation(
            `Dòng ${index + 1}: dòng này xuất từ nhiều lô, phải chọn đúng lô cần trả`,
          );
        }

        const allocationId = line.allocationId ?? invoiceLine.allocations[0]?.id;
        const allocation = allocationId ? allocationById.get(allocationId) : undefined;
        if (!allocation || allocation.invoiceLineId !== invoiceLine.id) {
          throw AppError.validation(`Dòng ${index + 1}: lô không thuộc dòng hóa đơn đã chọn`);
        }

        const baseQuantity = line.quantity * invoiceLine.conversionToBase;
        const already =
          allocation.returnedBaseQuantity + (takenPerAllocation.get(allocation.id) ?? 0);

        if (already + baseQuantity > allocation.baseQuantity) {
          throw new AppError(
            422,
            "RETURN_QUANTITY_EXCEEDED",
            `${invoiceLine.productName}: đã xuất ${allocation.baseQuantity}, đã trả ${already}, không nhận thêm ${baseQuantity} được`,
          );
        }
        takenPerAllocation.set(
          allocation.id,
          already + baseQuantity - allocation.returnedBaseQuantity,
        );

        // Tiền hoàn theo đúng số tiền dòng đó trên hóa đơn gốc, đã trừ giảm giá.
        const refundAmount = divRound(
          invoiceLine.lineTotal * BigInt(baseQuantity),
          BigInt(invoiceLine.baseQuantity),
        );

        planned.push({
          lineNo: index + 1,
          invoiceLineId: invoiceLine.id,
          allocationId: allocation.id,
          batchId: allocation.batchId,
          productId: invoiceLine.productId,
          productUnitId: invoiceLine.productUnitId,
          quantity: line.quantity,
          baseQuantity,
          refundAmount,
        });
      });

      const refundTotal = planned.reduce((sum, line) => sum + line.refundAmount, 0n);

      const saved = await tx.return.create({
        data: {
          storeId,
          code: await nextReturnCode(tx, storeId, store.code),
          invoiceId,
          reason: input.reason ?? null,
          disposition: input.disposition,
          refundMethod: input.refundMethod,
          refundAmount: refundTotal,
          businessDate: businessDateNow(),
          createdBy: auth.userId,
        },
      });

      for (const line of planned) {
        const savedLine = await tx.returnLine.create({
          data: {
            returnId: saved.id,
            lineNo: line.lineNo,
            invoiceLineId: line.invoiceLineId,
            invoiceAllocationId: line.allocationId,
            productUnitId: line.productUnitId,
            quantity: line.quantity,
            baseQuantity: line.baseQuantity,
            refundAmount: line.refundAmount,
          },
        });

        await tx.invoiceAllocation.update({
          where: { id: line.allocationId },
          data: { returnedBaseQuantity: { increment: line.baseQuantity } },
        });

        // Hàng luôn quay về đúng lô đã xuất, kể cả khi sẽ hủy ngay sau đó: thẻ
        // kho phải phản ánh đúng đường đi thật của hàng.
        const back = await tx.batch.update({
          where: { id: line.batchId },
          data: { quantityOnHand: { increment: line.baseQuantity } },
        });

        await tx.stockMovement.create({
          data: {
            storeId,
            batchId: line.batchId,
            productId: line.productId,
            type: "CUSTOMER_RETURN",
            baseQuantity: line.baseQuantity,
            balanceAfter: back.quantityOnHand,
            sourceType: "RETURN",
            sourceId: saved.id,
            sourceLineId: savedLine.id,
            userId: auth.userId,
          },
        });

        if (input.disposition === "DISPOSE") {
          const out = await tx.batch.update({
            where: { id: line.batchId },
            data: { quantityOnHand: { decrement: line.baseQuantity } },
          });

          await tx.stockMovement.create({
            data: {
              storeId,
              batchId: line.batchId,
              productId: line.productId,
              type: "DISPOSAL",
              baseQuantity: -line.baseQuantity,
              balanceAfter: out.quantityOnHand,
              sourceType: "RETURN",
              sourceId: saved.id,
              sourceLineId: savedLine.id,
              userId: auth.userId,
              note: input.reason ?? "Hàng khách trả không đưa lại kệ bán",
            },
          });
        }
      }

      await updateReturnStatus(tx, invoiceId);
      await reduceDispensed(tx, invoice.prescriptionId, invoice.lines, planned);

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "RETURN_CREATE",
          resourceType: "return",
          resourceId: saved.id,
          reason: input.reason ?? null,
          after: { code: saved.code, refundAmount: refundTotal.toString() },
        },
      });

      return saved.id;
    },
    { timeout: 20_000 },
  );
}

/** `returnStatus` suy ra từ tổng số đã trả so với tổng đã xuất. */
async function updateReturnStatus(tx: Tx, invoiceId: string): Promise<void> {
  const allocations = await tx.invoiceAllocation.findMany({
    where: { invoiceLine: { invoiceId } },
  });
  const sold = allocations.reduce((sum, item) => sum + item.baseQuantity, 0);
  const returned = allocations.reduce((sum, item) => sum + item.returnedBaseQuantity, 0);

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { returnStatus: returned === 0 ? "NONE" : returned >= sold ? "FULL" : "PARTIAL" },
  });
}

/** Trả lại hàng thì số đã bán theo đơn thuốc phải giảm tương ứng. */
async function reduceDispensed(
  tx: Tx,
  prescriptionId: string | null,
  invoiceLines: Array<{ id: string; prescriptionItemId: string | null }>,
  planned: PlannedLine[],
): Promise<void> {
  if (!prescriptionId) return;

  const byItem = new Map<string, number>();
  for (const line of planned) {
    const itemId = invoiceLines.find((item) => item.id === line.invoiceLineId)?.prescriptionItemId;
    if (itemId) byItem.set(itemId, (byItem.get(itemId) ?? 0) + line.baseQuantity);
  }
  if (byItem.size === 0) return;

  for (const [itemId, quantity] of byItem) {
    await tx.prescriptionItem.update({
      where: { id: itemId },
      data: { dispensedBaseQuantity: { decrement: quantity } },
    });
  }

  const items = await tx.prescriptionItem.findMany({ where: { prescriptionId } });
  const anyDispensed = items.some((item) => item.dispensedBaseQuantity > 0);
  const allDispensed = items.every(
    (item) => item.dispensedBaseQuantity >= (item.baseQuantity ?? item.quantity),
  );

  await tx.prescription.update({
    where: { id: prescriptionId },
    data: {
      status: allDispensed ? "DISPENSED" : anyDispensed ? "PARTIALLY_DISPENSED" : "VERIFIED",
    },
  });
}

export async function getDetail(storeId: string, returnId: string) {
  const found = await prisma.return.findFirst({
    where: { id: returnId, storeId },
    include: {
      invoice: { select: { id: true, code: true, returnStatus: true } },
      createdByUser: { select: { id: true, fullName: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          invoiceLine: { select: { productName: true, unitName: true, unitPrice: true } },
          invoiceAllocation: {
            include: { batch: { select: { batchNumber: true, expiryDate: true } } },
          },
        },
      },
    },
  });

  if (!found) throw AppError.notFound("Không tìm thấy phiếu trả");

  return {
    id: found.id,
    code: found.code,
    invoice: found.invoice,
    reason: found.reason,
    disposition: found.disposition,
    refundMethod: found.refundMethod,
    refundAmount: found.refundAmount,
    businessDate: found.businessDate,
    createdAt: found.createdAt,
    createdBy: found.createdByUser,
    lines: found.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      productName: line.invoiceLine.productName,
      unitName: line.invoiceLine.unitName,
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      refundAmount: line.refundAmount,
      batchNumber: line.invoiceAllocation.batch.batchNumber,
      expiryDate: line.invoiceAllocation.batch.expiryDate,
    })),
  };
}
