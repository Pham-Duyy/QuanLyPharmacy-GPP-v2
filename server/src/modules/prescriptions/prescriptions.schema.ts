import { z } from "zod";

/**
 * `productId` và `unitId` đi cùng nhau hoặc cùng vắng mặt: thuốc mới kê
 * bằng tay có thể chưa khớp được sản phẩm trong danh mục (contract §12),
 * nhưng đã khớp thì phải rõ luôn bán theo đơn vị nào để tính được số lượng
 * theo đơn vị nhỏ nhất.
 */
const itemSchema = z
  .object({
    productId: z.uuid("productId không hợp lệ").nullish(),
    drugNameText: z.string().trim().min(1, "Thiếu tên thuốc").max(300),
    unitId: z.uuid("unitId không hợp lệ").nullish(),
    quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
    dosageInstruction: z.string().trim().max(500).nullish(),
  })
  .refine((item) => Boolean(item.productId) === Boolean(item.unitId), {
    message: "productId và unitId phải đi cùng nhau",
    path: ["unitId"],
  });

export const createPrescriptionSchema = z.object({
  customerId: z.uuid("customerId không hợp lệ").nullish(),
  externalCode: z.string().trim().max(100).nullish(),
  prescriberName: z.string().trim().max(200).nullish(),
  facilityName: z.string().trim().max(300).nullish(),
  diagnosisText: z.string().trim().max(1000).nullish(),
  prescribedDate: z.coerce.date(),
  // Bỏ trống thì backend tự tính = prescribedDate + prescriptionValidityDays (P14).
  validUntil: z.coerce.date().nullish(),
  items: z.array(itemSchema).min(1, "Đơn thuốc phải có ít nhất một dòng"),
});

export const patchPrescriptionSchema = z.object({
  version: z.coerce.number().int().positive("Thiếu version"),
  customerId: z.uuid("customerId không hợp lệ").nullish(),
  externalCode: z.string().trim().max(100).nullish(),
  prescriberName: z.string().trim().max(200).nullish(),
  facilityName: z.string().trim().max(300).nullish(),
  diagnosisText: z.string().trim().max(1000).nullish(),
  prescribedDate: z.coerce.date().optional(),
  // Không cho phép null: luôn phải có một ngày hết hạn, khác lúc tạo mới
  // (nơi bỏ trống nghĩa là "để backend tự tính").
  validUntil: z.coerce.date().optional(),
  items: z.array(itemSchema).min(1, "Đơn thuốc phải có ít nhất một dòng").optional(),
});

export const rejectPrescriptionSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do từ chối").max(500),
});

/** Đơn bệnh mạn tính: người xác nhận tự nhập validUntil, hệ thống giữ nguyên (P14). */
export const verifyPrescriptionSchema = z.object({
  validUntil: z.coerce.date().nullish(),
});

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>;
export type PatchPrescriptionInput = z.infer<typeof patchPrescriptionSchema>;
export type VerifyPrescriptionInput = z.infer<typeof verifyPrescriptionSchema>;
