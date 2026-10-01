import type {
  PayrollStatus,
  PreviewEmployee,
  PreviewState,
  ProposalStatus,
} from "./preview-types.js";

/** Nhãn trạng thái và hàm định dạng dùng chung cho các tab xem trước. */

export const PAYROLL_STATUS: Record<
  PayrollStatus,
  { label: string; tone: "slate" | "orange" | "blue" | "green" }
> = {
  none: { label: "Chưa lập", tone: "slate" },
  draft: { label: "Nháp", tone: "slate" },
  pending: { label: "Chờ duyệt", tone: "orange" },
  approved: { label: "Đã duyệt", tone: "blue" },
  published: { label: "Đã công bố", tone: "green" },
};

export const PROPOSAL_STATUS: Record<
  ProposalStatus,
  { label: string; tone: "slate" | "orange" | "green" | "red" }
> = {
  draft: { label: "Nháp", tone: "slate" },
  submitted: { label: "Chờ phê duyệt", tone: "orange" },
  approved: { label: "Đã duyệt", tone: "green" },
  rejected: { label: "Từ chối", tone: "red" },
};

export function employeeOf(state: PreviewState, id: string): PreviewEmployee | undefined {
  return state.employees.find((employee) => employee.id === id);
}

export function storeShort(state: PreviewState, id: string): string {
  return state.stores.find((store) => store.id === id)?.short ?? "—";
}

export function formatDay(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return `${month}/${year}`;
}

const WEEKDAYS = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}
