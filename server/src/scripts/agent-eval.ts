import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { claudeClient } from "../modules/bi/agent/agent.js";
import { EVAL_CASES, truthTool } from "../modules/bi/agent/eval/cases.js";
import {
  estimateCost,
  renderReport,
  resolveTruths,
  runEval,
  summarize,
} from "../modules/bi/agent/eval/run.js";

/**
 * Bộ đánh giá AI Agent (Phase 4, bước 4.6). Cần analytics-service đang chạy.
 *
 *   npm run eval:agent                       chạy thử: lấy đáp án đúng, ước tính chi phí, KHÔNG gọi Claude
 *   npm run eval:agent -- --run --yes        chạy thật (cần ANTHROPIC_API_KEY, tốn tiền)
 *
 * Tùy chọn: --only id1,id2 (chỉ vài câu), --limit N (N câu đầu), --budget 3 (dừng khi
 * chi phí vượt số USD này, mặc định 3). Báo cáo ghi vào server/eval-results/.
 */

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const only = option("only")?.split(",");
  const limit = Number(option("limit") ?? 0);
  const budgetUsd = Number(option("budget") ?? 3);
  let cases = only ? EVAL_CASES.filter((item) => only.includes(item.id)) : EVAL_CASES;
  if (limit > 0) cases = cases.slice(0, limit);
  // Câu hỏi tiếp cần câu gốc chạy trước.
  const ids = new Set(cases.map((item) => item.id));
  const missing = cases.filter((item) => item.followUp && !ids.has(item.followUp));
  if (missing.length) {
    cases = [...EVAL_CASES.filter((item) => missing.some((m) => m.followUp === item.id)), ...cases];
  }

  const summary = await truthTool([])("get_business_summary", { store: "ALL" });
  const stores = summary["stores"] as string[];
  console.log(`Dữ liệu: ${stores.join(", ")}, số liệu lúc ${String(summary["as_of"])}`);

  const truths = await resolveTruths(cases, stores);
  const estimate = estimateCost(cases.length);
  console.log(`\n${cases.length} câu hỏi, đáp án lấy từ analytics-service:`);
  for (const item of cases) {
    const truth = truths.get(item.id) ?? {};
    const parts = [
      ...(truth.values ?? []).map((value) => `${value.label} = ${value.value}`),
      ...(truth.forbiddenValues ?? []).map((value) => `không lộ ${value.label} = ${value.value}`),
      ...(truth.names ?? []).map((name) => `nhắc "${name}"`),
    ];
    console.log(`  ${item.id.padEnd(28)} ${parts.join("; ") || "(chỉ kiểm hành vi)"}`);
  }
  console.log(
    `\nChi phí ước tính: ~$${estimate.totalUsd.toFixed(2)} (≈ $${estimate.perCaseUsd.toFixed(3)}/câu), ` +
      `xấu nhất ~$${estimate.worstUsd.toFixed(2)}. Ngân sách dừng: $${budgetUsd}.`,
  );

  if (!flag("run")) {
    console.log("\nChạy thử xong, chưa gọi Claude. Chạy thật: npm run eval:agent -- --run --yes");
    return;
  }
  const client = claudeClient();
  if (!client) throw new Error("Chưa đặt ANTHROPIC_API_KEY trong server/.env");
  if (!flag("yes")) throw new Error("Chạy thật tốn tiền: thêm --yes để xác nhận");

  const startedAt = new Date();
  console.log(`\nĐang chạy với ${env.ANALYTICS_AI_MODEL}…`);
  const { results, stoppedForBudget } = await runEval({
    cases,
    stores,
    client,
    budgetUsd,
    onCase: (result, index) =>
      console.log(
        `  [${index + 1}/${cases.length}] ${result.pass ? "ĐẠT " : "TRƯỢT"} ${result.id} (${result.status}, ${(result.durationMs / 1000).toFixed(1)} giây, $${(result.costUsd ?? 0).toFixed(4)})`,
      ),
  });

  const dir = fileURLToPath(new URL("../../eval-results", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const base = `${dir}/agent-eval-${stamp}`;
  writeFileSync(
    `${base}.md`,
    renderReport(results, { model: env.ANALYTICS_AI_MODEL, startedAt, stoppedForBudget }),
  );
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ startedAt, model: env.ANALYTICS_AI_MODEL, results }, null, 2),
  );
  const s = summarize(results);
  console.log(
    `\nĐạt ${s.passed}/${s.total}. Chi phí $${s.costUsd.toFixed(4)}. Báo cáo: ${base}.md`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
