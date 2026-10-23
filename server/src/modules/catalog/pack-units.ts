/**
 * Đơn vị của một thuốc tách thành đơn vị cơ bản (tồn kho tính theo nó) và các
 * đơn vị lớn đang dùng (hộp, vỉ…), lớn trước — giao diện dùng để quy đổi số
 * lượng cơ bản thành "66 Hộp 1 Vỉ" khi đối chiếu với hàng thật trên kệ.
 */

type UnitRow = { name: string; conversionToBase: number; isActive: boolean };

/** Chọn đủ đơn vị của sản phẩm để tách bằng `splitUnits`. */
export const UNIT_FIELDS = {
  select: { name: true, conversionToBase: true, isActive: true },
} as const;

export type PackUnit = { name: string; conversionToBase: number };

export function splitUnits(units: UnitRow[]): {
  baseUnitName: string | null;
  packUnits: PackUnit[];
} {
  return {
    baseUnitName: units.find((unit) => unit.conversionToBase === 1)?.name ?? null,
    // Đơn vị đã ngừng dùng không đưa vào quy đổi.
    packUnits: units
      .filter((unit) => unit.isActive && unit.conversionToBase > 1)
      .sort((a, b) => b.conversionToBase - a.conversionToBase)
      .map((unit) => ({ name: unit.name, conversionToBase: unit.conversionToBase })),
  };
}
