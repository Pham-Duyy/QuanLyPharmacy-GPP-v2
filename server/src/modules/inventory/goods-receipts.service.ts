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
 * Tổng giá trị phiếu = tiền hàng − chiết khấu + thuế. Chiết khấu không vượt tiền hàng
 * (CSDL cũng có CHECK tương ứng).
 */
function receiptAmounts(goodsAmount: bigint, discount: number, vat: number) {
  const discountAmount = BigInt(discount);
  const vatAmount = BigInt(vat);
  if (discountAmount > goodsAmount) {
    throw AppError.validation("Chiết khấu phiếu không được lớn hơn tổng tiền hàng");
  }
  return { goodsAmount, discountAmount, vatAmount, totalCost: goodsAmount - discountAmount + vatAmount };
}

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
    const amounts = receiptAmounts(
      lines.reduce((sum, line) => sum + line.lineCost, 0n),
      input.discountAmount,
      input.vatAmount,
    );

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
        ...amounts,
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
    // Đổi dòng, chiết khấu hay thuế đều phải tính lại tổng; phần không gửi lấy theo phiếu hiện tại.
    const current = await tx.goodsReceipt.findFirst({
      where: { id: receiptId, storeId },
      select: { goodsAmount: true, discountAmount: true, vatAmount: true },
    });
    const amounts =
      current && (lines || input.discountAmount !== undefined || input.vatAmount !== undefined)
        ? receiptAmounts(
            lines ? lines.reduce((sum, line) => sum + line.lineCost, 0n) : current.goodsAmount,
            input.discountAmount ?? Number(current.discountAmount),
            input.vatAmount ?? Number(current.vatAmount),
          )
        : undefined;

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
        ...(amounts ?? {}),
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
      // Chiết khấu và thuế của cả hóa đơn phân bổ vào giá vốn từng dòng theo tỷ lệ thành tiền.
      const header = await tx.goodsReceipt.findUniqueOrThrow({
        where: { id: receiptId },
        select: { goodsAmount: true, totalCost: true },
      });
      const costFactor = header.goodsAmount > 0n ? Number(header.totalCost) / Number(header.goodsAmount) : 1;

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
              unitCost: ((Number(line.lineCost) * costFactor) / line.baseQuantity).toFixed(4),
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
      supplier: { select: { id: true, name: true, phone: true, address: true, taxCode: true } },
      createdByUser: { select: { id: true, fullName: true } },
      confirmedByUser: { select: { id: true, fullName: true } },
      cancelledByUser: { select: { id: true, fullName: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          product: { select: { code: true, name: true } },
          productUnit: { select: { name: true, conversionToBase: true } },
          batch: { select: { status: true } },
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
    goodsAmount: receipt.goodsAmount,
    discountAmount: receipt.discountAmount,
    vatAmount: receipt.vatAmount,
    totalCost: receipt.totalCost,
    version: receipt.version,
    createdAt: receipt.createdAt,
    createdBy: receipt.createdByUser,
    confirmedAt: receipt.confirmedAt,
    confirmedBy: receipt.confirmedByUser,
    cancelledAt: receipt.cancelledAt,
    cancelledBy: receipt.cancelledByUser,
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
      /** Trạng thái hiện tại của lô (không phải kết quả kiểm nhập lúc đó): lô có thể bị biệt trữ về sau. */
      batchStatus: line.batch?.status ?? null,
    })),
  };
}

/** Ngày đầu tháng theo giờ Việt Nam, trả về mốc UTC tương ứng. */
function vnMonthStart(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1) - 7 * 60 * 60 * 1000);
}

/**
 * Số liệu đầu trang Nhập hàng: phiếu nháp đang chờ, phiếu đã kiểm nhập và giá trị nhập
 * trong tháng hiện tại so với tháng trước (theo ngày nhận hàng, giờ Việt Nam).
 */
export async function getSummary(storeId: string, now = new Date()) {
  const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const year = vnNow.getUTCFullYear();
  const month = vnNow.getUTCMonth();
  const thisMonthStart = vnMonthStart(year, month);
  const nextMonthStart = vnMonthStart(year, month + 1);
  const previousMonthStart = vnMonthStart(year, month - 1);

  const confirmedBetween = (from: Date, to: Date) =>
    prisma.goodsReceipt.aggregate({
      where: { storeId, status: "CONFIRMED", receivedAt: { gte: from, lt: to } },
      _count: true,
      _sum: { totalCost: true },
    });

  const [draftCount, current, previous] = await Promise.all([
    prisma.goodsReceipt.count({ where: { storeId, status: "DRAFT" } }),
    confirmedBetween(thisMonthStart, nextMonthStart),
    confirmedBetween(previousMonthStart, thisMonthStart),
  ]);

  const changePercent = (value: number, base: number) => (base === 0 ? null : Math.round(((value - base) / base) * 1000) / 10);
  const currentValue = Number(current._sum.totalCost ?? 0n);
  const previousValue = Number(previous._sum.totalCost ?? 0n);

  return {
    monthStart: thisMonthStart,
    draftCount,
    confirmedCount: current._count,
    confirmedCountChangePercent: changePercent(current._count, previous._count),
    confirmedValue: currentValue,
    confirmedValueChangePercent: changePercent(currentValue, previousValue),
  };
}
