import type {
  BonusReview,
  Criterion,
  PayrollLine,
  PreviewEmployee,
  PreviewState,
  PromotionProposal,
  Rating,
  SalesFigure,
  Shift,
} from "./preview-types.js";

/**
 * Luật nghiệp vụ của bản xem trước, viết thành hàm thuần để kiểm thử được.
 * Đây là mô phỏng giao diện, KHÔNG phải công thức lương hay thưởng chính thức.
 */

export const STANDARD_DAYS = 26;

// --- Doanh số -----------------------------------------------------------------

/** Doanh số thuần = doanh số sau giảm giá − hàng trả. Giảm giá đã trừ sẵn, không trừ lần hai. */
export function netSales(figure: SalesFigure): number {
  return figure.grossAfterDiscount - figure.returns;
}

export function salesOf(
  state: PreviewState,
  employeeId: string,
  period: string,
): SalesFigure | null {
  return (
    state.sales.find((item) => item.employeeId === employeeId && item.period === period) ?? null
  );
}

// --- Chấm công ----------------------------------------------------------------

/** Công đã duyệt trong kỳ: chỉ tính bản ghi chấm công được duyệt, không tính ca dự kiến. */
export function approvedDays(state: PreviewState, employeeId: string, period: string): number {
  const before = state.approvedDaysBefore[`${employeeId}:${period}`] ?? 0;
  const counted = state.attendance.filter(
    (record) =>
      record.employeeId === employeeId && record.date.startsWith(period) && record.approved,
  ).length;
  return before + counted;
}

// --- Lịch làm -----------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ShiftDraft = Omit<Shift, "id"> & { id?: string };

/** Trả lỗi hiển thị dưới form, hoặc null nếu ca hợp lệ. */
export function validateShift(state: PreviewState, draft: ShiftDraft): string | null {
  if (!TIME.test(draft.start) || !TIME.test(draft.end))
    return "Giờ phải theo dạng HH:mm, ví dụ 07:00.";
  if (draft.start >= draft.end) return "Giờ kết thúc phải sau giờ bắt đầu.";
  const employee = state.employees.find((item) => item.id === draft.employeeId);
  if (!employee) return "Chọn nhân viên.";
  if (employee.workStatus === "on_leave") return "Nhân viên đang tạm nghỉ, không xếp ca.";
  const clash = state.shifts.find(
    (shift) =>
      shift.employeeId === draft.employeeId &&
      shift.date === draft.date &&
      shift.id !== draft.id &&
      shift.start < draft.end &&
      draft.start < shift.end,
  );
  if (clash) {
    const store = state.stores.find((item) => item.id === clash.storeId)?.short ?? "";
    return `Trùng ca ${clash.start} – ${clash.end}${store ? ` tại ${store}` : ""} cùng ngày.`;
  }
  return null;
}

/** Ca sắp tới mà nhân viên được thấy: chỉ từ lịch đã công bố. */
export function nextPublishedShift(
  state: PreviewState,
  employeeId: string,
  today: string,
): Shift | null {
  const published = new Set(
    state.weeks
      .filter((week) => week.status === "published")
      .map((week) => `${week.storeId}:${week.weekStart}`),
  );
  return (
    state.shifts
      .filter((shift) => shift.employeeId === employeeId && shift.date >= today)
      .filter((shift) => published.has(`${shift.storeId}:${weekStartOf(shift.date)}`))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))[0] ?? null
  );
}

/** Thứ Hai của tuần chứa ngày (yyyy-mm-dd). */
export function weekStartOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekday);
  return day.toISOString().slice(0, 10);
}

// --- Thưởng và lương ------------------------------------------------------------

/** Kỳ lương đã gửi duyệt trở đi thì khóa sửa thưởng. */
export function payrollLocked(state: PreviewState): boolean {
  return ["pending", "approved", "published"].includes(state.payroll.status);
}

export function approvedBonusOf(
  state: PreviewState,
  employeeId: string,
  period: string,
): BonusReview | null {
  return (
    state.bonuses.find(
      (bonus) =>
        bonus.employeeId === employeeId && bonus.period === period && bonus.status === "approved",
    ) ?? null
  );
}

/**
 * Lập (hoặc lập lại) bảng lương: thay toàn bộ dòng cũ, không cộng dồn, nên
 * mỗi khoản thưởng đã duyệt chỉ xuất hiện một lần dù bấm lập lại nhiều lần.
 */
export function buildPayrollLines(state: PreviewState, period: string): PayrollLine[] {
  return state.employees.map((employee) => {
    const days = approvedDays(state, employee.id, period);
    const basePay = Math.round(
      (employee.monthlyBase * Math.min(days, STANDARD_DAYS)) / STANDARD_DAYS,
    );
    const bonus = approvedBonusOf(state, employee.id, period);
    const bonusAmount = bonus?.approved ?? 0;
    return {
      employeeId: employee.id,
      approvedDays: days,
      basePay,
      allowance: employee.allowance,
      bonus: bonusAmount,
      bonusReviewId: bonus?.id ?? null,
      deduction: employee.deduction,
      net: basePay + employee.allowance + bonusAmount - employee.deduction,
    };
  });
}

/** Phiếu lương: quản lý xem mọi lúc; nhân viên chỉ xem phiếu của mình sau khi công bố. */
export function payslipFor(
  state: PreviewState,
  employeeId: string,
  viewer: "manager" | "self",
): PayrollLine | null {
  if (viewer === "self" && state.payroll.status !== "published") return null;
  return state.payroll.lines.find((line) => line.employeeId === employeeId) ?? null;
}

// --- Đánh giá và thăng chức -----------------------------------------------------

export const CRITERIA: Array<{ key: Criterion; label: string; hint: string }> = [
  { key: "results", label: "Kết quả công việc", hint: "Chỉ tiêu, doanh số và nhiệm vụ được giao" },
  { key: "expertise", label: "Năng lực chuyên môn", hint: "Kiến thức, tư vấn đúng quy định" },
  { key: "compliance", label: "Tuân thủ quy trình", hint: "GPP, quy định và quy trình nội bộ" },
  {
    key: "teamwork",
    label: "Phối hợp và chất lượng phục vụ",
    hint: "Hỗ trợ đồng nghiệp, phục vụ khách hàng",
  },
];

export const RATING_LABEL: Record<Rating, string> = {
  good: "Tốt",
  pass: "Đạt",
  improve: "Cần cải thiện",
};

/** Kết luận chung: có tiêu chí cần cải thiện thì không xếp "Hoàn thành tốt". */
export function overallRating(ratings: Record<Criterion, Rating>): string {
  const values = Object.values(ratings);
  if (values.includes("improve")) return "Cần cải thiện";
  return values.filter((value) => value === "good").length >= 3 ? "Hoàn thành tốt" : "Đạt";
}

export function canEditProposal(proposal: PromotionProposal): boolean {
  return proposal.status === "draft";
}

// --- Danh sách ------------------------------------------------------------------

export const WORK_STATUS_LABEL: Record<PreviewEmployee["workStatus"], string> = {
  working: "Đang làm việc",
  probation: "Thử việc",
  on_leave: "Tạm nghỉ",
};
