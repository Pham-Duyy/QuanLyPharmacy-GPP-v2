import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { askAgent, type AgentClient, type AgentResult } from "../agent.js";
import { personaAccess, truthTool, type EvalCase } from "./cases.js";
import { grade, type Check, type Expected } from "./grade.js";

/** Chạy bộ đánh giá (bước 4.6), tổng hợp và viết báo cáo. */

export type CaseResult = {
  id: string;
  category: string;
  question: string;
  persona: string;
  expected: Expected;
  checks: Check[];
  pass: boolean;
  status: string;
  answer: string | null;
  tools: string[];
  rounds: number;
  durationMs: number;
  costUsd: number | null;
  verification: AgentResult["verification"];
  error?: string;
};

/**
 * Ước tính chi phí trước khi chạy (giá Opus 5.5: vào $4, ra $20, đọc cache $0,20, ghi cache
 * $5 mỗi triệu token). Giả định mỗi câu 2,5 vòng; phần tool + system (~4.200 token) đọc từ
 * cache vì các câu chạy liền nhau; ~1.500 token mới và ~700 token ra (gồm thinking) mỗi vòng.
 */
export function estimateCost(cases: number) {
  const rounds = 2.5;
  const perRound = (4_200 * 0.2 + 1_500 * 4 + 700 * 20) / 1e6;
  const perCase = rounds * perRound;
  const firstWrite = (4_200 * 5) / 1e6;
  return {
    perCaseUsd: perCase,
    totalUsd: cases * perCase + firstWrite,
    /** Trường hợp xấu: mọi câu 4 vòng, có sửa lại, câu trả lời dài gấp đôi. */
    worstUsd: cases * 4 * ((4_200 * 0.2 + 3_000 * 4 + 1_400 * 20) / 1e6) + firstWrite,
  };
}

/** Lấy đáp án đúng cho mọi câu trước khi gọi Claude: lỗi dữ liệu thì dừng sớm, không tốn tiền. */
export async function resolveTruths(cases: EvalCase[], stores: string[]) {
  const tool = truthTool(stores);
  const truths = new Map<string, Expected>();
  for (const item of cases) truths.set(item.id, item.truth ? await item.truth(tool) : {});
  return truths;
}

export async function runEval(options: {
  cases: EvalCase[];
  stores: string[];
  client: AgentClient;
  budgetUsd: number;
  onCase?: (result: CaseResult, index: number) => void;
}): Promise<{ results: CaseResult[]; stoppedForBudget: boolean }> {
  const truths = await resolveTruths(options.cases, options.stores);
  const histories = new Map<string, BetaMessageParam[]>();
  const results: CaseResult[] = [];
  let spent = 0;

  for (const [index, item] of options.cases.entries()) {
    if (spent >= options.budgetUsd) return { results, stoppedForBudget: true };
    const expected = truths.get(item.id) ?? {};
    const persona = item.persona ?? "chain";
    const history = item.followUp ? histories.get(item.followUp) : undefined;
    const base = {
      id: item.id,
      category: item.category,
      question: item.question,
      persona,
      expected,
    };
    if (item.followUp && !history) {
      const result: CaseResult = {
        ...base,
        checks: [{ name: "có câu trước", pass: false, detail: item.followUp }],
        pass: false,
        status: "skipped",
        answer: null,
        tools: [],
        rounds: 0,
        durationMs: 0,
        costUsd: 0,
        verification: null,
        error: `Câu trước ${item.followUp} không chạy`,
      };
      results.push(result);
      options.onCase?.(result, index);
      continue;
    }

    const result = await askAgent({
      access: personaAccess(persona, options.stores),
      question: item.question,
      client: options.client,
      ...(history ? { history } : {}),
      ...(item.scope ? { scope: item.scope } : {}),
    });
    histories.set(item.id, result.messages);
    spent += result.costUsd ?? 0;
    const checks = grade(result, item.spec, expected);
    const caseResult: CaseResult = {
      ...base,
      checks,
      pass: checks.every((check) => check.pass),
      status: result.status,
      answer: result.answer,
      tools: result.toolCalls.map((call) => (call.ok ? call.name : `${call.name} (lỗi)`)),
      rounds: result.rounds,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      verification: result.verification,
      ...(result.error ? { error: result.error } : {}),
    };
    results.push(caseResult);
    options.onCase?.(caseResult, index);
  }
  return { results, stoppedForBudget: false };
}

function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
}

export function summarize(results: CaseResult[]) {
  const ran = results.filter((result) => result.status !== "skipped");
  const durations = ran.map((result) => result.durationMs);
  const cost = ran.reduce((total, result) => total + (result.costUsd ?? 0), 0);
  const categories = new Map<string, { total: number; pass: number }>();
  for (const result of results) {
    const entry = categories.get(result.category) ?? { total: 0, pass: 0 };
    entry.total += 1;
    entry.pass += result.pass ? 1 : 0;
    categories.set(result.category, entry);
  }
  const statuses: Record<string, number> = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  return {
    total: results.length,
    passed: results.filter((result) => result.pass).length,
    categories: [...categories.entries()].map(([name, value]) => ({ name, ...value })),
    statuses,
    retried: ran.filter((result) => result.verification?.retried).length,
    /** Số có trong kết quả tool (qua đối chiếu) nhưng không phải số câu hỏi cần: gán nhầm mục. */
    misattributed: ran.filter(
      (result) =>
        result.status === "answered" &&
        result.checks.some((check) => check.name.startsWith("có số") && !check.pass),
    ).length,
    avgSeconds: durations.reduce((a, b) => a + b, 0) / Math.max(durations.length, 1) / 1000,
    p95Seconds: percentile(durations, 0.95) / 1000,
    costUsd: cost,
    avgCostUsd: cost / Math.max(ran.length, 1),
  };
}

const pct = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(0)}%` : "–";
const usd = (value: number) => `$${value.toFixed(4)}`;
const sec = (value: number) => `${value.toFixed(1)} giây`;

export function renderReport(
  results: CaseResult[],
  meta: { model: string; startedAt: Date; stoppedForBudget: boolean },
): string {
  const s = summarize(results);
  const lines = [
    `# Đánh giá AI Agent: ${meta.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Mô hình: ${meta.model}. Câu đạt: **${s.passed}/${s.total} (${pct(s.passed, s.total)})**.` +
      (meta.stoppedForBudget ? " Dừng sớm vì chạm ngân sách." : ""),
    "",
    "| Chỉ số | Giá trị |",
    "|---|---|",
    `| Trạng thái | ${Object.entries(s.statuses)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ")} |`,
    `| Phải sửa số một lần | ${s.retried} |`,
    `| Bị chặn vì số không có nguồn | ${s.statuses["blocked"] ?? 0} |`,
    `| Số có nguồn nhưng sai mục (đối chiếu không bắt được) | ${s.misattributed} |`,
    `| Thời gian trung bình / p95 | ${sec(s.avgSeconds)} / ${sec(s.p95Seconds)} |`,
    `| Chi phí tổng / trung bình mỗi câu | ${usd(s.costUsd)} / ${usd(s.avgCostUsd)} |`,
    "",
    "## Theo nhóm",
    "",
    "| Nhóm | Đạt |",
    "|---|---|",
    ...s.categories.map((item) => `| ${item.name} | ${item.pass}/${item.total} |`),
    "",
    "## Từng câu",
    "",
    "| Câu | Đạt | Trạng thái | Tool | Kiểm không đạt | Thời gian | Chi phí |",
    "|---|---|---|---|---|---|---|",
    ...results.map((result) => {
      const failed = result.checks
        .filter((check) => !check.pass)
        .map((check) => (check.detail ? `${check.name} (${check.detail})` : check.name))
        .join("; ");
      return `| ${result.id} | ${result.pass ? "✓" : "✗"} | ${result.status} | ${result.tools.join(", ") || "–"} | ${failed.replaceAll("|", "/") || "–"} | ${sec(result.durationMs / 1000)} | ${usd(result.costUsd ?? 0)} |`;
    }),
    "",
    "## Câu trả lời",
    "",
    ...results.flatMap((result) => [
      `### ${result.id} ${result.pass ? "✓" : "✗"}`,
      "",
      `**Hỏi** (${result.persona}): ${result.question}`,
      "",
      result.answer
        ? result.answer
        : `_${result.status}${result.error ? `: ${result.error}` : ""}_`,
      "",
    ]),
  ];
  return lines.join("\n");
}
