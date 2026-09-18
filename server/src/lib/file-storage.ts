import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lưu tệp tải lên ngoài thư mục public (contract §12): `app.ts` không có
 * `express.static`, nên thư mục này không truy cập trực tiếp được qua URL,
 * chỉ đọc được qua endpoint có kiểm tra chữ ký (`signed-url.ts`).
 */
const STORAGE_BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../storage");

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

export type FileStorage = {
  /**
   * Ghi tệp, trả về `storageKey` để lưu vào CSDL. Khóa do server tự sinh
   * (UUID), không lấy từ tên tệp người dùng gửi lên, nên đọc lại không có
   * rủi ro dò đường dẫn ra ngoài thư mục lưu trữ.
   */
  save(ownerId: string, buffer: Buffer, contentType: string, suffix?: string): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
};

export function createFileStorage(area: string): FileStorage {
  const root = path.join(STORAGE_BASE, area);
  return {
    async save(ownerId, buffer, contentType, suffix = "") {
      const dir = path.join(root, ownerId);
      await mkdir(dir, { recursive: true });
      const extension = EXTENSION_BY_TYPE[contentType] ?? "bin";
      const fileName = `${randomUUID()}${suffix}.${extension}`;
      await writeFile(path.join(dir, fileName), buffer);
      return `${ownerId}/${fileName}`;
    },
    read(storageKey) {
      return readFile(path.join(root, storageKey));
    },
    async remove(storageKey) {
      await unlink(path.join(root, storageKey)).catch(() => {
        // Xóa bản ghi CSDL vẫn nên thành công dù tệp trên đĩa đã mất sẵn.
      });
    },
  };
}
