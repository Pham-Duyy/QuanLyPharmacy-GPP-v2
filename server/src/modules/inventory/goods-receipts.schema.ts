import { z } from "zod";

/** Tuổi thọ tối thiểu hợp lý giữa ngày sản xuất và hạn dùng; ngắn hơn gần như chắc chắn là nhập nhầm. */
export const MIN_SHELF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

const lineSchema = z
  .object({
    productId: z.uuid("productId không hợp lệ"),
    unitId: z.uuid("unitId không hợp lệ"),
    quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
    unitCost: z.coerce.number().int().min(0, "Giá nhập không được âm"),
    batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
    manufactureDate: z.coerce
      .date()
      .refine((value) => value.getTime() <= Date.now(), "Ngày sản xuất không được ở tương lai")
      .nullish(),
    expiryDate: z.coerce
      .date()
      .refine((value) => value.getTime() > Date.now(), "Hạn dùng phải sau hôm nay"),
  })
  .refine(
    (line) =>
      !line.manufactureDate ||
      line.expiryDate.getTime() - line.manufactureDate.getTime() >= MIN_SHELF_LIFE_DAYS * DAY_MS,
    {
      message: `Hạn dùng phải sau ngày sản xuất ít nhất ${MIN_SHELF_LIFE_DAYS} ngày — kiểm tra lại NSX/HSD trên bao bì`,
      path: ["expiryDate"],
    },
  );

export const createReceiptSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ"),
  supplierInvoiceNumber: z.string().trim().max(50).nullish(),
  supplierInvoiceDate: z.coerce.date().nullish(),
  receivedAt: z.coerce.date().default(() => new Date()),
  note: z.string().trim().max(500).nullish(),
  discountAmount: z.coerce.number().int().min(0, "Chiết khấu không được âm").default(0),
  vatAmount: z.coerce.number().int().min(0, "Thuế không được âm").default(0),
  lines: z.array(lineSchema).min(1, "Phiếu nhập phải có ít nhất một dòng"),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do hủy phiếu").max(500),
});

/**
 * Kết quả kiểm nhập cảm quan từng dòng, bắt buộc khi xác nhận phiếu nhập
 * (thực hành GPP: dược sĩ phụ trách phải kiểm tra hạn dùng, bao bì, chất
 * lượng cảm quan trước khi cho hàng vào kho bán). Dòng "không đạt" phải ghi
 * lý do — lô tương ứng sẽ vào thẳng biệt trữ thay vì bán được ngay.
 */
const confirmLineSchema = z
  .object({
    lineId: z.uuid("lineId không hợp lệ"),
    passed: z.boolean(),
    rejectReason: z.string().trim().max(500).nullish(),
  })
  .refine((line) => line.passed || Boolean(line.rejectReason), {
    message: "Dòng không đạt kiểm nhập phải ghi lý do",
    path: ["rejectReason"],
  });

export const confirmSchema = z.object({
  lines: z.array(confirmLineSchema).min(1, "Phải có kết quả kiểm nhập cho ít nhất một dòng"),
});
export type ConfirmReceiptInput = z.infer<typeof confirmSchema>;

/**
 * Sửa phiếu khi còn DRAFT (contract §9, §2.5). Mọi trường đều tùy chọn —
 * gửi gì sửa nấy, không gửi thì giữ nguyên. Riêng `lines` là thay nguyên
 * danh sách dòng, không sửa từng dòng lẻ, vì phiếu còn nháp thì chưa có lô
 * hay thẻ kho nào phụ thuộc vào dòng cũ.
 */
export const patchReceiptSchema = z.object({
  version: z.coerce.number().int().positive("Thiếu version"),
  supplierId: z.uuid("supplierId không hợp lệ").optional(),
  supplierInvoiceNumber: z.string().trim().max(50).nullish(),
  supplierInvoiceDate: z.coerce.date().nullish(),
  receivedAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).nullish(),
  discountAmount: z.coerce.number().int().min(0, "Chiết khấu không được âm").optional(),
  vatAmount: z.coerce.number().int().min(0, "Thuế không được âm").optional(),
  lines: z.array(lineSchema).min(1, "Phiếu nhập phải có ít nhất một dòng").optional(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
export type PatchReceiptInput = z.infer<typeof patchReceiptSchema>;
