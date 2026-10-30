import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthContext } from "../auth/auth.context.js";
import { executePlan } from "./execute.js";
import { buildCharts, buildFacts, narrativeFromFacts } from "./insights.js";
import {
  AiUnavailableError,
  aiEnabled,
  narrateWithClaude,
  planWithClaude,
  unverifiedPercents,
} from "./llm.js";
import { humanizeColumn, planWithRules, validatePlan, valueFormatFor } from "./planner.js";
import { profileDataset, toSummary } from "./summarize.js";
import type { AnalysisPlan, AnalysisResponse, Dataset, Narrative } from "./types.js";

export type AnalyzeOptions = {
  question: string;
  /** Kế hoạch có sẵn (trình duyệt tự làm mới): bỏ qua bước lập kế hoạch. */
  plan?: AnalysisPlan;
  /** Cho phép gọi AI viết nhận xét; tắt khi tự làm mới để không tốn lượt gọi. */
  narrate: boolean;
  /** Giờ tường hiện tại, để không so sánh kỳ chưa kết thúc. */
  now?: Date;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Toàn bộ quy trình: tóm tắt → lập kế hoạch → kiểm kế hoạch → tính → biểu đồ
 * → nhận xét. AI lỗi ở bước nào thì bước đó dùng luật, kết quả vẫn trả về.
 */
export async function analyzeDataset(
  dataset: Dataset,
  options: AnalyzeOptions,
): Promise<AnalysisResponse> {
  const typed = profileDataset(dataset);
  const summary = toSummary(typed);
  const warnings: string[] = [];
  const question = options.question.trim();

  let draft: AnalysisPlan;
  let planSource: AnalysisResponse["planSource"];
  if (options.plan) {
    draft = options.plan;
    planSource = "provided";
  } else if (aiEnabled() && question) {
    try {
      draft = await planWithClaude(summary, question);
      planSource = "ai";
    } catch (error) {
      console.warn("Trợ lý phân tích: AI lập kế hoạch lỗi, dùng luật:", describeError(error));
      warnings.push("Không gọi được AI để hiểu câu hỏi, dùng luật dự phòng");
      draft = planWithRules(summary, question);
      planSource = "rules";
    }
  } else {
    draft = planWithRules(summary, question);
    planSource = "rules";
  }

  const checked = validatePlan(draft, typed);
  warnings.push(...checked.warnings);
  const executed = executePlan(checked.plan, typed, { now: options.now });
  warnings.push(...executed.warnings);
  const plan = executed.plan;

  const valueFormat = valueFormatFor(plan);
  const charts = buildCharts(plan, executed.result, valueFormat);
  const facts = buildFacts(plan, executed.result, valueFormat);

  let narrative: Narrative = narrativeFromFacts(facts);
  let narrativeSource: AnalysisResponse["narrativeSource"] = "rules";
  if (options.narrate && aiEnabled() && executed.result.rowsUsed > 0) {
    try {
      const written = await narrateWithClaude(
        question || plan.intent,
        plan,
        facts,
        executed.result,
      );
      const unverified = unverifiedPercents(written, facts, executed.result);
      if (unverified.length > 0) {
        warnings.push(
          `Nhận xét của AI có số không khớp bảng tính (${unverified.join(", ")}), dùng nhận xét theo luật`,
        );
      } else {
        narrative = written;
        narrativeSource = "ai";
      }
    } catch (error) {
      if (!(error instanceof AiUnavailableError))
        console.warn("Trợ lý phân tích: AI viết nhận xét lỗi:", describeError(error));
      warnings.push("Không gọi được AI để viết nhận xét, dùng nhận xét theo luật");
    }
  }

  return {
    question,
    summary,
    plan,
    planSource,
    columnLabels: Object.fromEntries(
      summary.columns.map((column) => [column.name, humanizeColumn(column.name)]),
    ),
    valueFormat,
    result: executed.result,
    charts,
    facts,
    narrative,
    narrativeSource,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

// --- Dữ liệu bán hàng của chuỗi ---------------------------------------------

export const CHAIN_WINDOWS = {
  /** 13 tháng theo ngày: đủ so sánh 12 tháng gần nhất và cùng kỳ. */
  day: { unit: "day", interval: "13 months" },
  /** 7 ngày theo giờ. */
  hour: { unit: "hour", interval: "7 days" },
  /** 3 giờ theo phút: theo dõi gần như trực tiếp. */
  minute: { unit: "minute", interval: "3 hours" },
} as const;
export type ChainWindow = keyof typeof CHAIN_WINDOWS;

/** Cửa hàng người dùng được xem báo cáo: vai trò toàn chuỗi thấy hết, còn lại theo từng cửa hàng. */
async function reportableStores(auth: AuthContext) {
  const stores = await prisma.store.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  return stores.filter((store) => {
    const permissions = auth.permissionsForStore(store.id);
    return permissions.has("report.chain") || permissions.has("report.sales");
  });
}

type ChainRow = { bucket: Date; store_id: string; revenue: bigint; invoices: bigint };

/**
 * Tổng hợp hóa đơn hoàn tất theo cửa hàng và theo phút/giờ/ngày (giờ Việt
 * Nam). Gom ở CSDL nên kể cả chuỗi lớn cũng chỉ trả vài nghìn dòng.
 */
export async function loadChainDataset(auth: AuthContext, window: ChainWindow): Promise<Dataset> {
  const stores = await reportableStores(auth);
  if (stores.length === 0)
    throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem báo cáo của cửa hàng nào");
  const { unit, interval } = CHAIN_WINDOWS[window];
  const rows = await prisma.$queryRaw<ChainRow[]>`
    SELECT date_trunc(${unit}, i.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket,
           i.store_id,
           SUM(i.total_amount)::bigint AS revenue,
           COUNT(*)::bigint AS invoices
      FROM invoices i
     WHERE i.status = 'COMPLETED'
       AND i.store_id IN (${Prisma.join(stores.map((store) => store.id))})
       AND i.sold_at >= now() - ${interval}::interval
     GROUP BY 1, 2
     ORDER BY 1`;

  const names = new Map(stores.map((store) => [store.id, `${store.code} - ${store.name}`]));
  const format = (at: Date) => {
    const iso = at.toISOString();
    return window === "day" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  };
  return {
    name: "Bán hàng toàn chuỗi",
    columns: ["thoi_diem", "cua_hang", "doanh_thu", "so_hoa_don"],
    rows: rows.map((row) => [
      format(row.bucket),
      names.get(row.store_id) ?? row.store_id,
      Number(row.revenue),
      Number(row.invoices),
    ]),
  };
}

/** Giờ tường Việt Nam lúc này, cùng cách lưu với cột thời gian đã đọc. */
export function vnWallClock(at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return new Date(`${parts.replace(" ", "T")}:00.000Z`);
}
