/**
 * Hai khu bảo quản mặc định của một nhà thuốc bán lẻ (GPP): khu bán lẻ không
 * quá 30 °C, độ ẩm không quá 75 %; tủ lạnh 2–8 °C. Dùng khi seed và khi mở
 * cửa hàng mới. Để riêng, không kèm CSDL, để `prisma/seed.ts` nhập được.
 */
export const DEFAULT_STORAGE_LOCATIONS: ReadonlyArray<{
  code: string;
  name: string;
  minTempC: number | null;
  maxTempC: number | null;
  maxHumidityPercent: number | null;
}> = [
  { code: "RETAIL_AREA", name: "Khu bán lẻ", minTempC: null, maxTempC: 30, maxHumidityPercent: 75 },
  {
    code: "FRIDGE",
    name: "Tủ lạnh bảo quản thuốc",
    minTempC: 2,
    maxTempC: 8,
    maxHumidityPercent: null,
  },
];
