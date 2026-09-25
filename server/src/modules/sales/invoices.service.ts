import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { markIdempotentResource } from "../../lib/idempotency-context.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { lockCustomer, lockInvoice, lockPrescriptionItems } from "../../lib/locks.js";
import { businessDateNow, getSetting } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import { getCurrentPrices } from "../catalog/products.service.js";
import * as loyalty from "../loyalty/loyalty.service.js";
import { lockSellableBatches, resolveCartLines, type ResolvedLine } from "./cart.js";
import { runSafetyCheck, type Blocking } from "./safety-check.service.js";
import type { CreateInvoiceInput } from "./sales.schema.js";

type Tx = Prisma.TransactionClient;

/** Mỗi vi phạm luật cứng ứng với một mã lỗi trong bảng ở contract §2.7. */
const BLOCKING_STATUS: Record<string, number> = {
  INSUFFICIENT_STOCK: 409,
  CONTROLLED_BUYER_REQUIRED: 422,
  PRESCRIPTION_REQUIRED: 422,
  PRESCRIPTION_NOT_VERIFIED: 422,
  PRESCRIPTION_EXPIRED: 422,
  BATCH_NOT_SELLABLE: 422,
};

function blockingToError(blocking: Blocking[]): AppError {
  const first = blocking[0]!;
  const sameCodeFirst = [
    ...blocking.filter((item) => item.code === first.code),
    ...blocking.filter((item) => item.code !== first.code),
  ];
  return new AppError(BLOCKING_STATUS[first.code] ?? 422, first.code, first.message, sameCodeFirst);
}

function requirePerm(auth: AuthContext, permission: string): void {
  if (!auth.can(permission)) {
    throw new AppError(403, "FORBIDDEN", `Bạn không có quyền ${permission}`);
  }
}

/** Chia có làm tròn nửa lên, dùng cho tiền nên phải là số nguyên đồng. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

async function nextInvoiceCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  return nextDocumentCode(tx, storeId, `HD-${storeCode}-${codeDay()}-`);
}

/** Hạn mức giảm giá cao nhất trong các vai trò của người bán (contract §6.6). */
async function discountLimitPercent(tx: Tx, userId: string, storeId: string): Promise<number> {
  const limits = await getSetting("discountLimitPercent", storeId);
  const assignments = await tx.userRole.findMany({
    where: { userId, OR: [{ storeId }, { storeId: null }] },
    include: { role: { select: { code: true } } },
  });
  return assignments.reduce((max, item) => Math.max(max, limits[item.role.code] ?? 0), 0);
}

type PricedLine = ResolvedLine & {
  unitPrice: bigint;
  vatRateBp: bigint;
  gross: bigint;
  discountAmount: bigint;
  lineTotal: bigint;
  vatAmount: bigint;
};

/**
 * Bán hàng: toàn bộ nằm trong một transaction, không gọi dịch vụ ngoài.
 * Thứ tự các bước bám theo contract §14.2 và không đảo được, vì bước sau
 * dựa vào kết quả bước trước.
 */
export async function createInvoice(
  storeId: string,
  auth: AuthContext,
  input: CreateInvoiceInput,
): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const { settings: loyaltySettings } = await loyalty.getSettings(storeId);

  return prisma.$transaction(
    async (tx) => {
      // 1-2. Sản phẩm, đơn vị và quy đổi về đơn vị nhỏ nhất (C2).
      const lines = await resolveCartLines(tx, input.lines);

      // Quyền phụ thuộc vào việc bán cái gì nên phải kiểm sau khi biết giỏ hàng.
      if (lines.some((line) => line.drugClass === "RX" || line.drugClass === "CONTROLLED")) {
        requirePerm(auth, "sale.prescription_drug");
      }
      if (input.lines.some((line) => line.batchId)) {
        requirePerm(auth, "sale.batch_override");
      }
      if (input.discount) {
        requirePerm(auth, "sale.discount");
      }

      // Khóa theo đúng thứ tự chung của toàn hệ thống (xem lib/locks.ts):
      // khách hàng → đơn thuốc → lô hàng. Khóa khách để hai hóa đơn song song
      // không cùng tiêu một số điểm; khóa dòng đơn thuốc để không cấp phát
      // vượt số đã kê.
      if (input.customerId && loyaltySettings.enabled) {
        await lockCustomer(tx, input.customerId);
      }
      if (input.prescriptionId) {
        await lockPrescriptionItems(tx, input.prescriptionId);
      }

      // 3-4. Kiểm tra an toàn tất định, chạy lại ngay trong transaction bán hàng.
      const hasControlled = lines.some((line) => line.drugClass === "CONTROLLED");
      const safety = await runSafetyCheck(tx, {
        hasControlledBuyer: Boolean(input.controlledBuyer),
        storeId,
        lines,
        customerId: input.customerId,
        prescriptionId: input.prescriptionId,
      });
      if (safety.blocking.length > 0) throw blockingToError(safety.blocking);

      const mustAck = safety.warnings.filter((warning) => warning.requiresAck);
      if (mustAck.length > 0) {
        const acknowledged = new Set(input.acknowledgedWarnings.map((item) => item.code));
        const missing = mustAck.filter((warning) => !acknowledged.has(warning.code));
        if (missing.length > 0) {
          throw new AppError(
            422,
            "SAFETY_ACK_REQUIRED",
            "Phải ghi nhận cảnh báo an toàn mức cao trước khi bán",
            missing,
          );
        }
        requirePerm(auth, "safety.ack");
      }

      // 5. Giá hiện hành theo đơn vị, ưu tiên giá riêng của cửa hàng.
      const prices = await getCurrentPrices(
        lines.map((line) => line.productUnitId),
        storeId,
        new Date(),
        tx,
      );

      const gross = lines.map((line) => {
        const price = prices.get(line.productUnitId);
        if (!price) {
          throw new AppError(
            422,
            "PRICE_NOT_SET",
            `${line.productName} (${line.unitName}) chưa có giá bán`,
          );
        }
        return {
          line,
          unitPrice: price.salePrice,
          vatRateBp: BigInt(Math.round(Number(price.vatRatePercent) * 100)),
          gross: price.salePrice * BigInt(line.quantity),
        };
      });

      const subtotal = gross.reduce((sum, item) => sum + item.gross, 0n);

      // Tiền hàng được tính điểm. Mặc định hàng thuốc nằm ngoài chương
      // trình vì Luật Dược cấm khuyến mại thuốc trực tiếp cho người dùng;
      // chủ nhà thuốc bật riêng thì mới tính (contract §16).
      const eligibleSubtotal = gross.reduce(
        (sum, item) =>
          loyalty.isEligibleProductType(item.line.productType, loyaltySettings)
            ? sum + item.gross
            : sum,
        0n,
      );

      // 6. Giảm giá: máy chủ tự tính, kiểm hạn mức theo vai trò. Điểm khách
      // đổi là tiền của chính khách nên không tính vào hạn mức của nhân viên,
      // nhưng vẫn bị chặn bởi trần phần trăm của chương trình tích điểm.
      const staffDiscount = await computeDiscount(tx, auth, storeId, input, subtotal);
      const loyaltyDiscount = await loyalty.planRedemption(tx, {
        customerId: input.customerId,
        points: input.loyaltyRedeemPoints,
        settings: loyaltySettings,
        eligibleSubtotal,
      });
      const discountAmount = staffDiscount + loyaltyDiscount;
      if (discountAmount > subtotal) {
        throw AppError.validation(
          "Giảm giá cộng với tiền đổi điểm lớn hơn giá trị hóa đơn",
        );
      }

      // Phân bổ tiền giảm về từng dòng để VAT từng dòng vẫn tính đúng.
      const priced: PricedLine[] = gross.map((item) => ({
        ...item.line,
        unitPrice: item.unitPrice,
        vatRateBp: item.vatRateBp,
        gross: item.gross,
        discountAmount: 0n,
        lineTotal: item.gross,
        vatAmount: 0n,
      }));

      let spread = 0n;
      priced.forEach((line, index) => {
        const share =
          subtotal === 0n
            ? 0n
            : index === priced.length - 1
              ? discountAmount - spread
              : (discountAmount * line.gross) / subtotal;
        spread += share;
        line.discountAmount = share;
        line.lineTotal = line.gross - share;
        // Giá niêm yết đã gồm VAT nên VAT được tách ngược ra (contract §6.5, P9).
        line.vatAmount = divRound(line.lineTotal * line.vatRateBp, 10000n + line.vatRateBp);
      });

      const totalAmount = subtotal - discountAmount;
      const vatAmount = priced.reduce((sum, line) => sum + line.vatAmount, 0n);

      const tendered =
        input.payment.amountTendered == null ? null : BigInt(input.payment.amountTendered);
      if (tendered !== null && tendered < totalAmount) {
        throw AppError.validation("Số tiền khách đưa nhỏ hơn số tiền phải trả");
      }

      // 3b. Đối chiếu đơn thuốc trước khi trừ tồn, để sai là dừng sớm.
      const { dispensed, itemByLineIndex } = await checkPrescription(tx, input, lines);

      // 7-8. Chọn lô và trừ tồn (C3).
      const allocations = await allocateBatches(tx, storeId, lines, input);

      // 10. Ghi hóa đơn. Từ đây trở đi chỉ còn thao tác ghi.
      const invoice = await tx.invoice.create({
        data: {
          storeId,
          code: await nextInvoiceCode(tx, storeId, store.code),
          customerId: input.customerId ?? null,
          prescriptionId: input.prescriptionId ?? null,
          sellerId: auth.userId,
          pharmacistId: auth.can("sale.prescription_drug") ? auth.userId : null,
          businessDate: businessDateNow(),
          subtotal,
          discountType: input.discount?.type ?? null,
          discountValue: input.discount?.value ?? null,
          discountReason: input.discount?.reason ?? null,
          discountAmount,
          loyaltyPointsRedeemed: loyaltyDiscount > 0n ? input.loyaltyRedeemPoints : 0,
          loyaltyDiscountAmount: loyaltyDiscount,
          vatAmount,
          totalAmount,
          paymentMethod: input.payment.method,
          amountTendered: tendered,
          changeAmount: tendered === null ? null : tendered - totalAmount,
        },
      });

      // Thuốc kiểm soát đặc biệt: lưu người mua ngay cùng hóa đơn, đây là
      // phần bắt buộc của sổ theo dõi (contract §10.8).
      if (hasControlled && input.controlledBuyer) {
        await tx.controlledSaleDetail.create({
          data: {
            invoiceId: invoice.id,
            buyerName: input.controlledBuyer.buyerName,
            buyerIdNumber: input.controlledBuyer.buyerIdNumber,
            buyerAddress: input.controlledBuyer.buyerAddress,
            buyerPhone: input.controlledBuyer.buyerPhone ?? null,
            relationship: input.controlledBuyer.relationship,
            relationshipNote: input.controlledBuyer.relationshipNote ?? null,
            recordedBy: auth.userId,
          },
        });
      }

      for (const line of priced) {
        const saved = await tx.invoiceLine.create({
          data: {
            invoiceId: invoice.id,
            lineNo: line.index + 1,
            productId: line.productId,
            productUnitId: line.productUnitId,
            productName: line.productName,
            unitName: line.unitName,
            conversionToBase: line.conversionToBase,
            quantity: line.quantity,
            baseQuantity: line.baseQuantity,
            unitPrice: line.unitPrice,
            vatRatePercent: new Prisma.Decimal(Number(line.vatRateBp) / 100),
            discountAmount: line.discountAmount,
            lineTotal: line.lineTotal,
            // Dòng đơn thuốc do backend khớp mới là dòng thật; máy khách có
            // thể không gửi `prescriptionItemId` nào cả.
            prescriptionItemId:
              itemByLineIndex.get(line.index) ??
              input.lines[line.index]?.prescriptionItemId ??
              null,
            batchOverrideReason: input.lines[line.index]?.batchOverrideReason ?? null,
          },
        });

        for (const allocation of allocations.get(line.index) ?? []) {
          const batch = await tx.batch.update({
            where: { id: allocation.batchId },
            data: { quantityOnHand: { decrement: allocation.baseQuantity } },
          });

          await tx.invoiceAllocation.create({
            data: {
              invoiceLineId: saved.id,
              storeId,
              batchId: allocation.batchId,
              baseQuantity: allocation.baseQuantity,
              // Chụp giá vốn ngay lúc xuất: nhập thêm cùng lô với giá khác
              // sau này không được làm đổi lãi gộp của kỳ đã qua.
              unitCost: batch.unitCost,
            },
          });

          await tx.stockMovement.create({
            data: {
              storeId,
              batchId: allocation.batchId,
              productId: line.productId,
              type: "SALE",
              baseQuantity: -allocation.baseQuantity,
              balanceAfter: batch.quantityOnHand,
              sourceType: "INVOICE",
              sourceId: invoice.id,
              sourceLineId: saved.id,
              userId: auth.userId,
            },
          });
        }
      }

      for (const ack of input.acknowledgedWarnings) {
        const warning = safety.warnings.find((item) => item.code === ack.code);
        if (!warning) continue;
        await tx.invoiceSafetyAck.create({
          data: {
            invoiceId: invoice.id,
            code: ack.code,
            severity: warning.severity,
            productIds: ack.productIds.length > 0 ? ack.productIds : warning.productIds,
            reason: ack.reason ?? null,
            acknowledgedBy: auth.userId,
          },
        });
      }

      // Sổ điểm: tích theo số tiền khách thực trả cho hàng được tính điểm,
      // và trừ phần điểm khách vừa đổi.
      if (input.customerId && loyaltySettings.enabled) {
        const earnBase = priced.reduce(
          (sum, line) =>
            loyalty.isEligibleProductType(line.productType, loyaltySettings)
              ? sum + line.lineTotal
              : sum,
          0n,
        );
        await loyalty.record(tx, {
          storeId,
          customerId: input.customerId,
          invoiceId: invoice.id,
          type: "EARN",
          points: loyalty.pointsFor(earnBase, loyaltySettings),
          amount: earnBase,
          expiresAt: loyalty.expiryFor(loyaltySettings),
          createdBy: auth.userId,
        });
      }
      if (loyaltyDiscount > 0n) {
        await loyalty.record(tx, {
          storeId,
          customerId: input.customerId!,
          invoiceId: invoice.id,
          type: "REDEEM",
          points: -input.loyaltyRedeemPoints,
          amount: loyaltyDiscount,
          createdBy: auth.userId,
        });
      }

      await applyDispensed(tx, input.prescriptionId ?? null, dispensed, 1);

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "INVOICE_CREATE",
          resourceType: "invoice",
          resourceId: invoice.id,
          after: { code: invoice.code, totalAmount: totalAmount.toString() },
        },
      });

      // Gắn chứng từ vào khóa idempotency ngay trong transaction: commit xong
      // là khóa đã mang id, gửi lại cùng khóa không tạo thêm bản thứ hai.
      await markIdempotentResource(tx, "invoice", invoice.id);
      return invoice.id;
    },
    { timeout: 20_000 },
  );
}

async function computeDiscount(
  tx: Tx,
  auth: AuthContext,
  storeId: string,
  input: CreateInvoiceInput,
  subtotal: bigint,
): Promise<bigint> {
  if (!input.discount) return 0n;

  const amount =
    input.discount.type === "PERCENT"
      ? (subtotal * BigInt(Math.round(input.discount.value * 100))) / 10000n
      : BigInt(Math.round(input.discount.value));

  if (amount > subtotal) {
    throw AppError.validation("Số tiền giảm lớn hơn giá trị hóa đơn");
  }

  const asPercent =
    input.discount.type === "PERCENT"
      ? input.discount.value
      : subtotal === 0n
        ? 0
        : (Number(amount) * 100) / Number(subtotal);

  const limit = await discountLimitPercent(tx, auth.userId, storeId);
  if (asPercent > limit && !auth.can("sale.discount.override")) {
    throw new AppError(
      422,
      "DISCOUNT_LIMIT_EXCEEDED",
      `Vai trò của bạn chỉ được giảm tối đa ${limit}%`,
    );
  }

  return amount;
}

/**
 * Đối chiếu từng dòng thuốc kê đơn với đơn thuốc, cộng dồn cả những lần bán
 * trước đó. Trả về số lượng sẽ ghi nhận cho từng dòng của đơn.
 */
async function checkPrescription(
  tx: Tx,
  input: CreateInvoiceInput,
  lines: ResolvedLine[],
): Promise<{ dispensed: Map<string, number>; itemByLineIndex: Map<number, string> }> {
  const dispensed = new Map<string, number>();
  /** Dòng giỏ hàng nào ứng với dòng nào của đơn thuốc, theo kết quả khớp thật. */
  const itemByLineIndex = new Map<number, string>();
  const rxLines = lines.filter(
    (line) => line.drugClass === "RX" || line.drugClass === "CONTROLLED",
  );
  if (rxLines.length === 0) return { dispensed, itemByLineIndex };

  const prescription = await tx.prescription.findUnique({
    where: { id: input.prescriptionId! },
    include: { items: true },
  });
  if (!prescription) throw AppError.notFound("Không tìm thấy đơn thuốc");

  const remainingOf = (item: (typeof prescription.items)[number]) =>
    (item.baseQuantity ?? item.quantity) - item.dispensedBaseQuantity - (dispensed.get(item.id) ?? 0);

  for (const line of rxLines) {
    const wanted = input.lines[line.index]?.prescriptionItemId;
    // Máy khách chỉ định dòng nào thì dùng đúng dòng đó. Không chỉ định mà đơn
    // có nhiều dòng cùng thuốc thì lấy dòng còn lại nhiều nhất, để một hóa đơn
    // nhiều dòng cùng thuốc vẫn cấp phát được hết.
    const item = wanted
      ? prescription.items.find((candidate) => candidate.id === wanted)
      : prescription.items
          .filter((candidate) => candidate.productId === line.productId)
          .sort((a, b) => remainingOf(b) - remainingOf(a))[0];

    if (!item || item.productId !== line.productId) {
      throw AppError.validation(
        `Dòng ${line.index + 1}: không khớp dòng nào trong đơn thuốc ${prescription.code}`,
      );
    }

    const prescribed = item.baseQuantity ?? item.quantity;
    const running = (dispensed.get(item.id) ?? 0) + line.baseQuantity;
    if (item.dispensedBaseQuantity + running > prescribed) {
      throw new AppError(
        422,
        "PRESCRIBED_QUANTITY_EXCEEDED",
        `${line.productName}: đơn kê ${prescribed}, đã bán ${item.dispensedBaseQuantity}, không bán thêm ${line.baseQuantity} được`,
      );
    }
    dispensed.set(item.id, running);
    itemByLineIndex.set(line.index, item.id);
  }

  return { dispensed, itemByLineIndex };
}

/** Cộng (`sign = 1`) hoặc trừ lại (`sign = -1`) số đã bán theo đơn thuốc. */
async function applyDispensed(
  tx: Tx,
  prescriptionId: string | null,
  dispensed: Map<string, number>,
  sign: 1 | -1,
): Promise<void> {
  if (!prescriptionId || dispensed.size === 0) return;

  for (const [itemId, quantity] of dispensed) {
    await tx.prescriptionItem.update({
      where: { id: itemId },
      data: { dispensedBaseQuantity: { increment: sign * quantity } },
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

type Allocation = { batchId: string; baseQuantity: number };

/**
 * Chọn lô cho từng dòng. Đây là chỗ xử lý vấn đề Critical C3: chỉ lô bán
 * được mới vào danh sách, mặc định xuất theo FEFO, và lô được khóa trước khi
 * tính nên hai quầy bán cùng lúc không thể cùng lấy một số lượng.
 */
async function allocateBatches(
  tx: Tx,
  storeId: string,
  lines: ResolvedLine[],
  input: CreateInvoiceInput,
): Promise<Map<number, Allocation[]>> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const minRemainingDays = await getSetting("minRemainingShelfLifeDays", storeId);
  const locked = await lockSellableBatches(tx, storeId, productIds, minRemainingDays);

  const fefo = [...locked].sort(
    (a, b) => a.expiryDate.getTime() - b.expiryDate.getTime() || a.id.localeCompare(b.id),
  );
  const remaining = new Map(locked.map((batch) => [batch.id, batch.quantityOnHand]));
  const result = new Map<number, Allocation[]>();

  for (const line of lines) {
    let pool = fefo.filter((batch) => batch.productId === line.productId);

    const override = input.lines[line.index]?.batchId;
    if (override) {
      const chosen = pool.find((batch) => batch.id === override);
      if (!chosen) {
        throw new AppError(
          422,
          "BATCH_NOT_SELLABLE",
          `Lô được chỉ định không bán được hoặc không thuộc ${line.productName}`,
        );
      }
      pool = [chosen];
    }

    const allocations: Allocation[] = [];
    let need = line.baseQuantity;

    for (const batch of pool) {
      if (need === 0) break;
      const available = remaining.get(batch.id) ?? 0;
      if (available <= 0) continue;
      const take = Math.min(available, need);
      remaining.set(batch.id, available - take);
      allocations.push({ batchId: batch.id, baseQuantity: take });
      need -= take;
    }

    if (need > 0) {
      throw new AppError(409, "INSUFFICIENT_STOCK", `${line.productName} không đủ tồn bán được`, [
        {
          productId: line.productId,
          requestedBaseQuantity: line.baseQuantity,
          sellableBaseQuantity: line.baseQuantity - need,
        },
      ]);
    }

    result.set(line.index, allocations);
  }

  return result;
}

/** Hủy hóa đơn: hoàn tồn về đúng các lô đã xuất (contract §14.4). */
export async function voidInvoice(
  storeId: string,
  invoiceId: string,
  auth: AuthContext,
  reason: string,
): Promise<void> {
  const { settings: loyaltySettings } = await loyalty.getSettings(storeId);

  await prisma.$transaction(
    async (tx) => {
      // Khóa hóa đơn TRƯỚC khi đọc trạng thái: nếu không, một phiếu trả hàng
      // đang chạy song song vẫn đọc được hóa đơn còn COMPLETED và cả hai cùng
      // hoàn tồn cho một lần bán.
      await lockInvoice(tx, storeId, invoiceId);

      const existing = await tx.invoice.findFirst({
        where: { id: invoiceId, storeId },
        include: { lines: { include: { allocations: true } } },
      });
      if (!existing) throw AppError.notFound("Không tìm thấy hóa đơn");

      if (existing.customerId) await lockCustomer(tx, existing.customerId);
      if (existing.prescriptionId) await lockPrescriptionItems(tx, existing.prescriptionId);

      if (existing.returnStatus !== "NONE") {
        throw AppError.invalidState("Hóa đơn đã có phiếu trả, không hủy được");
      }

      const window = await getSetting("invoiceVoidWindow", storeId);
      if (
        window === "SAME_BUSINESS_DAY" &&
        existing.businessDate.getTime() !== businessDateNow().getTime()
      ) {
        throw AppError.invalidState("Chỉ hủy được hóa đơn trong ngày bán");
      }

      const moved = await tx.invoice.updateMany({
        where: { id: invoiceId, storeId, status: "COMPLETED" },
        data: {
          status: "VOIDED",
          voidedBy: auth.userId,
          voidedAt: new Date(),
          voidReason: reason,
        },
      });
      if (moved.count === 0) {
        throw AppError.invalidState(
          `Hóa đơn đang ở trạng thái ${existing.status}, không hủy lại được`,
        );
      }

      const dispensed = new Map<string, number>();

      for (const line of existing.lines) {
        for (const allocation of line.allocations) {
          const batch = await tx.batch.update({
            where: { id: allocation.batchId },
            data: { quantityOnHand: { increment: allocation.baseQuantity } },
          });

          await tx.stockMovement.create({
            data: {
              storeId,
              batchId: allocation.batchId,
              productId: line.productId,
              type: "SALE_VOID",
              baseQuantity: allocation.baseQuantity,
              balanceAfter: batch.quantityOnHand,
              sourceType: "INVOICE",
              sourceId: invoiceId,
              sourceLineId: line.id,
              userId: auth.userId,
            },
          });
        }

        if (line.prescriptionItemId) {
          dispensed.set(
            line.prescriptionItemId,
            (dispensed.get(line.prescriptionItemId) ?? 0) + line.baseQuantity,
          );
        }
      }

      await applyDispensed(tx, existing.prescriptionId, dispensed, -1);

      // Hóa đơn không còn thì điểm tích theo nó cũng không còn, và điểm khách
      // đã đổi được trả lại nguyên vẹn.
      await loyalty.reverseInvoice(tx, {
        storeId,
        invoiceId,
        settings: loyaltySettings,
        userId: auth.userId,
        note: `Hủy hóa đơn: ${reason}`,
      });

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "INVOICE_VOID",
          resourceType: "invoice",
          resourceId: invoiceId,
          reason,
        },
      });
    },
    { timeout: 20_000 },
  );
}

/** Chi tiết hóa đơn, kèm lô thực tế đã xuất (contract §14.3). */
export async function getDetail(storeId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, storeId },
    include: {
      customer: { select: { id: true, fullName: true, phone: true } },
      seller: { select: { id: true, fullName: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          allocations: {
            include: { batch: { select: { batchNumber: true, expiryDate: true } } },
          },
        },
      },
      safetyAcks: true,
      loyaltyLedger: { select: { type: true, points: true } },
    },
  });

  if (!invoice) throw AppError.notFound("Không tìm thấy hóa đơn");

  return {
    id: invoice.id,
    code: invoice.code,
    status: invoice.status,
    returnStatus: invoice.returnStatus,
    customer: invoice.customer,
    prescriptionId: invoice.prescriptionId,
    seller: invoice.seller,
    soldAt: invoice.soldAt,
    businessDate: invoice.businessDate,
    subtotal: invoice.subtotal,
    discountType: invoice.discountType,
    discountValue: invoice.discountValue,
    discountReason: invoice.discountReason,
    discountAmount: invoice.discountAmount,
    loyaltyPointsRedeemed: invoice.loyaltyPointsRedeemed,
    loyaltyDiscountAmount: invoice.loyaltyDiscountAmount,
    // Điểm hóa đơn này tích được, đã trừ phần thu lại do khách trả hàng
    // hoặc do hủy hóa đơn (bút toán REVERSE mang dấu âm).
    loyaltyPointsEarned: invoice.loyaltyLedger
      .filter((row) => row.type === "EARN" || (row.type === "REVERSE" && row.points < 0))
      .reduce((sum, row) => sum + row.points, 0),
    vatAmount: invoice.vatAmount,
    totalAmount: invoice.totalAmount,
    paymentMethod: invoice.paymentMethod,
    amountTendered: invoice.amountTendered,
    changeAmount: invoice.changeAmount,
    voidedAt: invoice.voidedAt,
    voidReason: invoice.voidReason,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      productId: line.productId,
      productName: line.productName,
      unitId: line.productUnitId,
      unitName: line.unitName,
      conversionToBase: line.conversionToBase,
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      unitPrice: line.unitPrice,
      vatRatePercent: line.vatRatePercent,
      discountAmount: line.discountAmount,
      lineTotal: line.lineTotal,
      batchOverrideReason: line.batchOverrideReason,
      allocations: line.allocations.map((allocation) => ({
        id: allocation.id,
        batchId: allocation.batchId,
        batchNumber: allocation.batch.batchNumber,
        expiryDate: allocation.batch.expiryDate,
        baseQuantity: allocation.baseQuantity,
        returnedBaseQuantity: allocation.returnedBaseQuantity,
      })),
    })),
    safetyAcks: invoice.safetyAcks.map((ack) => ({
      code: ack.code,
      severity: ack.severity,
      productIds: ack.productIds,
      reason: ack.reason,
      acknowledgedAt: ack.acknowledgedAt,
    })),
  };
}
