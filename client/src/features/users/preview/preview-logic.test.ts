import { describe, expect, it } from "vitest";
import { initialPreviewState, PREVIEW_PERIOD, PREVIEW_TODAY } from "./preview-fixtures.js";
import {
  approvedDays,
  buildPayrollLines,
  netSales,
  nextPublishedShift,
  payslipFor,
  salesOf,
  validateShift,
} from "./preview-logic.js";
import { previewReducer, type PreviewAction } from "./preview-reducer.js";
import type { PreviewState } from "./preview-types.js";

const run = (state: PreviewState, ...actions: PreviewAction[]) =>
  actions.reduce(previewReducer, state);
const approveB1 = {
  type: "approveBonus",
  id: "b1",
  amount: 1_200_000,
  reason: "",
  compliance: true,
  service: true,
} as const;

describe("doanh số", () => {
  it("doanh số thuần = sau giảm giá − hàng trả, không trừ giảm giá lần hai", () => {
    const figure = salesOf(initialPreviewState(), "e1", PREVIEW_PERIOD)!;
    expect(netSales(figure)).toBe(105_000_000);
  });
});

describe("thưởng sang lương", () => {
  it("thưởng đã duyệt vào lương đúng một lần, lập lại bảng lương không cộng trùng", () => {
    const state = run(
      initialPreviewState(),
      approveB1,
      { type: "buildPayroll" },
      { type: "buildPayroll" },
    );
    const line = state.payroll.lines.find((item) => item.employeeId === "e1")!;
    expect(line.bonus).toBe(1_200_000);
    expect(line.bonusReviewId).toBe("b1");
    expect(line.net).toBe(8_000_000 + 500_000 + 1_200_000 - 200_000);
    const ids = state.payroll.lines.map((item) => item.bonusReviewId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("thưởng chưa duyệt không vào lương", () => {
    const line = buildPayrollLines(initialPreviewState(), PREVIEW_PERIOD).find(
      (item) => item.employeeId === "e2",
    )!;
    expect(line.bonus).toBe(0);
    expect(line.bonusReviewId).toBeNull();
  });

  it("đổi mức thưởng so với đề xuất phải có lý do", () => {
    const state = run(initialPreviewState(), { ...approveB1, amount: 1_000_000 });
    expect(state.bonuses.find((item) => item.id === "b1")!.status).toBe("pending");
    const withReason = run(initialPreviewState(), {
      ...approveB1,
      amount: 1_000_000,
      reason: "Có phản ánh chất lượng phục vụ",
    });
    expect(withReason.bonuses.find((item) => item.id === "b1")!.approved).toBe(1_000_000);
  });

  it("đã gửi duyệt bảng lương thì khóa duyệt thưởng", () => {
    const state = run(
      initialPreviewState(),
      { type: "buildPayroll" },
      { type: "submitPayroll" },
      approveB1,
    );
    expect(state.bonuses.find((item) => item.id === "b1")!.status).toBe("pending");
  });

  it("không công bố khi chưa duyệt; thanh toán theo dõi riêng", () => {
    const draft = run(initialPreviewState(), { type: "buildPayroll" }, { type: "publishPayroll" });
    expect(draft.payroll.status).toBe("draft");
    const approved = run(draft, { type: "submitPayroll" }, { type: "approvePayroll" });
    expect(approved.payroll.status).toBe("approved");
    expect(approved.payroll.paymentStatus).toBe("unpaid");
  });
});

describe("phiếu lương theo góc nhìn", () => {
  it("nhân viên chỉ thấy phiếu của mình sau khi công bố; quản lý thấy từ khi lập", () => {
    const approved = run(
      initialPreviewState(),
      { type: "buildPayroll" },
      { type: "submitPayroll" },
      { type: "approvePayroll" },
    );
    expect(payslipFor(approved, "e1", "manager")).not.toBeNull();
    expect(payslipFor(approved, "e1", "self")).toBeNull();
    const published = run(approved, { type: "publishPayroll" });
    expect(payslipFor(published, "e1", "self")?.employeeId).toBe("e1");
  });
});

describe("lịch làm và chấm công", () => {
  const base = { employeeId: "e1", storeId: "s1", date: "2026-10-06", note: "" };

  it("chặn giờ kết thúc trước giờ bắt đầu và ca trùng giờ", () => {
    const state = initialPreviewState();
    expect(validateShift(state, { ...base, start: "15:00", end: "07:00" })).toMatch(
      /sau giờ bắt đầu/,
    );
    // 06/10 NV001 đã có ca 14:00–22:00 trong dữ liệu mẫu.
    expect(validateShift(state, { ...base, start: "13:00", end: "16:00" })).toMatch(/Trùng ca/);
    expect(validateShift(state, { ...base, start: "07:00", end: "12:00" })).toBeNull();
  });

  it("không xếp ca cho nhân viên đang tạm nghỉ", () => {
    expect(
      validateShift(initialPreviewState(), {
        ...base,
        employeeId: "e4",
        storeId: "s2",
        start: "07:00",
        end: "15:00",
      }),
    ).toMatch(/tạm nghỉ/);
  });

  it("ca dự kiến không thành công thực tế; chỉ duyệt yêu cầu mới tăng công", () => {
    const state = initialPreviewState();
    const before = approvedDays(state, "e3", PREVIEW_PERIOD);
    const scheduled = run(state, {
      type: "saveShift",
      shift: {
        id: "x",
        employeeId: "e3",
        storeId: "s1",
        date: "2026-09-27",
        start: "07:00",
        end: "15:00",
        note: "",
      },
    });
    expect(approvedDays(scheduled, "e3", PREVIEW_PERIOD)).toBe(before);
    const reviewed = run(state, {
      type: "reviewAdjustment",
      id: "r1",
      decision: "approved",
      note: "",
    });
    expect(approvedDays(reviewed, "e3", PREVIEW_PERIOD)).toBe(before + 1);
  });

  it("từ chối yêu cầu sửa công phải có ghi chú", () => {
    const state = run(initialPreviewState(), {
      type: "reviewAdjustment",
      id: "r2",
      decision: "rejected",
      note: " ",
    });
    expect(state.adjustments.find((item) => item.id === "r2")!.status).toBe("pending");
  });

  it("nhân viên chỉ thấy ca từ lịch đã công bố; sửa lịch đã công bố đưa tuần về nháp", () => {
    const state = initialPreviewState();
    expect(nextPublishedShift(state, "e1", PREVIEW_TODAY)).toBeNull(); // tuần của GPP số 1 còn nháp
    const published = run(state, { type: "publishWeek", storeId: "s1", weekStart: "2026-10-05" });
    expect(nextPublishedShift(published, "e1", PREVIEW_TODAY)?.date).toBe("2026-10-05");
    const edited = run(published, { type: "deleteShift", id: "sh-e1-2026-10-05" });
    const week = edited.weeks.find((item) => item.storeId === "s1")!;
    expect(week.status).toBe("draft");
    expect(week.changedAfterPublish).toBe(true);
  });
});

describe("đề xuất thăng chức", () => {
  it("đã gửi thì không sửa như nháp; từ chối phải có lý do; duyệt không đổi quyền truy cập", () => {
    const state = initialPreviewState();
    const p1 = state.proposals.find((item) => item.id === "p1")!;
    const edited = run(state, {
      type: "saveProposal",
      proposal: { ...p1, reason: "Sửa sau khi gửi" },
    });
    expect(edited.proposals.find((item) => item.id === "p1")!.reason).toBe(p1.reason);

    const noNote = run(state, { type: "decideProposal", id: "p1", decision: "rejected", note: "" });
    expect(noNote.proposals.find((item) => item.id === "p1")!.status).toBe("submitted");

    const approved = run(state, {
      type: "decideProposal",
      id: "p1",
      decision: "approved",
      note: "",
    });
    expect(approved.proposals.find((item) => item.id === "p1")!.status).toBe("approved");
    expect(approved.employees.find((item) => item.id === "e3")!.accessRole).toBe("Dược sĩ");
  });

  it("form chưa gửi luôn ở trạng thái nháp", () => {
    const state = run(initialPreviewState(), {
      type: "saveProposal",
      proposal: {
        id: "new",
        employeeId: "e1",
        currentTitle: "Dược sĩ",
        proposedTitle: "Dược sĩ trưởng ca",
        effectiveDate: "2026-11-01",
        reason: "Tốt",
        salaryChange: "",
        accessReview: "keep",
        status: "submitted",
        decisionNote: "",
        updatedAt: PREVIEW_TODAY,
      },
    });
    expect(state.proposals.find((item) => item.id === "new")!.status).toBe("draft");
  });
});
