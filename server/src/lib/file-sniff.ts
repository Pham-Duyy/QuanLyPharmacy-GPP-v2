/**
 * Nhận diện định dạng tệp theo đúng nội dung byte đầu tệp (magic number),
 * không tin vào Content-Type hay đuôi tệp client gửi lên — contract §12
 * yêu cầu "kiểm tra theo nội dung tệp" vì cả hai đều dễ giả mạo.
 */
export type SniffedType = "image/jpeg" | "image/png" | "application/pdf";

export function sniffFileType(buffer: Buffer): SniffedType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length >= 8 && PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    return "image/png";
  }

  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }

  return null;
}
