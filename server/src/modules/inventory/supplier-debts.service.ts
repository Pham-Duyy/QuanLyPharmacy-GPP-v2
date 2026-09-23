import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { businessDateNow } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";

type Tx = Prisma.TransactionClient;

/**
 * Công nợ nhà cung cấp.
 *
 * Mỗi phiếu nhập **đã kiểm nhập** là một khoản phải trả; tiền trả được phân
 * bổ về từng phiếu nên luôn biết phiếu nào còn nợ bao nhiêu. Phiếu chi ghi
 * nhầm thì hủy có lý do chứ không xóa, để đối chiếu sổ sách về sau.
 */

const num = (value: bigint | null | undefined) => Number(value ?? 0n);

export type ReceiptDebt = {
  goodsReceiptId: string;
  code: string;
  receivedAt: Date;
  supplierInvoiceNumber: string | null;
  totalCost: number;
  paidAmount: number;
  /** Giá trị hàng đã trả lại nhà cung cấp và được trừ vào chính phiếu này. */
  returnCredit: number;
  outstanding: number;
  dueDate: Date | null;
  /** Số ngày quá hạn; 0 hoặc âm nghĩa là chưa tới hạn. */
  overdueDays: number;
};

export type SupplierDebt = {
  supplierId: string;
  name: string;
  phone: string | null;
  paymentTermDays: number;
  /** Tổng giá trị các phiếu đang liệt kê (mặc định chỉ phiếu còn nợ). */
  totalCost: number;
  /** Đã trả trên chính các phiếu đang liệt kê, không phải tổng đã trả từ trước tới nay. */
  paidAmount: number;
  outstanding: number;
  overdueAmount: number;
  dueSoonAmount: number;
  receipts: ReceiptDebt[];
  oldestDueDate: Date | null;
};

export type DebtQuery = { supplierId?: string | undefined; onlyOutstanding: boolean; dueSoonDays: number };

export async function listDebts(storeId: string, query: DebtQuery) {
  const today = businessDateNow();
  const dueSoonLimit = new Date(today.getTime() + query.dueSoonDays * 86_400_000);

  const receipts = await prisma.goodsReceipt.findMany({
    where: {
      storeId,
      type: "PURCHASE",
      status: "CONFIRMED",
      supplierId: query.supplierId ? query.supplierId : { not: null },
    },
    orderBy: { receivedAt: "asc" },
    include: {
      supplier: { select: { id: true, name: true, phone: true, paymentTermDays: true } },
      paymentAllocations: { where: { payment: { status: "ACTIVE" } }, select: { amount: true } },
      // Hàng đã trả lại và chọn tất toán bằng cách trừ công nợ.
      supplierReturnLines: { where: { supplierReturn: { status: "CONFIRMED", settlement: "DEDUCT_DEBT" } }, select: { lineValue: true } },
    },
  });

  const bySupplier = new Map<string, SupplierDebt>();
  for (const receipt of receipts) {
    if (!receipt.supplier) continue;
    const paidAmount = receipt.paymentAllocations.reduce((sum, item) => sum + num(item.amount), 0);
    const returnCredit = receipt.supplierReturnLines.reduce((sum, item) => sum + num(item.lineValue), 0);
    const outstanding = Math.max(0, num(receipt.totalCost) - paidAmount - returnCredit);
    if (query.onlyOutstanding && outstanding <= 0) continue;

    const overdueDays = receipt.paymentDueDate && outstanding > 0 ? Math.floor((today.getTime() - receipt.paymentDueDate.getTime()) / 86_400_000) : 0;

    const entry = bySupplier.get(receipt.supplier.id) ?? {
      supplierId: receipt.supplier.id,
      name: receipt.supplier.name,
      phone: receipt.supplier.phone,
      paymentTermDays: receipt.supplier.paymentTermDays,
      totalCost: 0,
      paidAmount: 0,
      outstanding: 0,
      overdueAmount: 0,
      dueSoonAmount: 0,
      receipts: [],
      oldestDueDate: null,
    };

    entry.totalCost += num(receipt.totalCost);
    entry.paidAmount += paidAmount;
    entry.outstanding += outstanding;
    if (outstanding > 0 && receipt.paymentDueDate) {
      if (receipt.paymentDueDate.getTime() < today.getTime()) entry.overdueAmount += outstanding;
      else if (receipt.paymentDueDate.getTime() <= dueSoonLimit.getTime()) entry.dueSoonAmount += outstanding;
      if (!entry.oldestDueDate || receipt.paymentDueDate.getTime() < entry.oldestDueDate.getTime()) entry.oldestDueDate = receipt.paymentDueDate;
    }
    entry.receipts.push({
      goodsReceiptId: receipt.id,
      code: receipt.code,
      receivedAt: receipt.receivedAt,
      supplierInvoiceNumber: receipt.supplierInvoiceNumber,
      totalCost: num(receipt.totalCost),
      paidAmount,
      returnCredit,
      outstanding,
      dueDate: receipt.paymentDueDate,
      overdueDays: Math.max(0, overdueDays),
    });
    bySupplier.set(receipt.supplier.id, entry);
  }

  const items = [...bySupplier.values()].sort((a, b) => b.overdueAmount - a.overdueAmount || b.outstanding - a.outstanding || a.name.localeCompare(b.name, "vi"));
  return {
    items,
    summary: {
      suppliers: items.length,
      outstanding: items.reduce((sum, item) => sum + item.outstanding, 0),
      overdueAmount: items.reduce((sum, item) => sum + item.overdueAmount, 0),
      dueSoonAmount: items.reduce((sum, item) => sum + item.dueSoonAmount, 0),
      overdueSuppliers: items.filter((item) => item.overdueAmount > 0).length,
    },
  };
}

async function nextPaymentCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).replace(/-/g, "");
  const prefix = `TT-${storeCode}-${day}-`;
  const countToday = await tx.supplierPayment.count({ where: { storeId, code: { startsWith: prefix } } });
  return `${prefix}${String(countToday + 1).padStart(4, "0")}`;
}

export type PaymentInput = {
  supplierId: string;
  paidAt: Date;
  method: "CASH" | "BANK_TRANSFER";
  reference?: string | null;
  note?: string | null;
  allocations: Array<{ goodsReceiptId: string; amount: number }>;
};

/**
 * Ghi nhận một lần trả tiền. Số tiền phiếu chi bằng tổng phân bổ, và mỗi
 * phần phân bổ không vượt quá số còn nợ của phiếu nhập đó — tính lại ngay
 * trong giao dịch để hai người cùng ghi không làm trả dư.
 */
export async function createPayment(storeId: string, auth: AuthContext, input: PaymentInput): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw AppError.notFound("Không tìm thấy nhà cung cấp");

  return prisma.$transaction(async (tx) => {
    const receipts = await tx.goodsReceipt.findMany({
      where: { id: { in: input.allocations.map((item) => item.goodsReceiptId) }, storeId, supplierId: input.supplierId, status: "CONFIRMED", type: "PURCHASE" },
      include: {
        paymentAllocations: { where: { payment: { status: "ACTIVE" } }, select: { amount: true } },
        supplierReturnLines: { where: { supplierReturn: { status: "CONFIRMED", settlement: "DEDUCT_DEBT" } }, select: { lineValue: true } },
      },
    });
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));

    let total = 0;
    for (const allocation of input.allocations) {
      const receipt = byId.get(allocation.goodsReceiptId);
      if (!receipt) throw AppError.validation("Có phiếu nhập không thuộc nhà cung cấp này hoặc chưa kiểm nhập");
      const paid = receipt.paymentAllocations.reduce((sum, item) => sum + num(item.amount), 0);
      const credited = receipt.supplierReturnLines.reduce((sum, item) => sum + num(item.lineValue), 0);
      const outstanding = Math.max(0, num(receipt.totalCost) - paid - credited);
      if (allocation.amount > outstanding) {
        throw AppError.validation(`Phiếu ${receipt.code} chỉ còn nợ ${outstanding.toLocaleString("vi-VN")} đ, không trả ${allocation.amount.toLocaleString("vi-VN")} đ được`);
      }
      total += allocation.amount;
    }

    const payment = await tx.supplierPayment.create({
      data: {
        storeId,
        supplierId: input.supplierId,
        code: await nextPaymentCode(tx, storeId, store.code),
        paidAt: input.paidAt,
        amount: BigInt(total),
        method: input.method,
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdBy: auth.userId,
        allocations: { create: input.allocations.map((item) => ({ goodsReceiptId: item.goodsReceiptId, amount: BigInt(item.amount) })) },
      },
    });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "SUPPLIER_PAYMENT_CREATE",
        resourceType: "supplier_payment",
        resourceId: payment.id,
        after: { code: payment.code, supplier: supplier.name, amount: total, method: input.method, receipts: input.allocations.length },
      },
    });
    return payment.id;
  });
}

export async function voidPayment(storeId: string, paymentId: string, auth: AuthContext, reason: string): Promise<void> {
  const payment = await prisma.supplierPayment.findFirst({ where: { id: paymentId, storeId } });
  if (!payment) throw AppError.notFound("Không tìm thấy phiếu chi");
  if (payment.status !== "ACTIVE") throw AppError.invalidState("Phiếu chi này đã hủy rồi");

  await prisma.$transaction(async (tx) => {
    await tx.supplierPayment.update({
      where: { id: paymentId },
      data: { status: "VOIDED", voidReason: reason, voidedBy: auth.userId, voidedAt: new Date(), version: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "SUPPLIER_PAYMENT_VOID",
        resourceType: "supplier_payment",
        resourceId: paymentId,
        reason,
        before: { code: payment.code, amount: num(payment.amount) },
      },
    });
  });
}

export async function listPayments(storeId: string, query: { supplierId?: string | undefined; from?: Date | undefined; to?: Date | undefined }) {
  const payments = await prisma.supplierPayment.findMany({
    where: {
      storeId,
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.from || query.to ? { paidAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      supplier: { select: { id: true, name: true } },
      createdByUser: { select: { fullName: true } },
      voidedByUser: { select: { fullName: true } },
      allocations: { include: { goodsReceipt: { select: { id: true, code: true } } } },
    },
  });

  return payments.map((payment) => ({
    id: payment.id,
    code: payment.code,
    paidAt: payment.paidAt,
    supplier: payment.supplier,
    amount: num(payment.amount),
    method: payment.method,
    reference: payment.reference,
    note: payment.note,
    status: payment.status,
    voidReason: payment.voidReason,
    voidedByName: payment.voidedByUser?.fullName ?? null,
    createdByName: payment.createdByUser.fullName,
    allocations: payment.allocations.map((item) => ({ goodsReceiptId: item.goodsReceiptId, code: item.goodsReceipt.code, amount: num(item.amount) })),
  }));
}

/** Kỳ hạn thanh toán của nhà cung cấp; đổi ở đây chỉ áp dụng cho phiếu nhập kiểm nhập sau này. */
export async function setPaymentTerm(supplierId: string, days: number, auth: AuthContext, storeId: string): Promise<void> {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw AppError.notFound("Không tìm thấy nhà cung cấp");

  await prisma.$transaction(async (tx) => {
    await tx.supplier.update({ where: { id: supplierId }, data: { paymentTermDays: days, version: { increment: 1 } } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "SUPPLIER_TERM_UPDATE",
        resourceType: "supplier",
        resourceId: supplierId,
        before: { paymentTermDays: supplier.paymentTermDays },
        after: { paymentTermDays: days },
      },
    });
  });
}
