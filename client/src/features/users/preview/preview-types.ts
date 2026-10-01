/**
 * Kiểu dữ liệu của BẢN XEM TRƯỚC nhân sự. Chưa có API hay bảng CSDL tương
 * ứng; mọi giá trị chỉ sống trong bộ nhớ của trang. Không dùng các kiểu này
 * cho dữ liệu vận hành.
 */

export type PreviewStore = { id: string; name: string; short: string };

/** Tình trạng làm việc (nhân sự) — khác trạng thái tài khoản đăng nhập. */
export type WorkStatus = "working" | "probation" | "on_leave";

export type PreviewEmployee = {
  id: string;
  /** Mã nhân viên nội bộ, chỉ có trong bản xem trước. */
  code: string;
  fullName: string;
  username: string;
  /** Chức danh công việc — khác vai trò truy cập phần mềm. */
  title: string;
  storeId: string;
  /** Vai trò truy cập phần mềm, chỉ để minh họa. */
  accessRole: string;
  workStatus: WorkStatus;
  /** Trạng thái tài khoản đăng nhập, độc lập với tình trạng làm việc. */
  accountActive: boolean;
  joinedAt: string;
  phone: string | null;
  certificate: string | null;
  /** Lương cơ bản tháng theo 26 công chuẩn — số minh họa, không phải chính sách. */
  monthlyBase: number;
  allowance: number;
  deduction: number;
};

export type Shift = {
  id: string;
  employeeId: string;
  storeId: string;
  /** yyyy-mm-dd */
  date: string;
  /** HH:mm */
  start: string;
  end: string;
  note: string;
};

export type ScheduleWeek = {
  storeId: string;
  weekStart: string;
  status: "draft" | "published";
  /** Đã công bố rồi lại sửa: cần công bố lại để nhân viên thấy bản mới. */
  changedAfterPublish: boolean;
};

export type AttendanceFlag = "late" | "early" | "missing_in" | "missing_out";

export type AttendanceRecord = {
  id: string;
  employeeId: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  flags: AttendanceFlag[];
  /** Công được duyệt. Ca dự kiến KHÔNG bao giờ tự thành công thực tế. */
  approved: boolean;
};

export type AdjustmentRequest = {
  id: string;
  employeeId: string;
  recordId: string;
  date: string;
  content: string;
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  status: "pending" | "approved" | "rejected";
  reviewNote: string;
};

export type SalesFigure = {
  employeeId: string;
  period: string;
  /** Doanh số người bán trên hóa đơn, ĐÃ trừ giảm giá (trừ đúng một lần). */
  grossAfterDiscount: number;
  /** Hàng trả, quy về người bán gốc. */
  returns: number;
  target: number;
};

export type BonusReview = {
  id: string;
  employeeId: string;
  period: string;
  /** Mức đề xuất theo chính sách MẪU, không phải công thức đã cấu hình. */
  proposed: number;
  approved: number | null;
  status: "pending" | "approved";
  reason: string;
  compliance: boolean;
  service: boolean;
};

export type PayrollStatus = "none" | "draft" | "pending" | "approved" | "published";

export type PayrollLine = {
  employeeId: string;
  approvedDays: number;
  basePay: number;
  allowance: number;
  bonus: number;
  /** Khoản thưởng nguồn; mỗi khoản chỉ được gắn vào đúng một dòng lương. */
  bonusReviewId: string | null;
  deduction: number;
  net: number;
};

export type PayrollRun = {
  period: string;
  status: PayrollStatus;
  /** Thanh toán theo dõi riêng: duyệt lương không có nghĩa đã trả tiền. */
  paymentStatus: "unpaid" | "paid";
  lines: PayrollLine[];
};

export type Criterion = "results" | "expertise" | "compliance" | "teamwork";
export type Rating = "good" | "pass" | "improve";

export type MonthlyReview = {
  id: string;
  employeeId: string;
  period: string;
  ratings: Record<Criterion, Rating> | null;
  comment: string;
  status: "pending" | "done";
};

export type ProposalStatus = "draft" | "submitted" | "approved" | "rejected";

export type PromotionProposal = {
  id: string;
  employeeId: string;
  currentTitle: string;
  proposedTitle: string;
  effectiveDate: string;
  reason: string;
  salaryChange: string;
  /** Quyền phần mềm được xét riêng; thăng chức không tự cấp quyền. */
  accessReview: "keep" | "review_separately";
  status: ProposalStatus;
  decisionNote: string;
  updatedAt: string;
};

export type PreviewState = {
  stores: PreviewStore[];
  employees: PreviewEmployee[];
  shifts: Shift[];
  weeks: ScheduleWeek[];
  /** Công đã duyệt trước khoảng ngày đang hiển thị, theo kỳ. */
  approvedDaysBefore: Record<string, number>;
  attendance: AttendanceRecord[];
  adjustments: AdjustmentRequest[];
  sales: SalesFigure[];
  bonuses: BonusReview[];
  payroll: PayrollRun;
  reviews: MonthlyReview[];
  proposals: PromotionProposal[];
};
