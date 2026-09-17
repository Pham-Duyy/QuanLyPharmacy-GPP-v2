import { z } from "zod";

export const PAPER_SIZES = ["K80", "K58", "A5"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const DEFAULT_INVOICE_TITLE = "HÓA ĐƠN BÁN HÀNG";
export const DEFAULT_INVOICE_FOOTER = "Cảm ơn quý khách. Vui lòng giữ hóa đơn khi cần đổi trả.";

/** Logo lưu thẳng trong JSON cài đặt nên phải nhỏ; ảnh in nhiệt chỉ rộng vài cm. */
export const MAX_LOGO_BYTES = 300 * 1024;

const text = (max: number) => z.string().trim().max(max, `Tối đa ${max} ký tự`);

const displaySchema = z.object({
  logo: z.boolean(),
  customer: z.boolean(),
  seller: z.boolean(),
  unit: z.boolean(),
  discount: z.boolean(),
  paymentMethod: z.boolean(),
  cashChange: z.boolean(),
});

/**
 * Mẫu in hóa đơn bán lẻ tại quầy. Đây KHÔNG phải hóa đơn điện tử theo
 * NĐ 123/2020 — chỉ là phiếu thanh toán đưa cho khách, nên không có ký hiệu,
 * mẫu số hay mã cơ quan thuế.
 */
export const printTemplateSchema = z.object({
  paperSize: z.enum(PAPER_SIZES, "Khổ giấy không hợp lệ"),
  // Data URL PNG/JPEG. Kiểm tra nội dung byte thật nằm ở service, schema chỉ chặn hình dạng.
  logo: z
    .string()
    .max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 64, "Logo quá lớn, tối đa 300 KB")
    .nullable(),
  companyName: text(150),
  storeName: text(150).min(1, "Phải nhập tên nhà thuốc"),
  address: text(250),
  phone: text(30),
  taxCode: text(20).regex(/^[0-9-]*$/, "Mã số thuế chỉ gồm chữ số và dấu gạch ngang"),
  title: text(80).min(1, "Phải nhập tiêu đề hóa đơn"),
  footer: text(300),
  display: displaySchema,
});

export type PrintTemplate = z.infer<typeof printTemplateSchema>;

export const previewSchema = z.object({
  template: printTemplateSchema,
  sample: z.enum(["standard", "long", "walk_in"]).default("standard"),
});
