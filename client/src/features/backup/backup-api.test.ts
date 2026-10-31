import { describe, expect, it } from "vitest";
import { isStale, sizeText } from "./backup-api";

describe("Sao lưu", () => {
  it("cảnh báo khi bản gần nhất cũ hơn 2 ngày hoặc chưa có bản nào", () => {
    const now = new Date("2026-10-31T12:00:00Z").getTime();
    const item = (createdAt: string) => ({
      name: "x",
      kind: "auto" as const,
      createdAt,
      sizeBytes: 1,
      tables: 1,
    });
    expect(isStale([], now)).toBe(true);
    expect(isStale([item("2026-10-30T16:00:00Z")], now)).toBe(false);
    expect(isStale([item("2026-10-28T16:00:00Z")], now)).toBe(true);
  });

  it("dung lượng dễ đọc", () => {
    expect(sizeText(500)).toBe("1 KB");
    expect(sizeText(1_200_000)).toBe("1.1 MB");
  });
});
