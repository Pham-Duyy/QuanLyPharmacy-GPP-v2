import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sniffFileType } from "../../lib/file-sniff.js";
import { stripExif } from "../../lib/strip-exif.js";
import {
  DEFAULT_INVOICE_FOOTER,
  DEFAULT_INVOICE_TITLE,
  MAX_LOGO_BYTES,
  printTemplateSchema,
  type PrintTemplate,
} from "./print-template.schema.js";

export const PRINT_TEMPLATE_KEY = "invoicePrintTemplate";

const DATA_URL_PATTERN = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Mẫu mặc định lấy từ thông tin cửa hàng, để máy chưa từng cài đặt vẫn in được. */
function defaultTemplate(store: {
  name: string;
  address: string | null;
  phone: string | null;
}): PrintTemplate {
  return {
    paperSize: "K80",
    logo: null,
    companyName: "",
    storeName: store.name,
    address: store.address ?? "",
    phone: store.phone ?? "",
    taxCode: "",
    title: DEFAULT_INVOICE_TITLE,
    footer: DEFAULT_INVOICE_FOOTER,
    display: {
      logo: true,
      customer: true,
      seller: true,
      unit: true,
      discount: true,
      paymentMethod: true,
      cashChange: true,
    },
  };
}

export type EffectiveTemplate = {
  template: PrintTemplate;
  isDefault: boolean;
  updatedAt: Date | null;
};

/**
 * Mẫu in đang áp dụng cho một cửa hàng. Mẫu lưu theo từng cửa hàng (chi
 * nhánh) vì mỗi nơi có địa chỉ, số điện thoại riêng. Bản lưu hỏng hoặc thiếu
 * trường (ví dụ do phiên bản cũ) thì ghép lên mẫu mặc định thay vì làm hỏng
 * việc in hóa đơn tại quầy.
 */
export async function getEffectiveTemplate(storeId: string): Promise<EffectiveTemplate> {
  const [store, row] = await Promise.all([
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { name: true, address: true, phone: true },
    }),
    prisma.setting.findFirst({ where: { key: PRINT_TEMPLATE_KEY, storeId } }),
  ]);

  const fallback = defaultTemplate(store);
  if (!row || typeof row.value !== "object" || row.value === null) {
    return { template: fallback, isDefault: true, updatedAt: null };
  }

  const saved = row.value as Partial<PrintTemplate>;
  const merged = {
    ...fallback,
    ...saved,
    display: { ...fallback.display, ...(saved.display ?? {}) },
  };
  const parsed = printTemplateSchema.safeParse(merged);

  return parsed.success
    ? { template: parsed.data, isDefault: false, updatedAt: row.updatedAt }
    : { template: fallback, isDefault: true, updatedAt: null };
}

/**
 * Kiểm tra logo theo nội dung byte thật (không tin phần khai báo trong data
 * URL), chỉ nhận PNG/JPEG — SVG bị loại vì có thể chứa script — rồi xóa EXIF
 * trước khi lưu.
 */
export function sanitizeLogo(logo: string | null): string | null {
  if (logo === null || logo === "") return null;

  const invalid = (message: string) =>
    new AppError(422, "VALIDATION_ERROR", "Dữ liệu gửi lên không hợp lệ", [
      { field: "logo", message },
    ]);

  const match = DATA_URL_PATTERN.exec(logo);
  if (!match) throw invalid("Logo phải là ảnh PNG hoặc JPG");

  const buffer = Buffer.from(match[2]!, "base64");
  if (buffer.length > MAX_LOGO_BYTES) throw invalid("Logo quá lớn, tối đa 300 KB");

  const type = sniffFileType(buffer);
  if (type !== "image/png" && type !== "image/jpeg") {
    throw invalid("Tệp logo không phải ảnh PNG hoặc JPG hợp lệ");
  }

  return `data:${type};base64,${stripExif(buffer, type).toString("base64")}`;
}

export async function saveTemplate(
  storeId: string,
  actorId: string,
  input: PrintTemplate,
  requestId: string | null,
): Promise<EffectiveTemplate> {
  const template: PrintTemplate = { ...input, logo: sanitizeLogo(input.logo) };

  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findFirst({ where: { key: PRINT_TEMPLATE_KEY, storeId } });
    const saved = existing
      ? await tx.setting.update({
          where: { id: existing.id },
          data: { value: template, updatedBy: actorId },
        })
      : await tx.setting.create({
          data: { key: PRINT_TEMPLATE_KEY, storeId, value: template, updatedBy: actorId },
        });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        action: "SETTING_UPDATE",
        resourceType: "setting",
        resourceId: saved.id,
        requestId,
        // Không ghi cả logo base64 vào nhật ký, chỉ ghi có hay không.
        after: { key: PRINT_TEMPLATE_KEY, ...template, logo: template.logo ? "(có logo)" : null },
      },
    });
  });

  return getEffectiveTemplate(storeId);
}
