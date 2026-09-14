import { z } from "zod";

export const createStoreSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Thiếu mã cửa hàng")
    .max(20)
    .regex(/^[A-Z0-9_-]+$/i, "Mã cửa hàng chỉ gồm chữ, số, gạch dưới, gạch ngang"),
  name: z.string().trim().min(1, "Thiếu tên cửa hàng").max(200),
  address: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(20).nullish(),
  gppCertificateNumber: z.string().trim().max(100).nullish(),
  licenseNumber: z.string().trim().max(100).nullish(),
});

export const patchStoreSchema = z.object({
  name: z.string().trim().min(1, "Thiếu tên cửa hàng").max(200).optional(),
  address: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(20).nullish(),
  gppCertificateNumber: z.string().trim().max(100).nullish(),
  licenseNumber: z.string().trim().max(100).nullish(),
  version: z.coerce.number().int().positive("Thiếu version"),
});

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type PatchStoreInput = z.infer<typeof patchStoreSchema>;
