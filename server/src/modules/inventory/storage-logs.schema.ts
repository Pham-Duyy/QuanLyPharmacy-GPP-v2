import { z } from "zod";
import { notFuture } from "../../lib/validators.js";

export const createStorageLogSchema = z.object({
  location: z.string().trim().min(1, "Thiếu khu vực"),
  recordedAt: notFuture("Thời điểm đo"),
  temperatureC: z.coerce
    .number()
    .min(-50, "Nhiệt độ không hợp lệ")
    .max(100, "Nhiệt độ không hợp lệ"),
  humidityPercent: z.coerce.number().min(0).max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
  correctsLogId: z.string().regex(/^\d+$/, "correctsLogId không hợp lệ").nullish(),
});
export type CreateStorageLogInput = z.infer<typeof createStorageLogSchema>;

const temperature = z
  .number("Nhiệt độ phải là số")
  .min(-30, "Nhiệt độ không hợp lệ")
  .max(60, "Nhiệt độ không hợp lệ")
  .nullish();
const humidity = z
  .number("Độ ẩm phải là số")
  .min(1, "Độ ẩm từ 1 đến 100 %")
  .max(100, "Độ ẩm từ 1 đến 100 %")
  .nullish();

/** Khu vực bảo quản: để trống ngưỡng nào thì không xét ngưỡng đó. */
export const createLocationSchema = z.object({
  name: z.string().trim().min(1, "Nhập tên khu vực").max(100),
  minTempC: temperature,
  maxTempC: temperature,
  maxHumidityPercent: humidity,
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = z.object({
  name: z.string().trim().min(1, "Nhập tên khu vực").max(100).optional(),
  minTempC: temperature,
  maxTempC: temperature,
  maxHumidityPercent: humidity,
  isActive: z.boolean().optional(),
});
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
