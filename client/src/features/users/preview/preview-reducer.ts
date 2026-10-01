import {
  buildPayrollLines,
  payrollLocked,
  validateShift,
  type ShiftDraft,
} from "./preview-logic.js";
import type {
  Criterion,
  PreviewEmployee,
  PreviewState,
  PromotionProposal,
  Rating,
} from "./preview-types.js";

/** Bộ xử lý trạng thái của bản xem trước: hàm thuần, kiểm lại luật kể cả khi giao diện đã chặn. */

export type PreviewAction =
  | { type: "addEmployee"; employee: PreviewEmployee }
  | { type: "saveShift"; shift: ShiftDraft & { id: string } }
  | { type: "deleteShift"; id: string }
  | { type: "publishWeek"; storeId: string; weekStart: string }
  | { type: "reviewAdjustment"; id: string; decision: "approved" | "rejected"; note: string }
  | {
      type: "approveBonus";
      id: string;
      amount: number;
      reason: string;
      compliance: boolean;
      service: boolean;
    }
  | { type: "buildPayroll" }
  | { type: "submitPayroll" }
  | { type: "returnPayroll" }
  | { type: "approvePayroll" }
  | { type: "publishPayroll" }
  | { type: "markPaid" }
  | { type: "saveReview"; employeeId: string; ratings: Record<Criterion, Rating>; comment: string }
  | { type: "saveProposal"; proposal: PromotionProposal }
  | { type: "submitProposal"; id: string }
  | { type: "decideProposal"; id: string; decision: "approved" | "rejected"; note: string };

function weekOf(state: PreviewState, storeId: string, date: string) {
  return state.weeks.find(
    (week) =>
      week.storeId === storeId && date >= week.weekStart && date < addDays(week.weekStart, 7),
  );
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Sửa lịch của tuần đã công bố thì tuần đó về nháp, cần công bố lại. */
function markWeekChanged(
  state: PreviewState,
  storeId: string,
  date: string,
): PreviewState["weeks"] {
  const week = weekOf(state, storeId, date);
  if (!week) return state.weeks;
  return state.weeks.map((item) =>
    item === week
      ? {
          ...item,
          status: "draft",
          changedAfterPublish: item.status === "published" || item.changedAfterPublish,
        }
      : item,
  );
}

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case "addEmployee":
      return { ...state, employees: [...state.employees, action.employee] };

    case "saveShift": {
      if (validateShift(state, action.shift) !== null) return state;
      const exists = state.shifts.some((shift) => shift.id === action.shift.id);
      return {
        ...state,
        shifts: exists
          ? state.shifts.map((shift) => (shift.id === action.shift.id ? action.shift : shift))
          : [...state.shifts, action.shift],
        weeks: markWeekChanged(state, action.shift.storeId, action.shift.date),
      };
    }

    case "deleteShift": {
      const shift = state.shifts.find((item) => item.id === action.id);
      if (!shift) return state;
      return {
        ...state,
        shifts: state.shifts.filter((item) => item.id !== action.id),
        weeks: markWeekChanged(state, shift.storeId, shift.date),
      };
    }

    case "publishWeek":
      return {
        ...state,
        weeks: state.weeks.map((week) =>
          week.storeId === action.storeId && week.weekStart === action.weekStart
            ? { ...week, status: "published", changedAfterPublish: false }
            : week,
        ),
      };

    case "reviewAdjustment": {
      const request = state.adjustments.find((item) => item.id === action.id);
      if (!request || request.status !== "pending") return state;
      if (action.decision === "rejected" && !action.note.trim()) return state;
      const attendance =
        action.decision === "approved"
          ? state.attendance.map((record) =>
              record.id === request.recordId
                ? {
                    ...record,
                    checkIn: request.requestedCheckIn ?? record.checkIn,
                    checkOut: request.requestedCheckOut ?? record.checkOut,
                    flags: record.flags.filter(
                      (flag) =>
                        !(flag === "missing_in" && request.requestedCheckIn) &&
                        !(flag === "missing_out" && request.requestedCheckOut),
                    ),
                    approved: true,
                  }
                : record,
            )
          : state.attendance;
      return {
        ...state,
        attendance,
        adjustments: state.adjustments.map((item) =>
          item.id === action.id
            ? { ...item, status: action.decision, reviewNote: action.note.trim() }
            : item,
        ),
      };
    }

    case "approveBonus": {
      const bonus = state.bonuses.find((item) => item.id === action.id);
      if (!bonus || payrollLocked(state)) return state;
      if (!Number.isFinite(action.amount) || action.amount < 0) return state;
      if (action.amount !== bonus.proposed && !action.reason.trim()) return state;
      return {
        ...state,
        bonuses: state.bonuses.map((item) =>
          item.id === action.id
            ? {
                ...item,
                approved: Math.round(action.amount),
                status: "approved",
                reason: action.reason.trim(),
                compliance: action.compliance,
                service: action.service,
              }
            : item,
        ),
      };
    }

    case "buildPayroll":
      if (payrollLocked(state)) return state;
      return {
        ...state,
        payroll: {
          ...state.payroll,
          status: "draft",
          lines: buildPayrollLines(state, state.payroll.period),
        },
      };

    case "submitPayroll":
      return state.payroll.status === "draft"
        ? { ...state, payroll: { ...state.payroll, status: "pending" } }
        : state;

    case "returnPayroll":
      return state.payroll.status === "pending"
        ? { ...state, payroll: { ...state.payroll, status: "draft" } }
        : state;

    case "approvePayroll":
      return state.payroll.status === "pending"
        ? { ...state, payroll: { ...state.payroll, status: "approved" } }
        : state;

    case "publishPayroll":
      return state.payroll.status === "approved"
        ? { ...state, payroll: { ...state.payroll, status: "published" } }
        : state;

    case "markPaid":
      return ["approved", "published"].includes(state.payroll.status)
        ? { ...state, payroll: { ...state.payroll, paymentStatus: "paid" } }
        : state;

    case "saveReview": {
      const existing = state.reviews.find(
        (review) =>
          review.employeeId === action.employeeId && review.period === state.payroll.period,
      );
      const next = {
        ratings: action.ratings,
        comment: action.comment.trim(),
        status: "done" as const,
      };
      return {
        ...state,
        reviews: existing
          ? state.reviews.map((review) => (review === existing ? { ...review, ...next } : review))
          : [
              ...state.reviews,
              {
                id: `v-${action.employeeId}-${state.payroll.period}`,
                employeeId: action.employeeId,
                period: state.payroll.period,
                ...next,
              },
            ],
      };
    }

    case "saveProposal": {
      const existing = state.proposals.find((item) => item.id === action.proposal.id);
      if (existing && existing.status !== "draft") return state;
      const proposal = { ...action.proposal, status: "draft" as const };
      return {
        ...state,
        proposals: existing
          ? state.proposals.map((item) => (item.id === proposal.id ? proposal : item))
          : [proposal, ...state.proposals],
      };
    }

    case "submitProposal":
      return {
        ...state,
        proposals: state.proposals.map((item) =>
          item.id === action.id && item.status === "draft"
            ? { ...item, status: "submitted" }
            : item,
        ),
      };

    case "decideProposal": {
      const proposal = state.proposals.find((item) => item.id === action.id);
      if (!proposal || proposal.status !== "submitted") return state;
      if (action.decision === "rejected" && !action.note.trim()) return state;
      // Duyệt chỉ ghi nhận quyết định chức danh; vai trò truy cập phần mềm giữ nguyên.
      return {
        ...state,
        proposals: state.proposals.map((item) =>
          item.id === action.id
            ? { ...item, status: action.decision, decisionNote: action.note.trim() }
            : item,
        ),
      };
    }
  }
}
