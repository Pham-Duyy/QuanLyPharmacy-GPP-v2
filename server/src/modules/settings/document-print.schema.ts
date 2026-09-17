import { z } from "zod";

/** Các loại chứng từ (ngoài hóa đơn bán hàng) in được từ hệ thống. */
export const DOCUMENT_TYPES = ["goodsReceipt", "return", "stockAdjustment"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Khổ giấy hợp lý cho từng loại: phiếu kho nhiều cột nên không in khổ nhiệt. */
export const DOCUMENT_PAPERS = {
  goodsReceipt: ["A4", "A5"],
  return: ["K80", "K58", "A5", "A4"],
  stockAdjustment: ["A4", "A5"],
} as const satisfies Record<DocumentType, readonly string[]>;

export const DOCUMENT_DEFAULTS: Record<
  DocumentType,
  { paperSize: string; title: string; footer: string; signatures: string[] }
> = {
  goodsReceipt: {
    paperSize: "A4",
    title: "PHIẾU NHẬP KHO",
    footer: "",
    signatures: ["Người lập phiếu", "Người giao hàng", "Dược sĩ kiểm nhập", "Người phụ trách"],
  },
  return: {
    paperSize: "K80",
    title: "PHIẾU TRẢ HÀNG",
    footer: "Nhà thuốc đã nhận lại hàng và hoàn tiền cho quý khách.",
    signatures: ["Khách hàng", "Nhân viên"],
  },
  stockAdjustment: {
    paperSize: "A4",
    title: "PHIẾU ĐIỀU CHỈNH TỒN KHO",
    footer: "",
    signatures: ["Người lập phiếu", "Thủ kho", "Người duyệt"],
  },
};

const text = (max: number) => z.string().trim().max(max, `Tối đa ${max} ký tự`);

const configSchema = (type: DocumentType) =>
  z.object({
    paperSize: z.enum(DOCUMENT_PAPERS[type], "Khổ giấy không hợp lệ cho loại phiếu này"),
    title: text(80).min(1, "Phải nhập tiêu đề phiếu"),
    footer: text(300),
    showSignatures: z.boolean(),
    showAmountInWords: z.boolean(),
    showNote: z.boolean(),
  });

export const documentPrintSettingsSchema = z.object({
  goodsReceipt: configSchema("goodsReceipt"),
  return: configSchema("return"),
  stockAdjustment: configSchema("stockAdjustment"),
});

export type DocumentPrintSettings = z.infer<typeof documentPrintSettingsSchema>;
export type DocumentPrintConfig = DocumentPrintSettings[DocumentType];

export const documentPreviewSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  settings: documentPrintSettingsSchema,
});
