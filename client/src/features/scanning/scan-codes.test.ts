import { describe, expect, it } from "vitest";
import { findErxCode } from "../prescriptions/eprescription-api.js";
import { productCodeFromScan } from "./scan-codes.js";

describe("nội dung quét bằng camera", () => {
  it("mã vạch thường giữ nguyên", () => {
    expect(productCodeFromScan(" 8934567100014 ")).toBe("8934567100014");
    expect(productCodeFromScan("TH0002")).toBe("TH0002");
  });

  it("GS1 DataMatrix trên hộp thuốc: lấy GTIN thành EAN-13", () => {
    expect(productCodeFromScan("0108934567100014172712311045A12")).toBe("8934567100014");
    expect(productCodeFromScan("]d20108934567100014\u001d10LOT1\u001d17271231")).toBe(
      "8934567100014",
    );
    expect(productCodeFromScan("0108934567100014")).toBe("8934567100014");
    // GTIN-14 không bắt đầu bằng 0 thì giữ đủ 14 số.
    expect(productCodeFromScan("0118934567100011")).toBe("18934567100011");
    // Chuỗi số dài bắt đầu bằng 01 nhưng không theo GS1: giữ nguyên.
    expect(productCodeFromScan("01089345671000149999")).toBe("01089345671000149999");
  });

  it("tìm mã đơn thuốc điện tử trong mã vạch hoặc mã QR", () => {
    expect(findErxCode("01001ab12cd3-c")).toBe("01001ab12cd3-c");
    expect(findErxCode("https://donthuoc.example/tra-cuu?ma=01001AB12CD3-n&x=1")).toBe(
      "01001AB12CD3-n",
    );
    expect(findErxCode("Mã đơn: 01001ab12cd3-y")).toBe("01001ab12cd3-y");
    expect(findErxCode("8934567100014")).toBeNull();
    expect(findErxCode("01001ab12cd3-x")).toBeNull();
    expect(findErxCode("x01001ab12cd3-c")).toBeNull();
  });
});
