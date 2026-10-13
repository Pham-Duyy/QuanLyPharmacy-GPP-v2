import { describe, expect, it } from "vitest";
import { daysLeftLabel, isExpired } from "./expiry-status.js";

describe("trạng thái hạn dùng ở trang Hàng cận hạn", () => {
  it("lô hết hạn đúng hôm nay đã tính là hết hạn, như ở quầy bán", () => {
    expect(isExpired(0)).toBe(true);
    expect(isExpired(-2)).toBe(true);
    expect(isExpired(1)).toBe(false);
  });

  it("ghi rõ hết hạn hôm nay thay cho còn 0 ngày", () => {
    expect(daysLeftLabel(0)).toBe("Hết hạn hôm nay");
    expect(daysLeftLabel(-3)).toBe("Đã quá hạn 3 ngày");
    expect(daysLeftLabel(12)).toBe("Còn 12 ngày");
  });
});
