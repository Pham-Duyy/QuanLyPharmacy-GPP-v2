import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env } from "../../config/env.js";
import { analysisPlanSchema } from "./planner.js";
import type { AnalysisPlan, DataSummary, ExecutionResult, Fact, Narrative } from "./types.js";

/**
 * Gọi Claude cho hai bước cần hiểu ngôn ngữ: lập kế hoạch từ câu hỏi và viết
 * nhận xét. Chỉ bật khi quản trị đặt ANTHROPIC_API_KEY (contract §20): dữ
 * liệu gửi đi là bản tóm tắt cột và bảng số đã tổng hợp, không phải từng dòng.
 */
const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 })
  : null;

export function aiEnabled(): boolean {
  return client !== null;
}

export function aiModel(): string {
  return env.ANALYTICS_AI_MODEL;
}

export class AiUnavailableError extends Error {}

/** Token của một lần gọi Claude: Trợ lý AI cộng vào chi phí và ngân sách tháng (bước 6.6). */
export type LlmUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
export type OnUsage = (usage: LlmUsage) => void;

const PLANNER_SYSTEM = `Bạn là bộ lập kế hoạch phân tích dữ liệu kinh doanh cho chuỗi nhà thuốc.
Bạn nhận bản tóm tắt các cột của một bảng dữ liệu và câu hỏi của người dùng, rồi trả về MỘT kế hoạch phân tích dạng JSON. Máy chủ sẽ tự tính toán theo kế hoạch; bạn không tính số.

Quy tắc:
- Chỉ dùng đúng tên cột có trong bản tóm tắt, viết y nguyên chữ hoa, dấu, gạch dưới.
- measure.column phải là cột kind "numeric"; nếu câu hỏi đếm số dòng (số giao dịch, số đơn) mà không có cột số phù hợp thì đặt measure.column = null và aggregate = "count".
- measure.label là tên đại lượng ngắn gọn bằng tiếng Việt để hiện trên biểu đồ, ví dụ "Doanh thu".
- time.column phải là cột kind "temporal". Chọn grain theo câu hỏi ("theo tháng" → month, "12 tháng gần nhất" → month và lastPeriods 12, "theo giờ" → hour). Không chọn grain mịn hơn temporalPrecision của cột. Câu hỏi không liên quan thời gian thì time = null.
- groupBy.column là cột kind "categorical" khi câu hỏi so sánh giữa các nhóm (chi nhánh, cửa hàng, sản phẩm, khu vực...). topN mặc định 8.
- filters chỉ dùng khi câu hỏi giới hạn rõ ràng (một chi nhánh, một sản phẩm, một khoảng thời gian). Giá trị lọc của cột phân loại phải lấy từ topValues/samples. So sánh thời gian dùng định dạng YYYY-MM-DD.
- focus: "trend" (xu hướng theo thời gian), "change" (mức tăng/giảm), "compare" (so sánh nhóm), "share" (tỷ trọng), "overview".
- intent: diễn đạt lại câu hỏi thành một câu tiếng Việt rõ nghĩa.`;

const NARRATOR_SYSTEM = `Bạn là chuyên viên phân tích kinh doanh của một chuỗi nhà thuốc, viết nhận xét bằng tiếng Việt cho chủ chuỗi và quản lý cửa hàng.
Bạn nhận câu hỏi, kế hoạch phân tích, danh sách sự kiện đã tính sẵn và bảng số liệu tổng hợp.

Quy tắc bắt buộc:
- Mọi con số, phần trăm, tên kỳ, tên nhóm bạn viết phải lấy nguyên văn từ "Sự kiện" hoặc "Bảng số liệu". Không tự cộng, trừ, chia hay làm tròn lại; không bịa số.
- headline: một câu trả lời thẳng vào câu hỏi.
- findings: 3–6 ý, mỗi ý một câu, ưu tiên ý trả lời câu hỏi, sau đó là điểm bất thường đáng chú ý.
- recommendations: 0–3 việc nên làm tiếp, cụ thể với nhà thuốc (ví dụ rà soát tồn kho, nhân sự, khuyến mãi, giờ mở cửa tại cửa hàng giảm), trình bày là gợi ý cần kiểm chứng, không khẳng định nguyên nhân.
- Không dùng markdown, không dùng emoji.`;

const narrativeSchema = z.object({
  headline: z.string(),
  findings: z.array(z.string()),
  recommendations: z.array(z.string()),
});

function requireClient(): Anthropic {
  if (!client) throw new AiUnavailableError("Chưa cấu hình ANTHROPIC_API_KEY");
  return client;
}

/**
 * Gọi Claude với đầu ra JSON theo lược đồ. Bật fallback phía máy chủ: khi bộ
 * lọc an toàn của mô hình từ chối, API tự chạy lại trên mô hình dự phòng.
 */
async function structuredCall<T extends z.ZodType>(
  system: string,
  content: string,
  schema: T,
  onUsage?: OnUsage,
): Promise<z.infer<T>> {
  const response = await requireClient().beta.messages.parse({
    model: aiModel(),
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });
  onUsage?.({
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  });
  if (response.stop_reason === "refusal") throw new AiUnavailableError("Mô hình từ chối yêu cầu");
  if (response.stop_reason === "max_tokens")
    throw new AiUnavailableError("Câu trả lời của mô hình bị cắt giữa chừng");
  if (!response.parsed_output) throw new AiUnavailableError("Mô hình trả về JSON không hợp lệ");
  return response.parsed_output as z.infer<T>;
}

export async function planWithClaude(
  summary: DataSummary,
  question: string,
  onUsage?: OnUsage,
): Promise<AnalysisPlan> {
  const content = `Bản tóm tắt dữ liệu:\n${JSON.stringify(summary)}\n\nCâu hỏi: ${question}`;
  return structuredCall(PLANNER_SYSTEM, content, analysisPlanSchema, onUsage);
}

/** Bảng gửi cho AI: tối đa 60 kỳ gần nhất, đủ để đọc xu hướng mà không gửi quá nhiều. */
function compactTables(result: ExecutionResult) {
  const keep = Math.max(result.periods.length - 60, 0);
  return {
    overall: result.overall,
    series: result.periods.slice(keep).map((period, index) => ({
      period,
      total: result.overallSeries[keep + index],
      ...Object.fromEntries(
        result.groupSeries.map((series) => [series.name, series.values[keep + index]]),
      ),
    })),
    groups: result.groups,
  };
}

export async function narrateWithClaude(
  question: string,
  plan: AnalysisPlan,
  facts: Fact[],
  result: ExecutionResult,
  onUsage?: OnUsage,
): Promise<Narrative> {
  const content = [
    `Câu hỏi: ${question}`,
    `Kế hoạch phân tích: ${JSON.stringify(plan)}`,
    `Sự kiện (đã tính, có định dạng số kiểu Việt Nam):\n${facts.map((fact) => `- ${fact.text}`).join("\n")}`,
    `Bảng số liệu: ${JSON.stringify(compactTables(result))}`,
  ].join("\n\n");
  return structuredCall(NARRATOR_SYSTEM, content, narrativeSchema, onUsage);
}

const PERCENT_TOKEN = /[-+−]?\d+(?:[.,]\d+)?\s?%/g;

function percentValue(token: string): number {
  return Number(
    token
      .replace(/[\s%+]/g, "")
      .replace("−", "-")
      .replace(",", "."),
  );
}

/**
 * Bước tự kiểm (tương tự VizEvaluator của LIDA, nhưng tất định): mọi phần
 * trăm AI viết ra phải khớp một phần trăm đã tính. Lệch là bỏ nhận xét AI.
 */
export function unverifiedPercents(
  narrative: Narrative,
  facts: Fact[],
  result: ExecutionResult,
): string[] {
  const known = new Set<number>();
  for (const fact of facts)
    for (const token of fact.text.match(PERCENT_TOKEN) ?? [])
      known.add(Math.abs(percentValue(token)));
  const stats = [result.overall, ...result.groups];
  for (const stat of stats) {
    for (const value of [
      stat.changePercent,
      stat.trendPercent,
      "share" in stat ? stat.share : null,
    ])
      if (value !== null && value !== undefined) known.add(Math.abs(value));
  }
  if (result.overall.lastStepPercent !== null) known.add(Math.abs(result.overall.lastStepPercent));

  const text = [narrative.headline, ...narrative.findings, ...narrative.recommendations].join(" ");
  return (text.match(PERCENT_TOKEN) ?? []).filter((token) => {
    const value = Math.abs(percentValue(token));
    return ![...known].some((candidate) => Math.abs(candidate - value) <= 0.051);
  });
}
