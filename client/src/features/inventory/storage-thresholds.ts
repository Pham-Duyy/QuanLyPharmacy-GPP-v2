/** Ngưỡng của khu vực bảo quản dạng chữ: "2 – 8 °C", "≤ 30 °C", "≥ 15 °C", "Không đặt". */
export function thresholdText(min: number | null, max: number | null, unit: string): string {
  if (min !== null && max !== null) return `${min} – ${max} ${unit}`;
  if (max !== null) return `≤ ${max} ${unit}`;
  if (min !== null) return `≥ ${min} ${unit}`;
  return "Không đặt";
}
