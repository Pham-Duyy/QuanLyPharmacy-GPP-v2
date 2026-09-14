import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sniffFileType } from "../../lib/file-sniff.js";
import { readImageFile, saveImageFile } from "../../lib/prescription-storage.js";
import { stripExif } from "../../lib/strip-exif.js";

/**
 * Tải một phiên bản ảnh đơn mới (contract §12). Mỗi lần tải lên là một
 * phiên bản mới, không ghi đè — số phiên bản tăng dần theo từng đơn.
 */
export async function uploadImage(
  prescriptionId: string,
  userId: string,
  buffer: Buffer,
): Promise<{ id: string; versionNo: number }> {
  const prescription = await prisma.prescription.findUnique({ where: { id: prescriptionId } });
  if (!prescription) throw AppError.notFound("Không tìm thấy đơn thuốc");

  // Kiểm tra theo đúng nội dung tệp, không tin phần mở rộng hay Content-Type client gửi lên.
  const contentType = sniffFileType(buffer);
  if (!contentType) {
    throw new AppError(422, "VALIDATION_ERROR", "Chỉ nhận ảnh JPEG, PNG hoặc tệp PDF");
  }

  const cleaned = stripExif(buffer, contentType);
  const storageKey = await saveImageFile(prescriptionId, cleaned, contentType);

  return prisma.$transaction(async (tx) => {
    const last = await tx.prescriptionImage.findFirst({
      where: { prescriptionId },
      orderBy: { versionNo: "desc" },
      select: { versionNo: true },
    });

    const image = await tx.prescriptionImage.create({
      data: {
        prescriptionId,
        storageKey,
        contentType,
        sizeBytes: cleaned.length,
        versionNo: (last?.versionNo ?? 0) + 1,
        uploadedBy: userId,
      },
    });

    await tx.auditLog.create({
      data: {
        storeId: prescription.storeId,
        actorId: userId,
        action: "PRESCRIPTION_IMAGE_UPLOAD",
        resourceType: "prescription",
        resourceId: prescriptionId,
        after: { versionNo: image.versionNo, contentType, sizeBytes: cleaned.length },
      },
    });

    return { id: image.id, versionNo: image.versionNo };
  });
}

export async function readImageForStream(
  imageId: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const image = await prisma.prescriptionImage.findUnique({ where: { id: imageId } });
  if (!image) throw AppError.notFound("Không tìm thấy ảnh");

  const buffer = await readImageFile(image.storageKey);
  return { buffer, contentType: image.contentType };
}
