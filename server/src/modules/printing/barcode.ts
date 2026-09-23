/**
 * Sinh mã vạch dạng SVG để in tem.
 *
 * Mã vạch in sai còn tệ hơn không in: máy quét sẽ ra một mã khác, bán nhầm
 * thuốc. Vì vậy ở đây chỉ nhận mã đã kiểm số kiểm (EAN-13, EAN-8); mã không
 * đúng chuẩn EAN thì in Code128 nguyên văn chứ **không bao giờ tự bịa** số
 * kiểm hay đổi mã của nhà sản xuất.
 */

export type BarcodeKind = "EAN13" | "EAN8" | "CODE128";

// Bảng mã EAN: L (lẻ), G (chẵn) cho nửa trái, R cho nửa phải.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];

/** Kiểu đan L/G của 6 chữ số nửa trái, quyết định bởi chữ số đầu tiên. */
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/**
 * Bảng độ rộng vạch/khoảng trắng của Code128 (107 ký tự). Mỗi chuỗi là độ
 * rộng lần lượt vạch–trắng–vạch–trắng–vạch–trắng.
 */
const CODE128 = [
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
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const CODE128_START_B = 104;
const CODE128_STOP = 106;

/** Số kiểm của mã EAN: nhân xen kẽ 1 và 3 từ phải sang trái. */
export function eanCheckDigit(digitsWithoutCheck: string): number {
  const digits = [...digitsWithoutCheck].map(Number);
  const sum = digits.reduceRight((total, digit, index) => total + digit * ((digits.length - index) % 2 === 1 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan(value: string): boolean {
  if (!/^\d{8}$|^\d{13}$/.test(value)) return false;
  return eanCheckDigit(value.slice(0, -1)) === Number(value.at(-1));
}

/** Chọn chuẩn mã vạch phù hợp với giá trị; không ép mã sai thành EAN. */
export function detectKind(value: string): BarcodeKind {
  if (/^\d{13}$/.test(value) && isValidEan(value)) return "EAN13";
  if (/^\d{8}$/.test(value) && isValidEan(value)) return "EAN8";
  return "CODE128";
}

function encodeEan13(value: string): string {
  const digits = [...value].map(Number);
  const parity = PARITY[digits[0]!]!;
  const left = digits
    .slice(1, 7)
    .map((digit, index) => (parity[index] === "L" ? L[digit]! : G[digit]!))
    .join("");
  const right = digits
    .slice(7)
    .map((digit) => R[digit]!)
    .join("");
  return `101${left}01010${right}101`;
}

function encodeEan8(value: string): string {
  const digits = [...value].map(Number);
  const left = digits
    .slice(0, 4)
    .map((digit) => L[digit]!)
    .join("");
  const right = digits
    .slice(4)
    .map((digit) => R[digit]!)
    .join("");
  return `101${left}01010${right}101`;
}

/** Code128 bộ B: in được chữ và số, dùng cho mã nội bộ của nhà thuốc. */
function encodeCode128(value: string): string {
  const codes = [CODE128_START_B];
  for (const character of value) {
    const code = character.charCodeAt(0) - 32;
    if (code < 0 || code > 94) {
      throw new Error(`Ký tự "${character}" không in được bằng Code128 bộ B`);
    }
    codes.push(code);
  }
  const checksum = codes.reduce((total, code, index) => total + code * (index === 0 ? 1 : index), 0) % 103;
  codes.push(checksum, CODE128_STOP);

  return codes
    .map((code) =>
      [...CODE128[code]!]
        .map((width, index) => (index % 2 === 0 ? "1" : "0").repeat(Number(width)))
        .join(""),
    )
    .join("");
}

/** Chuỗi bit của mã vạch: "1" là vạch đen, "0" là khoảng trắng. */
export function encodeBars(value: string, kind: BarcodeKind = detectKind(value)): string {
  if (kind === "EAN13") {
    if (!/^\d{13}$/.test(value) || !isValidEan(value)) throw new Error(`"${value}" không phải mã EAN-13 hợp lệ`);
    return encodeEan13(value);
  }
  if (kind === "EAN8") {
    if (!/^\d{8}$/.test(value) || !isValidEan(value)) throw new Error(`"${value}" không phải mã EAN-8 hợp lệ`);
    return encodeEan8(value);
  }
  return encodeCode128(value);
}

export type BarcodeOptions = {
  /** Chiều cao vùng vạch, tính bằng mm. */
  heightMm?: number;
  /** Bề rộng một module (vạch mảnh nhất), mm. Dưới 0,25mm nhiều máy quét đọc sai. */
  moduleMm?: number;
};

/**
 * Vẽ mã vạch thành SVG theo đơn vị mm để in ra đúng kích thước thật, không
 * phụ thuộc DPI của máy in.
 */
export function barcodeSvg(value: string, options: BarcodeOptions = {}): { svg: string; kind: BarcodeKind; widthMm: number } {
  const kind = detectKind(value);
  const bars = encodeBars(value, kind);
  const moduleMm = options.moduleMm ?? 0.33;
  const heightMm = options.heightMm ?? 12;
  const widthMm = Number((bars.length * moduleMm).toFixed(2));

  const rects: string[] = [];
  let index = 0;
  while (index < bars.length) {
    if (bars[index] === "0") {
      index++;
      continue;
    }
    let run = 0;
    while (index + run < bars.length && bars[index + run] === "1") run++;
    rects.push(`<rect x="${(index * moduleMm).toFixed(3)}" y="0" width="${(run * moduleMm).toFixed(3)}" height="${heightMm}" />`);
    index += run;
  }

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}" shape-rendering="crispEdges"><g fill="#000">${rects.join("")}</g></svg>`,
    kind,
    widthMm,
  };
}
