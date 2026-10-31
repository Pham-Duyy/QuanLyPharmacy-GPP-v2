import { z } from "zod";
import {
  MAX_SHELF_YEARS,
  lineQuantity,
  money,
  notFuture,
  notFutureDay,
  withinYearsAhead,
  withinYearsBack,
} from "../../lib/validators.js";
import { dateKey, vnDay } from "../../lib/dates.js";

/** Tuổi thọ tối thiểu hợp lý giữa ngày sản xuất và hạn dùng; ngắn hơn gần như chắc chắn là nhập nhầm. */
export const MIN_SHELF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

const lineSchema = z
  .object({
    productId: z.uuid("productId không hợp lệ"),
    unitId: z.uuid("unitId không hợp lệ"),
    quantity: lineQuantity(),
    unitCost: money("Giá nhập"),
    batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
    manufactureDate: z.coerce
      .date("Ngày sản xuất không hợp lệ")
      .refine((value) => dateKey(value) <= vnDay(), "Ngày sản xuất không được ở tương lai")
      .refine(
        (value) => withinYearsBack(value),
        `Ngày sản xuất cách đây quá ${MAX_SHELF_YEARS} năm — kiểm tra lại năm`,
      )
      .nullish(),
    expiryDate: z.coerce
      .date("Hạn dùng không hợp lệ")
      .refine((value) => dateKey(value) > vnDay(), "Hạn dùng phải sau hôm nay")
      .refine(
        (value) => withinYearsAhead(value),
        `Hạn dùng xa quá ${MAX_SHELF_YEARS} năm — kiểm tra lại năm`,
      ),
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

/**
 * Một lô của một sản phẩm chỉ nằm trên một dòng (D28): hai dòng cùng lô dễ là
 * nhập trùng, và nếu khác hạn dùng thì không biết hạn nào đúng.
 */
const receiptLines = z
  .array(lineSchema)
  .min(1, "Phiếu nhập phải có ít nhất một dòng")
  .max(500)
  .superRefine((lines, ctx) => {
    const seen = new Map<string, number>();
    lines.forEach((line, index) => {
      const key = `${line.productId}|${line.batchNumber.toUpperCase()}`;
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [index, "batchNumber"],
          message: `Lô ${line.batchNumber} đã có ở dòng ${first + 1}; gộp thành một dòng`,
        });
      } else seen.set(key, index);
    });
  });

export const createReceiptSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ"),
  /** Lập từ đơn đặt hàng (Phase 7, D32): đơn phải đã gửi, cùng nhà cung cấp. */
  purchaseOrderId: z.uuid("purchaseOrderId không hợp lệ").nullish(),
  supplierInvoiceNumber: z.string().trim().max(50).nullish(),
  supplierInvoiceDate: notFutureDay("Ngày hóa đơn").nullish(),
  receivedAt: notFuture("Ngày nhận hàng").default(() => new Date()),
  note: z.string().trim().max(500).nullish(),
  discountAmount: money("Chiết khấu").default(0),
  vatAmount: money("Thuế").default(0),
  lines: receiptLines,
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
    /** Tủ–kệ–ngăn xếp lô này; bỏ trống thì lấy vị trí gần nhất của cùng thuốc. */
    shelfLocation: z.string().max(60, "Vị trí tối đa 30 ký tự").nullish(),
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
  supplierInvoiceDate: notFutureDay("Ngày hóa đơn").nullish(),
  receivedAt: notFuture("Ngày nhận hàng").optional(),
  note: z.string().trim().max(500).nullish(),
  discountAmount: money("Chiết khấu").optional(),
  vatAmount: money("Thuế").optional(),
  lines: receiptLines.optional(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
export type PatchReceiptInput = z.infer<typeof patchReceiptSchema>;
