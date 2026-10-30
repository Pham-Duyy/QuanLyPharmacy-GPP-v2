import type { AgentResult, AgentStatus } from "../agent.js";
import { answerNumbers } from "../verify.js";

/**
 * Chấm điểm câu trả lời của AI Agent (Phase 4, bước 4.6). Tất định, không dùng LLM
 * làm giám khảo: đáp án đúng lấy từ chính analytics-service lúc chạy.
 *
 * Đối chiếu số (bước 4.3) chỉ biết "số này có trong kết quả tool không"; bộ chấm
 * này kiểm thêm "đúng số của câu hỏi chưa" (doanh thu CH02 chứ không phải CH01),
 * tên thuốc, tool đã gọi, và các câu phải từ chối hay phải nói "chưa có dữ liệu".
 */

export type Expected = {
  /** Số phải có trong câu trả lời (cho phép làm tròn theo cách viết, bỏ dấu). */
  values?: Array<{ label: string; value: number }>;
  /** Số KHÔNG được có (ví dụ số toàn chuỗi khi người hỏi không được xem). */
  forbiddenValues?: Array<{ label: string; value: number }>;
  /** Tên (thuốc, cửa hàng) phải được nhắc. */
  names?: string[];
};

export type GradeSpec = {
  /** Trạng thái chấp nhận; mặc định chỉ "answered". */
  statuses?: AgentStatus[];
  /** Mỗi tool trong danh sách phải được gọi thành công ít nhất một lần. */
  tools?: string[];
  /** Không được gọi tool nào (câu ngoài phạm vi, yêu cầu ghi dữ liệu). */
  noTools?: boolean;
  /** Câu trả lời phải khớp mọi mẫu (bỏ dấu, không phân biệt hoa thường). */
  mentions?: RegExp[];
  /** Câu trả lời không được có số tiền, phần trăm (câu "chưa có dữ liệu"). */
  noMoney?: boolean;
};

export type Check = { name: string; pass: boolean; detail?: string };

/** Bỏ dấu tiếng Việt, chữ thường: so tên và mẫu câu không phụ thuộc cách gõ. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Câu trả lời có nhắc số `value` không (đúng cách làm tròn đã viết, bỏ dấu, tỷ lệ ×100). */
export function mentionsValue(answer: string, value: number): boolean {
  const target = Math.abs(value);
  return answerNumbers(answer).some((token) =>
    token.readings.some(({ value: read, half }) => {
      const written = Math.abs(read);
      const tolerance = half + 1e-9;
      if (Math.abs(written - target) <= tolerance) return true;
      return token.percent && Math.abs(written - target * 100) <= tolerance;
    }),
  );
}

const DOSAGE = /^\d+([.,]\d+)?(mg|g|ml|mcg|iu|ui|%|vien|goi|ong)?$/i;

/** Tên có trong câu trả lời: nguyên văn, hoặc bỏ phần hàm lượng ("Losartan 50mg" → "Losartan"). */
export function mentionsName(answer: string, name: string): boolean {
  const text = fold(answer);
  const full = fold(name).trim();
  const core = full
    .split(/\s+/)
    .filter((word) => !DOSAGE.test(word))
    .join(" ");
  return text.includes(full) || (core.length >= 4 && text.includes(core));
}

const MONEY_OR_PERCENT = /\d[\d.,]*\s*(%|đ|d\b|dong|đồng|nghìn|ngàn|triệu|tỷ|tỉ|vnd)/i;

export function grade(result: AgentResult, spec: GradeSpec, expected: Expected = {}): Check[] {
  const checks: Check[] = [];
  const answer = result.answer ?? "";
  const statuses = spec.statuses ?? ["answered"];
  checks.push({
    name: "trạng thái",
    pass: statuses.includes(result.status),
    detail: `${result.status}${result.error ? ` (${result.error})` : ""}`,
  });

  const called = new Set(result.toolCalls.filter((call) => call.ok).map((call) => call.name));
  for (const tool of spec.tools ?? []) {
    checks.push({ name: `gọi ${tool}`, pass: called.has(tool) });
  }
  if (spec.noTools) {
    checks.push({
      name: "không gọi tool",
      pass: result.toolCalls.length === 0,
      detail: result.toolCalls.map((call) => call.name).join(", "),
    });
  }

  for (const { label, value } of expected.values ?? []) {
    checks.push({
      name: `có số ${label}`,
      pass: mentionsValue(answer, value),
      detail: String(value),
    });
  }
  for (const { label, value } of expected.forbiddenValues ?? []) {
    checks.push({
      name: `không lộ ${label}`,
      pass: !mentionsValue(answer, value),
      detail: String(value),
    });
  }
  for (const name of expected.names ?? []) {
    checks.push({ name: `nhắc ${name}`, pass: mentionsName(answer, name) });
  }
  for (const pattern of spec.mentions ?? []) {
    checks.push({ name: `nói ${pattern.source}`, pass: pattern.test(fold(answer)) });
  }
  if (spec.noMoney) {
    const match = MONEY_OR_PERCENT.exec(answer);
    checks.push({ name: "không bịa số", pass: !match, detail: match?.[0] });
  }
  return checks;
}
