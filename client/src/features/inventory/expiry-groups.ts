/** Nhóm do API trả về: "EXPIRED" hoặc tháng hết hạn "YYYY-MM", tổng tính cho cả nhóm. */
export type ExpiryGroup = {
  key: string;
  label: string;
  batches: number;
  value: number | null;
  withoutCost: number;
};

/** Dòng tiêu đề nhóm chèn vào bảng, đứng trước lô đầu tiên của nhóm trên trang. */
export type GroupHeader = {
  kind: "group";
  rowKey: string;
  group: ExpiryGroup;
  /** Nhóm đã bắt đầu từ trang trước. */
  continued: boolean;
  /** Trang này không chứa hết lô của nhóm: tổng ở tiêu đề là của cả nhóm. */
  split: boolean;
};

/**
 * Cắt một trang từ danh sách đã gom và xếp sẵn (theo lô, không tính dòng tiêu
 * đề), rồi chèn tiêu đề trước mỗi nhóm có mặt trên trang.
 */
export function pageWithGroups<T extends { group: string }>(
  items: T[],
  groups: ExpiryGroup[],
  page: number,
  pageSize: number,
): Array<T | GroupHeader> {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  const rows: Array<T | GroupHeader> = [];
  pageItems.forEach((item, index) => {
    const group = byKey.get(item.group);
    if (group && (index === 0 || pageItems[index - 1]!.group !== item.group)) {
      const onPage = pageItems.filter((other) => other.group === item.group).length;
      rows.push({
        kind: "group",
        rowKey: `group-${group.key}`,
        group,
        continued: index === 0 && start > 0 && items[start - 1]!.group === item.group,
        split: onPage < group.batches,
      });
    }
    rows.push(item);
  });
  return rows;
}

export const isGroupHeader = (row: object): row is GroupHeader =>
  (row as { kind?: string }).kind === "group";
