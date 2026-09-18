import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sniffFileType } from "../../lib/file-sniff.js";
import { createFileStorage } from "../../lib/file-storage.js";
import { createStableSignedUrl } from "../../lib/signed-url.js";
import { stripExif } from "../../lib/strip-exif.js";

const storage = createFileStorage("products");

export const PRODUCT_IMAGE_SCOPE = "product-image";
/** Ảnh gốc: giao diện đã thu nhỏ trước khi gửi, 5 MB là trần an toàn cho ảnh chụp điện thoại. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Ảnh thu nhỏ dùng cho danh sách. */
export const MAX_THUMB_BYTES = 512 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 8;

type ImageRow = {
  id: string;
  isPrimary: boolean;
  sortOrder: number;
  sizeBytes: number;
  uploadedAt: Date;
};

function signedPath(id: string, variant: "full" | "thumb"): string {
  const { expires, sig } = createStableSignedUrl(PRODUCT_IMAGE_SCOPE, `${id}:${variant}`);
  return `/api/v1/product-images/${id}?v=${variant}&expires=${expires}&sig=${sig}`;
}

export function toImageView(image: ImageRow) {
  return {
    id: image.id,
    isPrimary: image.isPrimary,
    sortOrder: image.sortOrder,
    sizeBytes: image.sizeBytes,
    uploadedAt: image.uploadedAt,
    url: signedPath(image.id, "full"),
    thumbUrl: signedPath(image.id, "thumb"),
  };
}

export type ProductImageView = ReturnType<typeof toImageView>;

/** Ảnh chính của nhiều sản phẩm một lượt, cho trang danh sách. */
export async function primaryImagesFor(
  productIds: string[],
): Promise<Map<string, ProductImageView>> {
  if (productIds.length === 0) return new Map();
  const rows = await prisma.productImage.findMany({
    where: { productId: { in: productIds }, isPrimary: true },
  });
  return new Map(rows.map((row) => [row.productId, toImageView(row)]));
}

export async function listImages(productId: string): Promise<ProductImageView[]> {
  const rows = await prisma.productImage.findMany({
    where: { productId },
    orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { uploadedAt: "asc" }],
  });
  return rows.map(toImageView);
}

function invalid(message: string, field = "file"): AppError {
  return new AppError(422, "VALIDATION_ERROR", "Tệp ảnh không hợp lệ", [{ field, message }]);
}

/** Chỉ nhận PNG/JPEG theo đúng nội dung byte; SVG, WebP, PDF… đều bị từ chối. */
function checkImage(buffer: Buffer, max: number, field: string): "image/jpeg" | "image/png" {
  if (buffer.length === 0) throw invalid("Tệp rỗng", field);
  if (buffer.length > max) {
    throw invalid(`Ảnh quá lớn, tối đa ${Math.round(max / 1024)} KB`, field);
  }
  const type = sniffFileType(buffer);
  if (type !== "image/jpeg" && type !== "image/png") {
    throw invalid("Chỉ nhận ảnh JPG hoặc PNG", field);
  }
  return type;
}

async function ensureProduct(productId: string): Promise<void> {
  const exists = await prisma.product.count({ where: { id: productId } });
  if (!exists) throw AppError.notFound("Không tìm thấy sản phẩm");
}

/**
 * Thêm một ảnh cho sản phẩm. Ảnh đầu tiên tự thành ảnh chính. Ảnh thu nhỏ
 * do giao diện dựng sẵn; thiếu thì dùng luôn ảnh gốc để danh sách vẫn có
 * hình (server không có thư viện xử lý ảnh).
 */
export async function uploadImage(
  productId: string,
  userId: string,
  file: Buffer,
  thumb: Buffer | undefined,
): Promise<ProductImageView> {
  await ensureProduct(productId);
  const type = checkImage(file, MAX_IMAGE_BYTES, "file");
  const thumbType = thumb ? checkImage(thumb, MAX_THUMB_BYTES, "thumb") : null;

  const count = await prisma.productImage.count({ where: { productId } });
  if (count >= MAX_IMAGES_PER_PRODUCT) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      `Mỗi sản phẩm tối đa ${MAX_IMAGES_PER_PRODUCT} ảnh, hãy gỡ bớt ảnh cũ`,
    );
  }

  const cleaned = stripExif(file, type);
  const storageKey = await storage.save(productId, cleaned, type);
  const thumbKey =
    thumb && thumbType
      ? await storage.save(productId, stripExif(thumb, thumbType), thumbType, "-thumb")
      : storageKey;

  try {
    const image = await prisma.$transaction(async (tx) => {
      const existing = await tx.productImage.findMany({
        where: { productId },
        select: { isPrimary: true, sortOrder: true },
      });
      const created = await tx.productImage.create({
        data: {
          productId,
          storageKey,
          thumbKey,
          contentType: type,
          sizeBytes: cleaned.length,
          isPrimary: !existing.some((row) => row.isPrimary),
          sortOrder: Math.max(-1, ...existing.map((row) => row.sortOrder)) + 1,
          uploadedBy: userId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: "PRODUCT_IMAGE_UPLOAD",
          resourceType: "product",
          resourceId: productId,
          after: { imageId: created.id, sizeBytes: cleaned.length, isPrimary: created.isPrimary },
        },
      });
      return created;
    });
    return toImageView(image);
  } catch (error) {
    // Không để tệp mồ côi trên đĩa khi ghi CSDL thất bại.
    await storage.remove(storageKey);
    if (thumbKey !== storageKey) await storage.remove(thumbKey);
    throw error;
  }
}

async function findImage(productId: string, imageId: string) {
  const image = await prisma.productImage.findFirst({ where: { id: imageId, productId } });
  if (!image) throw AppError.notFound("Không tìm thấy ảnh");
  return image;
}

export async function setPrimary(
  productId: string,
  imageId: string,
  userId: string,
): Promise<void> {
  await findImage(productId, imageId);
  await prisma.$transaction(async (tx) => {
    // Bỏ ảnh chính cũ trước để không vướng chỉ mục "một ảnh chính".
    await tx.productImage.updateMany({
      where: { productId, isPrimary: true },
      data: { isPrimary: false },
    });
    await tx.productImage.update({ where: { id: imageId }, data: { isPrimary: true } });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "PRODUCT_IMAGE_SET_PRIMARY",
        resourceType: "product",
        resourceId: productId,
        after: { imageId },
      },
    });
  });
}

/** Gỡ ảnh; nếu là ảnh chính thì ảnh kế tiếp được đưa lên làm ảnh chính. */
export async function removeImage(
  productId: string,
  imageId: string,
  userId: string,
): Promise<void> {
  const image = await findImage(productId, imageId);
  await prisma.$transaction(async (tx) => {
    await tx.productImage.delete({ where: { id: imageId } });
    if (image.isPrimary) {
      const next = await tx.productImage.findFirst({
        where: { productId },
        orderBy: [{ sortOrder: "asc" }, { uploadedAt: "asc" }],
      });
      if (next) await tx.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "PRODUCT_IMAGE_DELETE",
        resourceType: "product",
        resourceId: productId,
        before: { imageId, wasPrimary: image.isPrimary },
      },
    });
  });
  await storage.remove(image.storageKey);
  if (image.thumbKey !== image.storageKey) await storage.remove(image.thumbKey);
}

export async function readForStream(
  imageId: string,
  variant: "full" | "thumb",
): Promise<{ buffer: Buffer; contentType: string }> {
  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image) throw AppError.notFound("Không tìm thấy ảnh");
  const key = variant === "thumb" ? image.thumbKey : image.storageKey;
  const buffer = await storage.read(key).catch(() => {
    throw AppError.notFound("Tệp ảnh không còn trên máy chủ");
  });
  const contentType = sniffFileType(buffer) ?? image.contentType;
  return { buffer, contentType };
}
