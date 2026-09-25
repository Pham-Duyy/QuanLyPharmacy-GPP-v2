import { z } from "zod";

/**
 * Cài đặt tích điểm. Mặc định TẮT và KHÔNG tính điểm cho hàng thuốc:
 * Luật Dược cấm khuyến mại thuốc trực tiếp cho người dùng, nên việc mở
 * tích điểm cho nhóm thuốc phải là quyết định có ý thức của chủ nhà thuốc.
 */
export const loyaltySettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Số tiền (đồng) khách chi để được 1 điểm. */
    earnAmountPerPoint: z.coerce
      .number()
      .int()
      .min(1000, "Mỗi điểm phải ứng với ít nhất 1.000đ chi tiêu")
      .max(10_000_000),
    /** Mỗi điểm đổi được bao nhiêu đồng khi thanh toán. */
    pointValue: z.coerce.number().int().min(100, "Mỗi điểm phải đổi được ít nhất 100đ").max(1_000_000),
    /** Số điểm tối thiểu cho một lần đổi. */
    minRedeemPoints: z.coerce.number().int().min(0).max(100_000),
    /** Trần phần trăm giá trị hàng được tính điểm mà một lần đổi được giảm. */
    maxRedeemPercent: z.coerce.number().int().min(1).max(100),
    /** Số tháng điểm còn hiệu lực; 0 là không hết hạn. */
    expiryMonths: z.coerce.number().int().min(0).max(120),
    /** Tính điểm cho cả hàng thuốc hay không (xem cảnh báo pháp lý ở trên). */
    earnOnDrugs: z.boolean(),
  })
  .refine((value) => value.pointValue * 2 <= value.earnAmountPerPoint, {
    message: "Giá trị quy đổi quá cao: mỗi điểm không nên đổi quá một nửa số tiền cần chi để có điểm đó",
    path: ["pointValue"],
  });

export const adjustPointsSchema = z.object({
  points: z.coerce
    .number()
    .int()
    .refine((value) => value !== 0, "Số điểm điều chỉnh phải khác 0"),
  reason: z.string().trim().min(1, "Phải ghi lý do điều chỉnh điểm").max(500),
});

export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>;
