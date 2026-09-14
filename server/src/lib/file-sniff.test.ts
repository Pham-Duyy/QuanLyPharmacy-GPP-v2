import { describe, expect, it } from "vitest";
import { sniffFileType } from "./file-sniff.js";

describe("sniffFileType", () => {
  it("nhận diện JPEG theo magic byte, không cần đuôi tệp", () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffFileType(buffer)).toBe("image/jpeg");
  });

  it("nhận diện PNG theo magic byte", () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(sniffFileType(buffer)).toBe("image/png");
  });

  it("nhận diện PDF theo magic byte", () => {
    const buffer = Buffer.from("%PDF-1.7\n...");
    expect(sniffFileType(buffer)).toBe("application/pdf");
  });

  it("từ chối tệp giả mạo đuôi .jpg nhưng nội dung không phải ảnh", () => {
    const buffer = Buffer.from("<html><body>không phải ảnh</body></html>");
    expect(sniffFileType(buffer)).toBeNull();
  });

  it("từ chối tệp rỗng hoặc quá ngắn", () => {
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
    expect(sniffFileType(Buffer.from([0xff]))).toBeNull();
  });
});
