import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptSchema } from "./goods-receipts.schema.js";
import { openingBalanceSchema } from "./opening-balance.schema.js";

/**
 * Hạn dùng so theo ngày Việt Nam. Trước đây so thẳng với Date.now(): từ 0 giờ
 * tới 7 giờ sáng (ngày UTC còn là hôm trước) phiếu nhập vẫn nhận lô hết hạn
 * đúng hôm đó, và từ chối ngày sản xuất là hôm nay.
 */
const ids = { productId: randomUUID(), unitId: randomUUID() };

const receipt = (expiryDate: string, manufactureDate?: string) =>
  createReceiptSchema.safeParse({
    supplierId: randomUUID(),
    lines: [
      {
        ...ids,
        quantity: 10,
        unitCost: 1000,
        batchNumber: "L1",
        expiryDate,
        manufactureDate,
      },
    ],
  });

const opening = (expiryDate: string) =>
  openingBalanceSchema.safeParse({
    lines: [{ ...ids, quantity: 10, unitCost: 1000, batchNumber: "L1", expiryDate }],
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("Hạn dùng khi nhập hàng và nhập tồn đầu kỳ, theo ngày Việt Nam", () => {
  // 03:00 sáng 14/10 giờ Việt Nam = 20:00 ngày 13/10 giờ UTC.
  const earlyMorning = new Date("2026-10-13T20:00:00.000Z");

  it("lúc 3 giờ sáng vẫn từ chối lô hết hạn đúng hôm nay", () => {
    vi.useFakeTimers({ now: earlyMorning, toFake: ["Date"] });
    expect(receipt("2026-10-14").success).toBe(false);
    expect(opening("2026-10-14").success).toBe(false);
    expect(receipt("2026-12-31").success).toBe(true);
    expect(opening("2026-12-31").success).toBe(true);
  });

  it("lúc 3 giờ sáng vẫn nhận ngày sản xuất là hôm nay", () => {
    vi.useFakeTimers({ now: earlyMorning, toFake: ["Date"] });
    expect(receipt("2028-10-14", "2026-10-14").success).toBe(true);
    expect(receipt("2028-10-14", "2026-10-15").success).toBe(false);
  });
});
