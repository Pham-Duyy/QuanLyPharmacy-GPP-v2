import type {
  AdjustmentRequest,
  AttendanceRecord,
  BonusReview,
  MonthlyReview,
  PreviewEmployee,
  PreviewState,
  PreviewStore,
  PromotionProposal,
  SalesFigure,
  Shift,
} from "./preview-types.js";

/**
 * DỮ LIỆU MINH HỌA cho bản xem trước nhân sự. Tên người, số tiền, mức thưởng,
 * lương đều là số giả để xem giao diện; không phản ánh nhân viên hay chính
 * sách thật nào. Không đưa dữ liệu này vào báo cáo hay CSDL.
 */

export const PREVIEW_PERIOD = "2026-09";
/** Ngày "hôm nay" của bộ dữ liệu mẫu, để lịch và phiếu lương nhất quán. */
export const PREVIEW_TODAY = "2026-10-01";
export const PREVIEW_WEEK_START = "2026-10-05";

const stores: PreviewStore[] = [
  { id: "s1", name: "Nhà thuốc GPP số 1 (mẫu)", short: "GPP số 1" },
  { id: "s2", name: "Nhà thuốc GPP số 2 (mẫu)", short: "GPP số 2" },
];

const employees: PreviewEmployee[] = [
  {
    id: "e1",
    code: "NV001",
    fullName: "Trần Minh Anh",
    username: "minhanh",
    title: "Dược sĩ",
    storeId: "s1",
    accessRole: "Dược sĩ",
    workStatus: "working",
    accountActive: true,
    joinedAt: "2023-03-01",
    phone: "090 123 4567",
    certificate: "CCHN-001234",
    monthlyBase: 8_000_000,
    allowance: 500_000,
    deduction: 200_000,
  },
  {
    id: "e2",
    code: "NV002",
    fullName: "Lê Hoàng Nam",
    username: "hoangnam",
    title: "Dược sĩ",
    storeId: "s1",
    accessRole: "Dược sĩ",
    workStatus: "working",
    accountActive: true,
    joinedAt: "2024-01-15",
    phone: "091 222 3344",
    certificate: "CCHN-004521",
    monthlyBase: 7_500_000,
    allowance: 500_000,
    deduction: 150_000,
  },
  {
    id: "e3",
    code: "NV003",
    fullName: "Phạm Thu Hà",
    username: "thuha",
    title: "Dược sĩ",
    storeId: "s1",
    accessRole: "Dược sĩ",
    workStatus: "working",
    accountActive: true,
    joinedAt: "2024-06-03",
    phone: "098 765 4321",
    certificate: null,
    monthlyBase: 7_000_000,
    allowance: 400_000,
    deduction: 100_000,
  },
  {
    id: "e4",
    code: "NV004",
    fullName: "Nguyễn Ngọc Mai",
    username: "ngocmai",
    title: "Dược sĩ",
    storeId: "s2",
    accessRole: "Dược sĩ",
    workStatus: "on_leave",
    accountActive: true,
    joinedAt: "2022-09-12",
    phone: "093 111 2233",
    certificate: "CCHN-002288",
    monthlyBase: 7_800_000,
    allowance: 500_000,
    deduction: 150_000,
  },
  {
    id: "e5",
    code: "NV005",
    fullName: "Đỗ Minh Đức",
    username: "minhduc",
    title: "Nhân viên kho",
    storeId: "s1",
    accessRole: "Nhân viên kho",
    workStatus: "probation",
    accountActive: true,
    joinedAt: "2026-08-18",
    phone: "097 456 7788",
    certificate: null,
    monthlyBase: 6_500_000,
    allowance: 300_000,
    deduction: 100_000,
  },
  {
    id: "e6",
    code: "NV006",
    fullName: "Vũ Thanh Bình",
    username: "thanhbinh",
    title: "Quản lý cửa hàng",
    storeId: "s1",
    accessRole: "Quản lý",
    workStatus: "working",
    accountActive: true,
    joinedAt: "2021-05-04",
    phone: "090 999 8877",
    certificate: "CCHN-000915",
    monthlyBase: 12_000_000,
    allowance: 1_000_000,
    deduction: 300_000,
  },
  {
    id: "e7",
    code: "NV007",
    fullName: "Hoàng Thị Lan",
    username: "thilan",
    title: "Dược sĩ",
    storeId: "s2",
    accessRole: "Dược sĩ",
    workStatus: "working",
    accountActive: false,
    joinedAt: "2025-02-10",
    phone: "094 333 5566",
    certificate: "CCHN-006710",
    monthlyBase: 7_200_000,
    allowance: 400_000,
    deduction: 100_000,
  },
];

const MORNING = { start: "07:00", end: "15:00" };
const AFTERNOON = { start: "14:00", end: "22:00" };

/** Tuần 05–11/10/2026: sáng / chiều / nghỉ xoay vòng, đủ để xem bảng lịch. */
function weekShifts(): Shift[] {
  const roster: Array<{ employeeId: string; storeId: string; offset: number }> = [
    { employeeId: "e1", storeId: "s1", offset: 0 },
    { employeeId: "e3", storeId: "s1", offset: 1 },
    { employeeId: "e2", storeId: "s1", offset: 2 },
    { employeeId: "e5", storeId: "s1", offset: 1 },
    { employeeId: "e7", storeId: "s2", offset: 0 },
  ];
  const shifts: Shift[] = [];
  for (const { employeeId, storeId, offset } of roster) {
    for (let day = 0; day < 7; day += 1) {
      const kind = (offset + day) % 3;
      if (kind === 2) continue; // nghỉ
      const date = `2026-10-${String(5 + day).padStart(2, "0")}`;
      shifts.push({
        id: `sh-${employeeId}-${date}`,
        employeeId,
        storeId,
        date,
        ...(kind === 0 ? MORNING : AFTERNOON),
        note: "",
      });
    }
  }
  return shifts;
}

const attendance: AttendanceRecord[] = [
  {
    id: "a1",
    employeeId: "e1",
    date: "2026-09-28",
    checkIn: "06:55",
    checkOut: "15:02",
    flags: [],
    approved: true,
  },
  {
    id: "a2",
    employeeId: "e1",
    date: "2026-09-29",
    checkIn: "13:56",
    checkOut: "22:04",
    flags: [],
    approved: true,
  },
  {
    id: "a3",
    employeeId: "e1",
    date: "2026-09-30",
    checkIn: "06:58",
    checkOut: "15:00",
    flags: [],
    approved: true,
  },
  {
    id: "a4",
    employeeId: "e2",
    date: "2026-09-29",
    checkIn: "07:18",
    checkOut: "15:01",
    flags: ["late"],
    approved: true,
  },
  {
    id: "a5",
    employeeId: "e2",
    date: "2026-09-30",
    checkIn: null,
    checkOut: "22:00",
    flags: ["missing_in"],
    approved: false,
  },
  {
    id: "a6",
    employeeId: "e3",
    date: "2026-09-29",
    checkIn: "06:57",
    checkOut: "14:40",
    flags: ["early"],
    approved: true,
  },
  {
    id: "a7",
    employeeId: "e3",
    date: "2026-09-30",
    checkIn: "13:58",
    checkOut: null,
    flags: ["missing_out"],
    approved: false,
  },
  {
    id: "a8",
    employeeId: "e5",
    date: "2026-09-30",
    checkIn: "07:01",
    checkOut: "15:03",
    flags: [],
    approved: true,
  },
];

const adjustments: AdjustmentRequest[] = [
  {
    id: "r1",
    employeeId: "e3",
    recordId: "a7",
    date: "2026-09-30",
    content: "Thiếu giờ ra — quên chấm khi hết ca",
    requestedCheckIn: null,
    requestedCheckOut: "22:05",
    status: "pending",
    reviewNote: "",
  },
  {
    id: "r2",
    employeeId: "e2",
    recordId: "a5",
    date: "2026-09-30",
    content: "Yêu cầu sửa công — máy chấm công lỗi lúc vào ca",
    requestedCheckIn: "13:55",
    requestedCheckOut: null,
    status: "pending",
    reviewNote: "",
  },
];

/** Công đã duyệt trong kỳ 09/2026 trước 28/09, khóa `${employeeId}:${period}`. */
const approvedDaysBefore: Record<string, number> = {
  "e1:2026-09": 23,
  "e2:2026-09": 22,
  "e3:2026-09": 20,
  "e4:2026-09": 18,
  "e5:2026-09": 10,
  "e6:2026-09": 26,
  "e7:2026-09": 24,
};

const sales: SalesFigure[] = [
  {
    employeeId: "e1",
    period: PREVIEW_PERIOD,
    grossAfterDiscount: 108_000_000,
    returns: 3_000_000,
    target: 100_000_000,
  },
  {
    employeeId: "e2",
    period: PREVIEW_PERIOD,
    grossAfterDiscount: 97_000_000,
    returns: 2_000_000,
    target: 100_000_000,
  },
  {
    employeeId: "e3",
    period: PREVIEW_PERIOD,
    grossAfterDiscount: 121_000_000,
    returns: 1_000_000,
    target: 100_000_000,
  },
  {
    employeeId: "e4",
    period: PREVIEW_PERIOD,
    grossAfterDiscount: 100_000_000,
    returns: 0,
    target: 100_000_000,
  },
  {
    employeeId: "e7",
    period: PREVIEW_PERIOD,
    grossAfterDiscount: 88_000_000,
    returns: 2_000_000,
    target: 90_000_000,
  },
];

const bonuses: BonusReview[] = [
  {
    id: "b1",
    employeeId: "e1",
    period: PREVIEW_PERIOD,
    proposed: 1_200_000,
    approved: null,
    status: "pending",
    reason: "",
    compliance: true,
    service: true,
  },
  {
    id: "b2",
    employeeId: "e2",
    period: PREVIEW_PERIOD,
    proposed: 800_000,
    approved: null,
    status: "pending",
    reason: "",
    compliance: true,
    service: true,
  },
  {
    id: "b3",
    employeeId: "e3",
    period: PREVIEW_PERIOD,
    proposed: 1_600_000,
    approved: null,
    status: "pending",
    reason: "",
    compliance: true,
    service: true,
  },
  {
    id: "b4",
    employeeId: "e4",
    period: PREVIEW_PERIOD,
    proposed: 800_000,
    approved: null,
    status: "pending",
    reason: "",
    compliance: true,
    service: true,
  },
  {
    id: "b7",
    employeeId: "e7",
    period: PREVIEW_PERIOD,
    proposed: 500_000,
    approved: null,
    status: "pending",
    reason: "",
    compliance: true,
    service: false,
  },
];

const reviews: MonthlyReview[] = [
  {
    id: "v1",
    employeeId: "e1",
    period: PREVIEW_PERIOD,
    ratings: { results: "good", expertise: "pass", compliance: "good", teamwork: "good" },
    comment: "Phục vụ tốt, tuân thủ quy trình, phối hợp nhóm hiệu quả.",
    status: "done",
  },
  {
    id: "v2",
    employeeId: "e2",
    period: PREVIEW_PERIOD,
    ratings: { results: "pass", expertise: "good", compliance: "good", teamwork: "pass" },
    comment: "",
    status: "done",
  },
  {
    id: "v3",
    employeeId: "e3",
    period: PREVIEW_PERIOD,
    ratings: { results: "good", expertise: "good", compliance: "pass", teamwork: "good" },
    comment: "",
    status: "done",
  },
  {
    id: "v5",
    employeeId: "e5",
    period: PREVIEW_PERIOD,
    ratings: null,
    comment: "",
    status: "pending",
  },
  {
    id: "v7",
    employeeId: "e7",
    period: PREVIEW_PERIOD,
    ratings: null,
    comment: "",
    status: "pending",
  },
];

const proposals: PromotionProposal[] = [
  {
    id: "p1",
    employeeId: "e3",
    currentTitle: "Dược sĩ",
    proposedTitle: "Dược sĩ trưởng ca",
    effectiveDate: "2026-11-01",
    reason: "Hoàn thành tốt công việc, hỗ trợ đồng nghiệp mới.",
    salaryChange: "Chờ thỏa thuận",
    accessReview: "keep",
    status: "submitted",
    decisionNote: "",
    updatedAt: "2026-09-28",
  },
  {
    id: "p2",
    employeeId: "e2",
    currentTitle: "Dược sĩ",
    proposedTitle: "Dược sĩ trưởng ca",
    effectiveDate: "2026-07-01",
    reason: "Đề xuất sau 6 tháng làm việc.",
    salaryChange: "",
    accessReview: "keep",
    status: "rejected",
    decisionNote: "Chưa đủ thời gian làm việc theo quy định nội bộ; xem xét lại sau.",
    updatedAt: "2026-06-20",
  },
];

/** Trạng thái ban đầu mới tinh mỗi lần mở trang; không đọc hay ghi bộ nhớ trình duyệt. */
export function initialPreviewState(): PreviewState {
  return {
    stores,
    employees,
    shifts: weekShifts(),
    weeks: [
      { storeId: "s1", weekStart: PREVIEW_WEEK_START, status: "draft", changedAfterPublish: false },
      {
        storeId: "s2",
        weekStart: PREVIEW_WEEK_START,
        status: "published",
        changedAfterPublish: false,
      },
    ],
    approvedDaysBefore,
    attendance,
    adjustments,
    sales,
    bonuses,
    payroll: { period: PREVIEW_PERIOD, status: "none", paymentStatus: "unpaid", lines: [] },
    reviews,
    proposals,
  };
}
