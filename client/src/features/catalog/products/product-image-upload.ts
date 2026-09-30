import { http } from "../../../api/http.js";
import type { Envelope, ProductImage } from "../../../api/types.js";

/** Trình duyệt giải mã được; server chỉ nhận JPG/PNG nên WEBP được vẽ lại thành JPG. */
export const IMAGE_ACCEPT = ["image/jpeg", "image/png", "image/webp"];
/** Ảnh gốc trước khi thu nhỏ: ảnh máy ảnh rời cũng hiếm khi vượt mức này. */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 8;

/**
 * Thu nhỏ ảnh ngay trên trình duyệt: ảnh chụp điện thoại thường vài MB,
 * danh sách chỉ cần vài chục KB. Vẽ lại qua canvas cũng bỏ luôn EXIF.
 */
async function resizeImage(file: File, maxSide: number, keepPng: boolean): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Tệp không phải ảnh hợp lệ hoặc đã hỏng");
  });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Trình duyệt không xử lý được ảnh");
    const type = keepPng ? "image/png" : "image/jpeg";
    if (!keepPng) {
      // JPEG không có nền trong suốt: tô trắng để ảnh PNG/WEBP trong suốt không thành nền đen.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Không nén được ảnh"))),
        type,
        0.86,
      ),
    );
  } finally {
    bitmap.close();
  }
}

/** Chặn sớm tệp không phải ảnh để không tốn công gửi lên rồi bị server từ chối. */
function checkImageFile(file: File): void {
  if (!IMAGE_ACCEPT.includes(file.type)) throw new Error("Chỉ nhận ảnh JPG, PNG hoặc WEBP");
  if (file.size > MAX_INPUT_BYTES) throw new Error("Ảnh lớn hơn 15 MB, hãy chọn ảnh khác");
}

/** Thu nhỏ rồi tải một ảnh lên cho sản phẩm. Ảnh đầu tiên tự thành ảnh chính. */
export async function uploadProductImage(productId: string, file: File): Promise<ProductImage> {
  checkImageFile(file);
  const keepPng = file.type === "image/png";
  let main = await resizeImage(file, 1600, keepPng);
  // PNG ảnh chụp nén kém, vượt trần 5 MB của server thì chuyển sang JPG.
  if (main.size > 4.5 * 1024 * 1024) main = await resizeImage(file, 1600, false);
  const thumb = await resizeImage(file, 320, false);

  const form = new FormData();
  form.append("file", main, keepPng && main.type === "image/png" ? "anh.png" : "anh.jpg");
  form.append("thumb", thumb, "thumb.jpg");
  const response = await http.post<Envelope<ProductImage>>(`/products/${productId}/images`, form);
  return response.data.data;
}
