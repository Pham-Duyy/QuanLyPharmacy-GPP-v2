import { describe, expect, it } from "vitest";
import { stripExif } from "./strip-exif.js";

/** Một đoạn JPEG hợp lệ tối thiểu: marker, độ dài (gồm cả 2 byte độ dài), dữ liệu. */
function segment(marker: number, data: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

function makeJpeg(options: { withExif: boolean }): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0 (JFIF) phải luôn được giữ lại, dùng để kiểm tra không bị xóa nhầm.
  const app0 = segment(0xe0, Buffer.from("JFIF\0test-app0-data"));
  const app1Exif = segment(0xe1, Buffer.from("Exif\0\0fake-gps-and-camera-data"));
  const sos = segment(0xda, Buffer.from([0x01, 0x02, 0x03]));
  const scanData = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const eoi = Buffer.from([0xff, 0xd9]);

  const parts = [soi, app0];
  if (options.withExif) parts.push(app1Exif);
  parts.push(sos, scanData, eoi);
  return Buffer.concat(parts);
}

/** Một chunk PNG hợp lệ về cấu trúc; CRC không được strip-exif.ts kiểm tra nên điền tùy ý. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const fakeCrc = Buffer.from([0, 0, 0, 0]);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, fakeCrc]);
}

function makePng(options: { withExif: boolean }): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk(
    "IHDR",
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), // 1x1, 8-bit, RGBA
  );
  const exif = chunk("eXIf", Buffer.from("fake-gps-and-camera-data"));
  const idat = chunk("IDAT", Buffer.from([0x01, 0x02]));
  const iend = chunk("IEND", Buffer.alloc(0));

  const parts = [signature, ihdr];
  if (options.withExif) parts.push(exif);
  parts.push(idat, iend);
  return Buffer.concat(parts);
}

describe("stripExif — JPEG", () => {
  it("cắt bỏ đoạn APP1 (EXIF), giữ nguyên các đoạn khác và toàn bộ dữ liệu ảnh", () => {
    const withExif = makeJpeg({ withExif: true });
    const cleaned = stripExif(withExif, "image/jpeg");

    expect(cleaned.includes("fake-gps-and-camera-data")).toBe(false);
    expect(cleaned.includes("test-app0-data")).toBe(true);
    // Phần từ SOS trở đi (dữ liệu ảnh thật) phải giữ nguyên y hệt.
    const sosIndex = cleaned.indexOf(Buffer.from([0xff, 0xda]));
    expect(sosIndex).toBeGreaterThan(0);
  });

  it("không đụng gì tới ảnh vốn không có EXIF", () => {
    const withoutExif = makeJpeg({ withExif: false });
    const cleaned = stripExif(withoutExif, "image/jpeg");
    expect(cleaned.equals(withoutExif)).toBe(true);
  });

  it("trả lại ảnh gốc nếu không phải JPEG hợp lệ (không có SOI)", () => {
    const broken = Buffer.from("khong-phai-jpeg");
    expect(stripExif(broken, "image/jpeg").equals(broken)).toBe(true);
  });
});

describe("stripExif — PNG", () => {
  it("cắt bỏ chunk eXIf, giữ nguyên các chunk khác", () => {
    const withExif = makePng({ withExif: true });
    const cleaned = stripExif(withExif, "image/png");

    expect(cleaned.includes("fake-gps-and-camera-data")).toBe(false);
    expect(cleaned.includes("IHDR")).toBe(true);
    expect(cleaned.includes("IDAT")).toBe(true);
    expect(cleaned.includes("IEND")).toBe(true);
  });

  it("không đụng gì tới ảnh vốn không có eXIf", () => {
    const withoutExif = makePng({ withExif: false });
    const cleaned = stripExif(withoutExif, "image/png");
    expect(cleaned.equals(withoutExif)).toBe(true);
  });
});

describe("stripExif — PDF", () => {
  it("không có khái niệm EXIF, trả lại nguyên tệp", () => {
    const pdf = Buffer.from("%PDF-1.7\nkhong lien quan exif");
    expect(stripExif(pdf, "application/pdf").equals(pdf)).toBe(true);
  });
});
