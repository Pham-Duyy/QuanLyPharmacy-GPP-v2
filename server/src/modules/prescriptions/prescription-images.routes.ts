import { Router } from "express";
import multer from "multer";
import { AppError } from "../../lib/app-error.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { verifySignedImageUrl } from "../../lib/signed-url.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import * as service from "./prescription-images.service.js";

export const prescriptionImagesRouter = Router();

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB, đủ cho ảnh chụp điện thoại hoặc PDF quét.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

prescriptionImagesRouter.post(
  "/prescriptions/:id/images",
  authenticate,
  storeContext,
  requirePermission("prescription.create"),
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      throw new AppError(
        400,
        "BAD_REQUEST",
        "Thiếu tệp, gửi dạng multipart/form-data với field 'file'",
      );
    }
    const id = String(req.params.id);
    const image = await withMappedErrors(() =>
      service.uploadImage(id, req.auth!.userId, req.file!.buffer),
    );
    sendData(res, image, 201);
  },
);

/**
 * Đọc ảnh qua URL có chữ ký, không qua `authenticate` — ảnh hiển thị bằng
 * thẻ <img>, trình duyệt không gắn được header Authorization vào request
 * đó, nên bản thân chữ ký hạn ngắn đóng vai trò xác thực (xem signed-url.ts).
 * Đặt ở tiền tố "/rx-images" khác hẳn "/prescriptions" để không lọt vào
 * middleware `authenticate` của router đơn thuốc.
 */
prescriptionImagesRouter.get("/rx-images/:imageId", async (req, res) => {
  const imageId = String(req.params.imageId);
  const expires = Number(req.query["expires"]);
  const sig = String(req.query["sig"] ?? "");

  if (!verifySignedImageUrl(imageId, expires, sig)) {
    throw new AppError(403, "FORBIDDEN", "Đường dẫn xem ảnh đã hết hạn hoặc không hợp lệ");
  }

  const { buffer, contentType } = await service.readImageForStream(imageId);
  res.set("Content-Type", contentType);
  res.set("Content-Disposition", "inline");
  res.set("Cache-Control", "private, max-age=60");
  res.send(buffer);
});
