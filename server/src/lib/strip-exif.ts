import type { SniffedType } from "./file-sniff.js";

/**
 * Ảnh chụp đơn thuốc bằng điện thoại thường mang theo EXIF — có thể có tọa
 * độ GPS nơi chụp, kiểu máy, thời điểm chính xác. Đây là dữ liệu định vị
 * gắn với hồ sơ sức khỏe của khách, nên phải xóa trước khi lưu (contract
 * §12). Không dùng thư viện xử lý ảnh (sharp...) để tránh phần phụ thuộc
 * biên dịch native chỉ cho một việc nhỏ — JPEG và PNG đều có cấu trúc dạng
 * đoạn (segment/chunk) đơn giản, tự đọc và bỏ đúng đoạn EXIF là đủ.
 */
export function stripExif(buffer: Buffer, type: SniffedType): Buffer {
  if (type === "image/jpeg") return stripJpegExif(buffer);
  if (type === "image/png") return stripPngExif(buffer);
  return buffer; // PDF không có khái niệm EXIF.
}

const JPEG_APP1_EXIF = 0xe1;
const JPEG_SOS = 0xda;
// Các marker không có 2 byte độ dài theo sau (SOI, EOI, RSTn, TEM).
const JPEG_NO_LENGTH = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

/** Cắt bỏ các đoạn APP1 (nơi EXIF nằm), giữ nguyên phần dữ liệu ảnh từ SOS trở đi. */
function stripJpegExif(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;

  const kept: Buffer[] = [buffer.subarray(0, 2)]; // SOI
  let pos = 2;

  while (pos + 1 < buffer.length) {
    // Byte đệm 0xFF lặp lại trước marker là hợp lệ trong chuẩn JPEG.
    if (buffer[pos] !== 0xff) break;
    let markerPos = pos + 1;
    while (buffer[markerPos] === 0xff) markerPos++;
    const marker = buffer[markerPos]!;
    const segmentStart = pos;

    if (marker === JPEG_SOS) {
      // Từ đây là dữ liệu ảnh đã mã hóa, không còn cấu trúc đoạn nữa — giữ nguyên phần còn lại.
      kept.push(buffer.subarray(segmentStart, buffer.length));
      return Buffer.concat(kept);
    }

    if (JPEG_NO_LENGTH.has(marker)) {
      kept.push(buffer.subarray(segmentStart, markerPos + 1));
      pos = markerPos + 1;
      continue;
    }

    const lengthPos = markerPos + 1;
    if (lengthPos + 1 >= buffer.length) break; // Tệp hỏng/cắt cụt, dừng an toàn.
    const length = buffer.readUInt16BE(lengthPos);
    const segmentEnd = lengthPos + length; // length tính cả 2 byte độ dài.

    if (marker !== JPEG_APP1_EXIF) {
      kept.push(buffer.subarray(segmentStart, segmentEnd));
    }
    // marker === APP1: bỏ hẳn đoạn này, không thêm vào kết quả.

    pos = segmentEnd;
  }

  // Không tìm thấy SOS nghĩa là tệp có cấu trúc bất thường không theo dự
  // đoán của bộ phân tích này — trả lại nguyên ảnh gốc còn an toàn hơn là
  // trả về một bản cắt dở dang có thể làm hỏng ảnh.
  return buffer;
}

const PNG_SIGNATURE_LENGTH = 8;

/** Cắt bỏ chunk "eXIf" (EXIF trong PNG hiện đại), giữ nguyên mọi chunk khác. */
function stripPngExif(buffer: Buffer): Buffer {
  if (buffer.length < PNG_SIGNATURE_LENGTH) return buffer;

  const kept: Buffer[] = [buffer.subarray(0, PNG_SIGNATURE_LENGTH)];
  let pos = PNG_SIGNATURE_LENGTH;

  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.subarray(pos + 4, pos + 8).toString("latin1");
    const chunkEnd = pos + 8 + length + 4; // 4 (length) + 4 (type) + data + 4 (CRC)
    if (chunkEnd > buffer.length) break; // Tệp hỏng/cắt cụt, dừng an toàn.

    if (type !== "eXIf") {
      kept.push(buffer.subarray(pos, chunkEnd));
    }

    pos = chunkEnd;
  }

  // PNG hợp lệ phải tiêu thụ vừa hết buffer (chunk cuối là IEND). Còn dư
  // nghĩa là gặp cấu trúc bất thường — trả lại ảnh gốc cho an toàn.
  if (pos !== buffer.length) return buffer;

  return Buffer.concat(kept);
}
