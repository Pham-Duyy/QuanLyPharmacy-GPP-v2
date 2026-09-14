import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lưu ngoài thư mục public (contract §12): thư mục này không nằm dưới bất
 * kỳ đường dẫn nào Express phục vụ tĩnh — `app.ts` không có
 * `express.static`, nên đây vốn đã không truy cập trực tiếp được qua URL,
 * chỉ đọc được qua endpoint có kiểm tra chữ ký (`signed-url.ts`).
 */
const STORAGE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../storage/prescriptions",
);

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

/**
 * Ghi tệp xuống đĩa, trả về `storageKey` để lưu vào CSDL. Khóa do server
 * tự sinh (UUID), không lấy từ tên tệp người dùng gửi lên, nên đọc lại qua
 * `readImageFile` không có rủi ro dò đường dẫn ra ngoài thư mục lưu trữ.
 */
export async function saveImageFile(
  prescriptionId: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const dir = path.join(STORAGE_ROOT, prescriptionId);
  await mkdir(dir, { recursive: true });
  const extension = EXTENSION_BY_TYPE[contentType] ?? "bin";
  const fileName = `${randomUUID()}.${extension}`;
  await writeFile(path.join(dir, fileName), buffer);
  return `${prescriptionId}/${fileName}`;
}

export async function readImageFile(storageKey: string): Promise<Buffer> {
  return readFile(path.join(STORAGE_ROOT, storageKey));
}

export async function deleteImageFile(storageKey: string): Promise<void> {
  await unlink(path.join(STORAGE_ROOT, storageKey)).catch(() => {
    // Xóa bản ghi CSDL vẫn nên thành công dù tệp trên đĩa đã mất sẵn.
  });
}
