import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { lockCustomer } from "../../lib/locks.js";
import type { AuthContext } from "../auth/auth.context.js";
import { loyaltySettingsSchema, type LoyaltySettings } from "./loyalty.schema.js";

type Tx = Prisma.TransactionClient;

export const LOYALTY_KEY = "loyaltySettings";

/** Chưa cấu hình thì chương trình tắt — không tự tích điểm sau lưng chủ nhà thuốc. */
export const LOYALTY_DEFAULTS: LoyaltySettings = {
  enabled: false,
  earnAmountPerPoint: 10_000,
  pointValue: 500,
  minRedeemPoints: 20,
  maxRedeemPercent: 50,
  expiryMonths: 12,
  earnOnDrugs: false,
};

/** Điểm sắp hết hạn trong bao nhiêu ngày thì nhắc khách. */
export const EXPIRING_SOON_DAYS = 30;

export type EffectiveLoyaltySettings = {
  settings: LoyaltySettings;
  isDefault: boolean;
  updatedAt: Date | null;
};

/**
 * Cài đặt đang áp dụng: ưu tiên bản riêng của cửa hàng, sau đó tới bản dùng
 * chung toàn chuỗi, cuối cùng là mặc định. Bản lưu sai định dạng (do sửa tay
 * trong CSDL) thì quay về mặc định thay vì làm hỏng quầy bán.
 */
export async function getSettings(storeId: string): Promise<EffectiveLoyaltySettings> {
  const rows = await prisma.setting.findMany({
    where: { key: LOYALTY_KEY, OR: [{ storeId }, { storeId: null }] },
  });
  const row = rows.find((item) => item.storeId !== null) ?? rows[0];
  if (!row || typeof row.value !== "object" || row.value === null) {
    return { settings: LOYALTY_DEFAULTS, isDefault: true, updatedAt: null };
  }

  const parsed = loyaltySettingsSchema.safeParse({ ...LOYALTY_DEFAULTS, ...row.value });
  if (!parsed.success) return { settings: LOYALTY_DEFAULTS, isDefault: true, updatedAt: null };
  return { settings: parsed.data, isDefault: false, updatedAt: row.updatedAt };
}

export async function saveSettings(
  storeId: string,
  actorId: string,
  settings: LoyaltySettings,
  requestId: string | null,
): Promise<EffectiveLoyaltySettings> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findFirst({ where: { key: LOYALTY_KEY, storeId } });
    const saved = existing
      ? await tx.setting.update({
          where: { id: existing.id },
          data: { value: settings, updatedBy: actorId },
        })
      : await tx.setting.create({
          data: { key: LOYALTY_KEY, storeId, value: settings, updatedBy: actorId },
        });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        action: "SETTING_UPDATE",
        resourceType: "setting",
        resourceId: saved.id,
        requestId,
        after: { key: LOYALTY_KEY, ...settings },
      },
    });
  });

  return getSettings(storeId);
}

type LedgerRow = {
  points: number;
  expiresAt: Date | null;
  createdAt: Date;
};

export type LoyaltyBalance = {
  /** Điểm còn dùng được ngay bây giờ. */
  available: number;
  /** Trong số đó, bao nhiêu điểm sẽ hết hạn trong 30 ngày tới. */
  expiringSoon: number;
  nextExpiryAt: Date | null;
  /** Điểm đã mất vì quá hạn, giữ lại để giải thích vì sao số dư giảm. */
  expired: number;
  totalEarned: number;
  totalRedeemed: number;
  /**
   * Số điểm đã bị trừ nhiều hơn số điểm thực có. Luôn phải bằng 0: khác 0
   * nghĩa là có bút toán trừ vượt số dư lọt qua được (lỗi dữ liệu), và phải
   * hiện ra thay vì bị làm tròn cho đẹp.
   */
  deficit: number;
};

/**
 * Số dư điểm luôn tính lại từ sổ, theo nguyên tắc lô nào hết hạn trước thì
 * tiêu trước (giống FEFO của hàng hóa). Việc hết hạn được xét theo đúng mốc
 * thời gian của từng bút toán, nên một lô đã hết hạn không thể "gánh" cho
 * lần đổi điểm xảy ra sau đó.
 */
export function summarize(rows: LedgerRow[], now: Date = new Date()): LoyaltyBalance {
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  /** Luôn xếp theo hạn dùng tăng dần; lô không hết hạn nằm cuối. */
  const lots: Array<{ points: number; expiresAt: Date | null }> = [];
  let expired = 0;
  let totalEarned = 0;
  let totalRedeemed = 0;
  let deficit = 0;

  const keyOf = (expiresAt: Date | null) => expiresAt?.getTime() ?? Infinity;

  // Lô đã xếp theo hạn nên lô hết hạn luôn nằm ở đầu: chỉ cần bóc từ đầu,
  // không quét lại cả danh sách sau mỗi bút toán (sổ điểm dài hàng nghìn
  // dòng thì cách quét lại tốn thời gian theo bình phương số dòng).
  const dropExpired = (at: Date) => {
    while (lots.length > 0) {
      const first = lots[0]!;
      if (first.expiresAt === null || first.expiresAt.getTime() > at.getTime()) break;
      expired += first.points;
      lots.shift();
    }
  };

  for (const row of ordered) {
    dropExpired(row.createdAt);
    if (row.points > 0) {
      totalEarned += row.points;
      // Chèn đúng vị trí bằng tìm kiếm nhị phân thay vì sắp xếp lại cả mảng.
      const key = keyOf(row.expiresAt);
      let low = 0;
      let high = lots.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (keyOf(lots[mid]!.expiresAt) <= key) low = mid + 1;
        else high = mid;
      }
      lots.splice(low, 0, { points: row.points, expiresAt: row.expiresAt });
      continue;
    }

    totalRedeemed += -row.points;
    let remaining = -row.points;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0]!;
      const taken = Math.min(lot.points, remaining);
      lot.points -= taken;
      remaining -= taken;
      if (lot.points === 0) lots.shift();
    }
    // Không còn lô nào để trừ: ghi lại phần thiếu, không im lặng bỏ qua.
    deficit += remaining;
  }

  dropExpired(now);

  const soonLimit = now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
  const withExpiry = lots.filter((lot) => lot.expiresAt !== null);

  return {
    available: lots.reduce((sum, lot) => sum + lot.points, 0),
    expiringSoon: withExpiry
      .filter((lot) => lot.expiresAt!.getTime() <= soonLimit)
      .reduce((sum, lot) => sum + lot.points, 0),
    nextExpiryAt: withExpiry[0]?.expiresAt ?? null,
    expired,
    totalEarned,
    totalRedeemed,
    deficit,
  };
}

type Db = Tx | typeof prisma;

export async function getBalance(
  customerId: string,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<LoyaltyBalance> {
  const rows = await db.loyaltyTransaction.findMany({
    where: { customerId },
    select: { points: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return summarize(rows, now);
}

const TYPE_LABELS: Record<string, string> = {
  EARN: "Tích điểm khi mua hàng",
  REDEEM: "Đổi điểm giảm tiền",
  REVERSE: "Hoàn lại điểm",
  ADJUST: "Điều chỉnh tay",
};

/** Sổ điểm của một khách, mới nhất trước, kèm số dư hiện tại. */
export async function getCustomerLoyalty(customerId: string, limit = 50) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, code: true, fullName: true },
  });
  if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");

  const rows = await prisma.loyaltyTransaction.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      invoice: { select: { id: true, code: true, status: true } },
      createdByUser: { select: { id: true, fullName: true } },
      store: { select: { id: true, code: true, name: true } },
    },
  });

  return {
    customer,
    balance: await getBalance(customerId),
    transactions: rows.map((row) => ({
      id: row.id,
      type: row.type,
      typeLabel: TYPE_LABELS[row.type] ?? row.type,
      points: row.points,
      amount: row.amount,
      expiresAt: row.expiresAt,
      note: row.note,
      createdAt: row.createdAt,
      invoice: row.invoice,
      store: row.store,
      createdByName: row.createdByUser?.fullName ?? null,
    })),
  };
}

/** Hạn dùng của điểm vừa tích; `expiryMonths = 0` là không hết hạn. */
export function expiryFor(settings: LoyaltySettings, at: Date = new Date()): Date | null {
  if (settings.expiryMonths === 0) return null;
  const expires = new Date(at.getTime());
  const day = expires.getUTCDate();
  expires.setUTCMonth(expires.getUTCMonth() + settings.expiryMonths);
  // Cộng tháng vào ngày 31 có thể nhảy sang tháng sau, kéo về cuối tháng đích.
  if (expires.getUTCDate() !== day) expires.setUTCDate(0);
  return expires;
}

/**
 * Hàng thuốc chỉ được tính điểm khi chủ nhà thuốc bật riêng: Luật Dược cấm
 * khuyến mại thuốc trực tiếp cho người dùng.
 */
export function isEligibleProductType(productType: string, settings: LoyaltySettings): boolean {
  return settings.earnOnDrugs || productType !== "DRUG";
}

/** Số điểm tích được từ một khoản tiền, luôn làm tròn xuống. */
export function pointsFor(amount: bigint, settings: LoyaltySettings): number {
  if (amount <= 0n) return 0;
  return Number(amount / BigInt(settings.earnAmountPerPoint));
}

/**
 * Kiểm tra một lần đổi điểm và trả về số tiền được giảm. Lỗi ném ra nói rõ
 * khách thiếu gì, vì thông điệp này hiện thẳng ra quầy bán.
 */
export async function planRedemption(
  tx: Tx,
  input: {
    customerId: string | null | undefined;
    points: number;
    settings: LoyaltySettings;
    eligibleSubtotal: bigint;
  },
): Promise<bigint> {
  const { points, settings, eligibleSubtotal } = input;
  if (points <= 0) return 0n;

  if (!settings.enabled) {
    throw new AppError(409, "LOYALTY_DISABLED", "Cửa hàng chưa bật chương trình tích điểm");
  }
  if (!input.customerId) {
    throw AppError.validation("Phải chọn khách hàng mới đổi được điểm");
  }
  if (points < settings.minRedeemPoints) {
    throw new AppError(
      422,
      "LOYALTY_MIN_POINTS",
      `Mỗi lần đổi phải từ ${settings.minRedeemPoints} điểm trở lên`,
    );
  }

  // Khóa hồ sơ khách trước khi đọc số dư: hai hóa đơn song song của cùng một
  // khách phải xếp hàng, nếu không cả hai đều thấy đủ điểm và cùng tiêu.
  await lockCustomer(tx, input.customerId);
  const balance = await getBalance(input.customerId, tx);
  if (points > balance.available) {
    throw new AppError(
      422,
      "LOYALTY_INSUFFICIENT_POINTS",
      `Khách chỉ còn ${balance.available} điểm dùng được, không đổi ${points} điểm được`,
    );
  }

  const maxAmount = (eligibleSubtotal * BigInt(settings.maxRedeemPercent)) / 100n;
  const amount = BigInt(points) * BigInt(settings.pointValue);
  if (amount > maxAmount) {
    const maxPoints = Number(maxAmount / BigInt(settings.pointValue));
    throw new AppError(
      422,
      "LOYALTY_REDEEM_LIMIT",
      eligibleSubtotal === 0n
        ? "Hóa đơn không có mặt hàng nào được đổi điểm"
        : `Hóa đơn này chỉ được đổi tối đa ${maxPoints} điểm (${settings.maxRedeemPercent}% giá trị hàng được tính điểm)`,
    );
  }

  return amount;
}

type EntryInput = {
  storeId: string;
  customerId: string;
  invoiceId?: string | null;
  returnId?: string | null;
  type: "EARN" | "REDEEM" | "REVERSE" | "ADJUST";
  points: number;
  amount?: bigint | null;
  expiresAt?: Date | null;
  note?: string | null;
  createdBy?: string | null;
};

/** Ghi một bút toán vào sổ điểm. Bút toán 0 điểm bị bỏ qua, không ghi rác. */
export async function record(tx: Tx, entry: EntryInput): Promise<void> {
  if (entry.points === 0) return;
  await tx.loyaltyTransaction.create({
    data: {
      storeId: entry.storeId,
      customerId: entry.customerId,
      invoiceId: entry.invoiceId ?? null,
      returnId: entry.returnId ?? null,
      type: entry.type,
      points: entry.points,
      amount: entry.amount ?? null,
      expiresAt: entry.expiresAt ?? null,
      note: entry.note ?? null,
      createdBy: entry.createdBy ?? null,
    },
  });
}

/**
 * Hủy hóa đơn: thu lại điểm đã tích và trả lại điểm đã đổi. Điểm trả lại
 * nhận hạn dùng mới tính từ lúc hoàn, vì hạn cũ đã mất khi khách đổi điểm.
 */
export async function reverseInvoice(
  tx: Tx,
  input: {
    storeId: string;
    invoiceId: string;
    settings: LoyaltySettings;
    userId: string;
    note: string;
  },
): Promise<void> {
  const rows = await tx.loyaltyTransaction.findMany({ where: { invoiceId: input.invoiceId } });
  if (rows.length === 0) return;

  const customerId = rows[0]!.customerId;
  const earned = rows.find((row) => row.type === "EARN")?.points ?? 0;
  const redeemed = -(rows.find((row) => row.type === "REDEEM")?.points ?? 0);
  // Phần đã xử lý trước đó (ví dụ khách đã trả một phần hàng).
  const clawedBack = rows
    .filter((row) => row.type === "REVERSE" && row.points < 0)
    .reduce((sum, row) => sum + -row.points, 0);
  const refunded = rows
    .filter((row) => row.type === "REVERSE" && row.points > 0)
    .reduce((sum, row) => sum + row.points, 0);

  // Hai bút toán tách riêng, không bù trừ với nhau, để khách đọc sổ điểm
  // hiểu được vì sao điểm tăng giảm.
  if (earned - clawedBack > 0) {
    await record(tx, {
      storeId: input.storeId,
      customerId,
      invoiceId: input.invoiceId,
      type: "REVERSE",
      points: -(earned - clawedBack),
      note: input.note,
      createdBy: input.userId,
    });
  }

  if (redeemed - refunded > 0) {
    await record(tx, {
      storeId: input.storeId,
      customerId,
      invoiceId: input.invoiceId,
      type: "REVERSE",
      points: redeemed - refunded,
      // Điểm trả lại nhận hạn dùng mới: hạn cũ đã mất khi khách đổi điểm.
      expiresAt: expiryFor(input.settings),
      note: input.note,
      createdBy: input.userId,
    });
  }
}

/**
 * Khách trả hàng: thu lại phần điểm đã tích tương ứng số tiền được hoàn,
 * theo đúng tỷ lệ trên doanh thu đã tính điểm của hóa đơn. Không bao giờ
 * thu quá số điểm hóa đơn đó đã tích.
 */
export async function reduceForReturn(
  tx: Tx,
  input: {
    storeId: string;
    invoiceId: string;
    returnId: string;
    refundEligible: bigint;
    userId: string;
  },
): Promise<void> {
  const rows = await tx.loyaltyTransaction.findMany({ where: { invoiceId: input.invoiceId } });
  const earn = rows.find((row) => row.type === "EARN");
  if (!earn || earn.amount === null || earn.amount <= 0n) return;

  const clawedBack = rows
    .filter((row) => row.type === "REVERSE" && row.points < 0)
    .reduce((sum, row) => sum + -row.points, 0);
  const left = earn.points - clawedBack;
  if (left <= 0 || input.refundEligible <= 0n) return;

  const share = Number((BigInt(earn.points) * input.refundEligible) / earn.amount);
  const points = Math.min(left, share);
  if (points <= 0) return;

  await record(tx, {
    storeId: input.storeId,
    customerId: earn.customerId,
    invoiceId: input.invoiceId,
    returnId: input.returnId,
    type: "REVERSE",
    points: -points,
    amount: input.refundEligible,
    note: "Thu lại điểm do khách trả hàng",
    createdBy: input.userId,
  });
}

/** Cộng hoặc trừ điểm bằng tay: luôn phải có lý do và không được làm âm số dư. */
export async function adjust(
  storeId: string,
  customerId: string,
  auth: AuthContext,
  input: { points: number; reason: string },
): Promise<LoyaltyBalance> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true },
  });
  if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");

  const { settings } = await getSettings(storeId);

  return prisma.$transaction(async (tx) => {
    await lockCustomer(tx, customerId);
    const before = await getBalance(customerId, tx);
    if (input.points < 0 && before.available + input.points < 0) {
      throw new AppError(
        422,
        "LOYALTY_INSUFFICIENT_POINTS",
        `Khách chỉ còn ${before.available} điểm, không trừ ${-input.points} điểm được`,
      );
    }

    await record(tx, {
      storeId,
      customerId,
      type: "ADJUST",
      points: input.points,
      expiresAt: input.points > 0 ? expiryFor(settings) : null,
      note: input.reason,
      createdBy: auth.userId,
    });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "LOYALTY_ADJUST",
        resourceType: "customer",
        resourceId: customerId,
        reason: input.reason,
        before: { available: before.available },
        after: { points: input.points },
      },
    });

    return getBalance(customerId, tx);
  });
}
