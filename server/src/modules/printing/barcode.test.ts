import { describe, expect, it } from "vitest";
import { barcodeSvg, detectKind, eanCheckDigit, encodeBars, isValidEan } from "./barcode.js";

/**
 * Test tự giải mã ngược chuỗi bit, không so với hằng số chép tay: nếu bảng mã
 * hay thuật toán sai thì bước giải mã sẽ ra mã khác mã đầu vào.
 */

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Giải mã EAN-13 từ chuỗi bit, như máy quét đọc. */
function decodeEan13(bars: string): string {
  expect(bars).toHaveLength(95);
  expect(bars.slice(0, 3)).toBe("101");
  expect(bars.slice(45, 50)).toBe("01010");
  expect(bars.slice(92)).toBe("101");

  let parity = "";
  let digits = "";
  for (let index = 0; index < 6; index++) {
    const chunk = bars.slice(3 + index * 7, 10 + index * 7);
    const asL = L.indexOf(chunk);
    const asG = G.indexOf(chunk);
    if (asL >= 0) {
      parity += "L";
      digits += asL;
    } else if (asG >= 0) {
      parity += "G";
      digits += asG;
    } else {
      throw new Error(`Nhóm bit nửa trái không hợp lệ: ${chunk}`);
    }
  }
  const first = PARITY.indexOf(parity);
  if (first < 0) throw new Error(`Kiểu đan L/G không hợp lệ: ${parity}`);

  let right = "";
  for (let index = 0; index < 6; index++) {
    const chunk = bars.slice(50 + index * 7, 57 + index * 7);
    const value = R.indexOf(chunk);
    if (value < 0) throw new Error(`Nhóm bit nửa phải không hợp lệ: ${chunk}`);
    right += value;
  }
  return `${first}${digits}${right}`;
}

/** Đổi chuỗi bit thành độ rộng vạch/trắng để đối chiếu bảng Code128. */
function widthsOf(bars: string): string {
  const runs: number[] = [];
  let index = 0;
  while (index < bars.length) {
    let run = 1;
    while (index + run < bars.length && bars[index + run] === bars[index]) run++;
    runs.push(run);
    index += run;
  }
  return runs.join("");
}

describe("Số kiểm mã EAN", () => {
  it("tính đúng số kiểm và bắt được mã sai", () => {
    // Mã ví dụ chuẩn của EAN-13 và một mã EAN-8 hợp lệ.
    expect(eanCheckDigit("590123412345")).toBe(7);
    expect(isValidEan("5901234123457")).toBe(true);
    expect(isValidEan("5901234123456")).toBe(false);
    expect(eanCheckDigit("9638507")).toBe(4);
    expect(isValidEan("96385074")).toBe(true);
    expect(isValidEan("12345678901")).toBe(false);
  });

  it("mã không đúng chuẩn EAN thì dùng Code128, không tự sửa thành EAN", () => {
    expect(detectKind("5901234123457")).toBe("EAN13");
    expect(detectKind("96385074")).toBe("EAN8");
    // Sai số kiểm: tuyệt đối không được nhận là EAN rồi in mã khác đi.
    expect(detectKind("5901234123456")).toBe("CODE128");
    expect(detectKind("TH0001")).toBe("CODE128");
    expect(detectKind("890123456789")).toBe("CODE128");
  });
});

describe("Mã vạch EAN", () => {
  it("EAN-13 giải mã ngược ra đúng mã ban đầu", () => {
    for (const value of ["5901234123457", "8935049500005", "0000000000000"]) {
      if (!isValidEan(value)) continue;
      expect(decodeEan13(encodeBars(value))).toBe(value);
    }
    const generated = `893504950000${eanCheckDigit("893504950000")}`;
    expect(decodeEan13(encodeBars(generated))).toBe(generated);
  });

  it("EAN-8 có đủ mốc bắt đầu, giữa, kết thúc", () => {
    const bars = encodeBars("96385074");
    expect(bars).toHaveLength(67);
    expect(bars.slice(0, 3)).toBe("101");
    expect(bars.slice(31, 36)).toBe("01010");
    expect(bars.slice(64)).toBe("101");
  });

  it("không nhận mã EAN sai số kiểm", () => {
    expect(() => encodeBars("5901234123456", "EAN13")).toThrow(/không phải mã EAN-13 hợp lệ/);
    expect(() => encodeBars("96385070", "EAN8")).toThrow(/không phải mã EAN-8 hợp lệ/);
  });
});

describe("Mã vạch Code128", () => {
  it("có mốc bắt đầu bộ B, mốc kết thúc và số kiểm đúng", () => {
    const bars = encodeBars("TH0001");
    // Mốc bắt đầu bộ B và mốc kết thúc theo chuẩn Code128.
    expect(bars.startsWith("11010010000")).toBe(true);
    expect(bars.endsWith("1100011101011")).toBe(true);
    // 6 ký tự + start + checksum = 8 ký tự 11 module, cộng mốc kết thúc 13 module.
    expect(bars).toHaveLength(8 * 11 + 13);

    // Số kiểm: tự tính lại theo công thức rồi đối chiếu với bảng độ rộng.
    const codes = [104, ...[..."TH0001"].map((character) => character.charCodeAt(0) - 32)];
    const checksum = codes.reduce((total, code, index) => total + code * (index === 0 ? 1 : index), 0) % 103;
    const checksumBars = bars.slice(-24, -13);
    expect(widthsOf(checksumBars)).toBe(
      [
        "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
        "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
        "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
        "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
        "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
        "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
        "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
        "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
        "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
        "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
        "114131", "311141", "411131", "211412", "211214", "211232",
      ][checksum],
    );
  });

  it("từ chối ký tự không in được bằng bộ B", () => {
    expect(() => encodeBars("Thuốc")).toThrow(/không in được bằng Code128/);
  });
});

describe("Ảnh SVG mã vạch", () => {
  it("vẽ theo đơn vị mm để in ra đúng kích thước thật", () => {
    const result = barcodeSvg("5901234123457", { heightMm: 10, moduleMm: 0.33 });
    expect(result.kind).toBe("EAN13");
    expect(result.widthMm).toBeCloseTo(95 * 0.33, 2);
    expect(result.svg).toContain(`width="${result.widthMm}mm"`);
    expect(result.svg).toContain('height="10mm"');
    // Mỗi cụm vạch đen là một rect; mã EAN-13 luôn có đúng 30 cụm.
    expect(result.svg.match(/<rect /g)).toHaveLength(30);
    expect(result.svg).toContain("shape-rendering=\"crispEdges\"");
  });
});
