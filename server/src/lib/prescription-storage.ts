import { createFileStorage } from "./file-storage.js";

/** Ảnh/tệp đơn thuốc: storage/prescriptions (contract §12). */
const storage = createFileStorage("prescriptions");

export function saveImageFile(
  prescriptionId: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  return storage.save(prescriptionId, buffer, contentType);
}

export function readImageFile(storageKey: string): Promise<Buffer> {
  return storage.read(storageKey);
}

export function deleteImageFile(storageKey: string): Promise<void> {
  return storage.remove(storageKey);
}
