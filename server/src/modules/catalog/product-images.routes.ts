import { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { verifySignedImageUrl } from "../../lib/signed-url.js";
import { PRODUCT_IMAGE_SCOPE, readForStream } from "./product-images.service.js";

export const productImagesRouter = Router();

/**
 * GET /api/v1/product-images/{id}?v=full|thumb&expires&sig: đọc ảnh sản
 * phẩm qua URL có chữ ký, không qua `authenticate` — ảnh hiển thị bằng thẻ
 * <img>, trình duyệt không gắn được header Authorization (xem signed-url.ts).
 * Tiền tố "/product-images" khác "/products" để không lọt vào middleware
 * đăng nhập của router sản phẩm.
 */
productImagesRouter.get("/product-images/:imageId", async (req, res) => {
  const imageId = String(req.params.imageId);
  const variant = req.query["v"] === "full" ? "full" : "thumb";
  const expires = Number(req.query["expires"]);
  const sig = String(req.query["sig"] ?? "");

  if (!verifySignedImageUrl(`${imageId}:${variant}`, expires, sig, PRODUCT_IMAGE_SCOPE)) {
    throw new AppError(403, "FORBIDDEN", "Đường dẫn ảnh đã hết hạn hoặc không hợp lệ");
  }

  const { buffer, contentType } = await readForStream(imageId, variant);
  const maxAge = Math.max(0, expires - Math.floor(Date.now() / 1000));
  res.set("Content-Type", contentType);
  res.set("Content-Disposition", "inline");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", `private, max-age=${maxAge}, immutable`);
  res.send(buffer);
});
