import { describe, expect, it } from "vitest";
import { isGroupHeader, pageWithGroups, type ExpiryGroup } from "./expiry-groups.js";

const group = (key: string, batches: number): ExpiryGroup => ({
  key,
  label: key,
  batches,
  value: null,
  withoutCost: 0,
});

const groups = [group("EXPIRED", 1), group("2026-11", 3), group("2026-12", 1)];
const items = [
  { id: "a", group: "EXPIRED" },
  { id: "b", group: "2026-11" },
  { id: "c", group: "2026-11" },
  { id: "d", group: "2026-11" },
  { id: "e", group: "2026-12" },
];

const describeRows = (rows: ReturnType<typeof pageWithGroups<(typeof items)[number]>>) =>
  rows.map((row) =>
    isGroupHeader(row)
      ? `[${row.group.key}${row.continued ? " tiếp" : ""}${row.split ? " cả nhóm" : ""}]`
      : row.id,
  );

describe("chia trang danh sách hàng cận hạn đã gom theo tháng", () => {
  it("chèn tiêu đề trước mỗi nhóm có trên trang", () => {
    expect(describeRows(pageWithGroups(items, groups, 1, 30))).toEqual([
      "[EXPIRED]",
      "a",
      "[2026-11]",
      "b",
      "c",
      "d",
      "[2026-12]",
      "e",
    ]);
  });

  it("nhóm kéo sang trang sau thì ghi tiếp theo, tổng là của cả nhóm", () => {
    // Mỗi trang 3 lô: tháng 11 nằm ở cả hai trang.
    expect(describeRows(pageWithGroups(items, groups, 1, 3))).toEqual([
      "[EXPIRED]",
      "a",
      "[2026-11 cả nhóm]",
      "b",
      "c",
    ]);
    expect(describeRows(pageWithGroups(items, groups, 2, 3))).toEqual([
      "[2026-11 tiếp cả nhóm]",
      "d",
      "[2026-12]",
      "e",
    ]);
  });

  it("trang bắt đầu đúng đầu nhóm thì không ghi tiếp theo", () => {
    expect(describeRows(pageWithGroups(items, groups, 2, 4))).toEqual(["[2026-12]", "e"]);
  });
});
