import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Đối chiếu số (Phase 4, bước 4.3; quyết định D16). Tất định, không gọi LLM.
 *
 * Mọi con số trong câu trả lời của Agent phải có trong kết quả tool của hội thoại
 * (hoặc trong câu hỏi, thời điểm hỏi). Số được phép viết lại theo kiểu Việt Nam
 * và làm tròn theo đúng số chữ số đã viết: "22,9 triệu" khớp 22.874.000 vì lệch
 * dưới nửa đơn vị cuối (0,05 triệu). Không cho phép số tự cộng, trừ, chia ra.
 *
 * Bỏ qua: chữ số dính chữ (NT01, Omega-3, B12, 500mg: tên riêng, đã có trong dữ
 * liệu), số thứ tự đầu dòng, số nguyên nhỏ 0–10 (đếm mục, "gấp 2 lần" vẫn là
 * phép tính nhưng chặn cả câu vì nó thì quá khắt khe) và các kỳ cố định của hệ
 * thống (7, 14, 28, 30, 60, 90 ngày).
 */

const SMALL_INTEGER = 10;
const SYSTEM_PERIODS = [7, 14, 28, 30, 60, 90];

const SCALES: Array<[RegExp, number]> = [
  [/^(nghìn|ngàn|k)$/i, 1e3],
  [/^(triệu|tr)$/i, 1e6],
  [/^(tỷ|tỉ)$/i, 1e9],
];

export type KnownFacts = {
  numbers: number[];
  /** Ngày dạng YYYY-MM-DD. */
  dates: Set<string>;
  /** Giờ dạng HH:MM. */
  times: Set<string>;
};

export type Verification = {
  /** Số token số đã kiểm. */
  checked: number;
  /** Các cụm số không tìm thấy nguồn, đúng như viết trong câu trả lời. */
  unverified: string[];
};

const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/g;
const VN_DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/g;
const TIME = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g;
const NUMBER_IN_TEXT = /-?\d+(?:[.,]\d+)*/g;

function pad(value: string | number): string {
  return String(value).padStart(2, "0");
}

/** Gom mọi số, ngày, giờ có trong kết quả tool và câu hỏi của hội thoại. */
export function collectFacts(messages: BetaMessageParam[], extraTexts: string[] = []): KnownFacts {
  const facts: KnownFacts = { numbers: [...SYSTEM_PERIODS], dates: new Set(), times: new Set() };
  const addText = (text: string) => {
    for (const match of text.matchAll(ISO_DATE)) {
      facts.dates.add(`${match[1]}-${match[2]}-${match[3]}`);
      if (match[4]) facts.times.add(`${match[4]}:${match[5]}`);
    }
    for (const match of text.matchAll(VN_DATE)) {
      if (match[3]) facts.dates.add(`${match[3]}-${pad(match[2]!)}-${pad(match[1]!)}`);
    }
    for (const match of text.matchAll(TIME)) facts.times.add(`${pad(match[1]!)}:${match[2]}`);
    for (const token of text.replace(ISO_DATE, " ").matchAll(NUMBER_IN_TEXT)) {
      for (const value of readings(token[0])) facts.numbers.push(value);
    }
  };
  const walk = (value: unknown): void => {
    if (typeof value === "number") facts.numbers.push(value);
    else if (typeof value === "string") addText(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };

  for (const message of messages) {
    if (message.role !== "user") continue;
    // Câu hỏi (kèm bối cảnh) là chuỗi; nhắc nhở của server (khối text trong mảng) không tính là nguồn.
    if (typeof message.content === "string") {
      addText(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.is_error) continue;
      const parts = typeof block.content === "string" ? [block.content] : (block.content ?? []);
      for (const part of parts) {
        const raw = typeof part === "string" ? part : part.type === "text" ? part.text : "";
        try {
          walk(JSON.parse(raw));
        } catch {
          addText(raw);
        }
      }
    }
  }
  extraTexts.forEach(addText);
  return facts;
}

/**
 * Các cách đọc một cụm số. "1.250" có thể là 1250 (kiểu Việt) hoặc 1,25 (kiểu
 * Anh); "22,9" là 22,9; "1,250,000" là 1250000. Trả về mọi cách đọc hợp lý kèm
 * nửa đơn vị của chữ số cuối (độ lệch do làm tròn).
 */
function parseVariants(token: string): Array<{ value: number; half: number }> {
  const sign = /^[-−]/.test(token) ? -1 : 1;
  const body = token.replace(/^[-−+]/, "");
  const variants: Array<{ value: number; half: number }> = [];
  const add = (integer: string, fraction: string) => {
    const value = Number(`${integer}.${fraction || "0"}`);
    if (Number.isFinite(value))
      variants.push({ value: sign * value, half: 0.5 * 10 ** -fraction.length });
  };
  const dotGroups = /^\d{1,3}(\.\d{3})+(,\d+)?$/;
  const commaGroups = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
  if (dotGroups.test(body)) {
    const [integer, fraction = ""] = body.split(",");
    add(integer!.replaceAll(".", ""), fraction);
  }
  if (commaGroups.test(body)) {
    const [integer, fraction = ""] = body.split(".");
    add(integer!.replaceAll(",", ""), fraction);
  }
  // Một dấu phân cách duy nhất: đọc như dấu thập phân.
  const single = /^(\d+)[.,](\d+)$/.exec(body);
  if (single) add(single[1]!, single[2]!);
  if (/^\d+$/.test(body)) add(body, "");
  return variants;
}

function readings(token: string): number[] {
  return parseVariants(token).map((variant) => variant.value);
}

type NumberToken = {
  text: string;
  variants: Array<{ value: number; half: number }>;
  percent: boolean;
};

/** Bỏ ngày, giờ ra khỏi câu (kiểm riêng), trả về phần còn lại và các cụm ngày giờ không khớp. */
function checkDatesAndTimes(answer: string, facts: KnownFacts) {
  const unverified: string[] = [];
  let checked = 0;
  const days = [...facts.dates];
  const months = new Set(days.map((date) => date.slice(0, 7)));
  const years = new Set(days.map((date) => date.slice(0, 4)));

  let rest = answer.replace(ISO_DATE, (match, year, month, day) => {
    checked += 1;
    if (!facts.dates.has(`${year}-${month}-${day}`)) unverified.push(match);
    return " ";
  });
  rest = rest.replace(VN_DATE, (match, day, month, year) => {
    checked += 1;
    const suffix = `-${pad(month)}-${pad(day)}`;
    const found = year
      ? facts.dates.has(`${year}${suffix}`)
      : days.some((date) => date.endsWith(suffix));
    if (!found) unverified.push(match);
    return " ";
  });
  rest = rest.replace(/tháng\s+(\d{1,2})(?:(?:\/|\s+năm\s+)(\d{4}))?/gi, (match, month, year) => {
    checked += 1;
    const found = year
      ? months.has(`${year}-${pad(month)}`)
      : [...months].some((value) => value.endsWith(`-${pad(month)}`));
    if (!found) unverified.push(match);
    return " ";
  });
  rest = rest.replace(/năm\s+(\d{4})/gi, (match, year) => {
    checked += 1;
    if (!years.has(year)) unverified.push(match);
    return " ";
  });
  rest = rest.replace(TIME, (match, hour, minute) => {
    checked += 1;
    if (!facts.times.has(`${pad(hour)}:${minute}`)) unverified.push(match);
    return " ";
  });
  return { rest, checked, unverified };
}

function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  // Số thứ tự đầu dòng: "1. ", "2) ".
  const cleaned = text.replace(/^\s*\d+[.)]\s/gm, " ");
  const pattern =
    /(?<![\p{L}\d.,])([-−+]?\d+(?:[.,]\d+)*)(?![\p{L}\d])(?:\s*(%)|\s*(nghìn|ngàn|triệu|tỷ|tỉ|tr|k)(?![\p{L}]))?/gu;
  for (const match of cleaned.matchAll(pattern)) {
    // Chữ số dính chữ phía sau ("500mg") đã loại bởi lookahead; dính chữ phía trước qua "-" ("Omega-3") loại ở đây.
    if (/\p{L}[-−]$/u.test(cleaned.slice(Math.max(0, match.index - 2), match.index))) continue;
    const scale = match[3] ? (SCALES.find(([word]) => word.test(match[3]!))?.[1] ?? 1) : 1;
    tokens.push({
      text: match[0].trim(),
      percent: Boolean(match[2]),
      variants: parseVariants(match[1]!).map(({ value, half }) => ({
        value: value * scale,
        half: half * scale,
      })),
    });
  }
  return tokens;
}

function matches(token: NumberToken, known: number[]): boolean {
  return token.variants.some(({ value, half }) => {
    const target = Math.abs(value);
    // Số nguyên nhỏ không kèm đơn vị: đếm mục, không kiểm.
    if (!token.percent && Number.isInteger(target) && target <= SMALL_INTEGER && half === 0.5)
      return true;
    const tolerance = half + 1e-9;
    return known.some((candidate) => {
      const base = Math.abs(candidate);
      if (Math.abs(base - target) <= tolerance) return true;
      // Tỷ lệ lưu dạng 0,09 nhưng viết 9%.
      return token.percent && Math.abs(base * 100 - target) <= tolerance;
    });
  });
}

/** Kiểm mọi số, ngày, giờ trong câu trả lời. */
export function verifyAnswer(answer: string, facts: KnownFacts): Verification {
  const dated = checkDatesAndTimes(answer, facts);
  const tokens = numberTokens(dated.rest);
  const unverified = [...dated.unverified];
  for (const token of tokens) {
    if (token.variants.length === 0 || !matches(token, facts.numbers)) unverified.push(token.text);
  }
  return { checked: dated.checked + tokens.length, unverified: [...new Set(unverified)] };
}

/** Tin nhắn yêu cầu sửa: gửi kèm lịch sử (khối text trong mảng, không tính là nguồn số). */
export function correctionTurn(unverified: string[]): BetaMessageParam {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Kiểm tra tự động: các số sau trong câu trả lời không có trong kết quả tool: ${unverified.join("; ")}. Viết lại toàn bộ câu trả lời, chỉ dùng số có nguyên văn trong kết quả tool (có thể gọi thêm tool). Không tự cộng, trừ, chia. Số nào không có nguồn thì bỏ, hoặc nói hệ thống chưa có số đó.`,
      },
    ],
  };
}

/** Các cụm số trong câu trả lời (đã tách ngày, giờ) kèm mọi cách đọc: bộ đánh giá (bước 4.6) dùng. */
export function answerNumbers(
  answer: string,
): Array<{ text: string; percent: boolean; readings: Array<{ value: number; half: number }> }> {
  const none: KnownFacts = { numbers: [], dates: new Set(), times: new Set() };
  return numberTokens(checkDatesAndTimes(answer, none).rest).map((token) => ({
    text: token.text,
    percent: token.percent,
    readings: token.variants,
  }));
}
