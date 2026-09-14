import { z } from "zod";

export const createStorageLogSchema = z.object({
  location: z.string().trim().min(1, "Thiếu khu vực"),
  recordedAt: z.coerce.date(),
  temperatureC: z.coerce
    .number()
    .min(-50, "Nhiệt độ không hợp lệ")
    .max(100, "Nhiệt độ không hợp lệ"),
  humidityPercent: z.coerce.number().min(0).max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
  correctsLogId: z.string().regex(/^\d+$/, "correctsLogId không hợp lệ").nullish(),
});
export type CreateStorageLogInput = z.infer<typeof createStorageLogSchema>;
