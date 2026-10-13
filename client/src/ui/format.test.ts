import { afterEach, describe, expect, it, vi } from "vitest";
import { daysUntil } from "./format.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("số ngày còn lại tới một ngày", () => {
  it("lúc 3 giờ sáng giờ Việt Nam (ngày UTC còn là hôm trước) vẫn đếm đúng", () => {
    // 03:00 sáng 14/10 giờ Việt Nam = 20:00 ngày 13/10 giờ UTC.
    vi.useFakeTimers({ now: new Date("2026-10-13T20:00:00.000Z"), toFake: ["Date"] });
    expect(daysUntil("2026-10-14")).toBe(0);
    expect(daysUntil("2026-12-13")).toBe(60);
    expect(daysUntil("2026-10-13")).toBe(-1);
  });

  it("nhận cả giá trị cột ngày máy chủ trả về", () => {
    vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00.000Z"), toFake: ["Date"] });
    expect(daysUntil("2026-10-24T00:00:00.000Z")).toBe(10);
  });
});
