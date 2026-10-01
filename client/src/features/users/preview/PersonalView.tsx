import { AimOutlined, BarChartOutlined, CalendarOutlined, GiftOutlined } from "@ant-design/icons";
import { Alert, Card, Empty, Progress, Select } from "antd";
import { money, percent } from "../staff-format.js";
import { Pairs, StaffNote, StaffStat, StatusDot } from "../staff-ui.js";
import { PREVIEW_PERIOD, PREVIEW_TODAY } from "./preview-fixtures.js";
import {
  approvedBonusOf,
  netSales,
  nextPublishedShift,
  overallRating,
  payslipFor,
  salesOf,
  weekStartOf,
} from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import {
  employeeOf,
  formatDay,
  formatPeriod,
  PAYROLL_STATUS,
  storeShort,
  weekdayOf,
} from "./preview-format.js";
import { SampleTag } from "./preview-ui.js";

/**
 * MÔ PHỎNG góc nhìn của một nhân viên. Khi có backend, phần này thuộc mục
 * "Cá nhân" của chính tài khoản đăng nhập và máy chủ chỉ trả dữ liệu của người
 * đó; ở đây người xem được chọn từ danh sách mẫu để xem thiết kế.
 */
export function PersonalView({
  viewerId,
  onViewerChange,
}: {
  viewerId: string;
  onViewerChange: (id: string) => void;
}) {
  const { state } = usePreview();
  const me = employeeOf(state, viewerId) ?? state.employees[0]!;
  const firstName = me.fullName.split(" ").slice(-2).join(" ");
  const next = nextPublishedShift(state, me.id, PREVIEW_TODAY);
  const sales = salesOf(state, me.id, PREVIEW_PERIOD);
  const bonusReview = state.bonuses.find(
    (bonus) => bonus.employeeId === me.id && bonus.period === PREVIEW_PERIOD,
  );
  const approvedBonus = approvedBonusOf(state, me.id, PREVIEW_PERIOD);
  const slip = payslipFor(state, me.id, "self");
  const review = state.reviews.find(
    (item) => item.employeeId === me.id && item.period === PREVIEW_PERIOD && item.status === "done",
  );
  const published = new Set(
    state.weeks
      .filter((week) => week.status === "published")
      .map((week) => `${week.storeId}:${week.weekStart}`),
  );
  const upcoming = state.shifts
    .filter(
      (shift) =>
        shift.employeeId === me.id &&
        shift.date >= PREVIEW_TODAY &&
        published.has(`${shift.storeId}:${weekStartOf(shift.date)}`),
    )
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .slice(0, 3);

  return (
    <>
      <Alert
        type="warning"
        showIcon
        className="staff-inline-alert"
        title="Mô phỏng góc nhìn nhân viên"
        description="Chọn một nhân viên mẫu để xem như họ thấy. Khi triển khai thật, mỗi người chỉ mở được mục Cá nhân của chính mình và máy chủ kiểm tra quyền, không dựa vào việc ẩn tab."
        action={
          <Select
            aria-label="Xem với tư cách"
            value={me.id}
            onChange={onViewerChange}
            options={state.employees.map((employee) => ({
              value: employee.id,
              label: `${employee.fullName} (${employee.code})`,
            }))}
            style={{ minWidth: 220 }}
          />
        }
      />
      <div className="staff-personal-head">
        <span className="staff-muted">{formatDay(PREVIEW_TODAY)}</span>
        <h2>Xin chào, {firstName}</h2>
        <p>
          Theo dõi lịch làm và kết quả của bạn. <SampleTag />
        </p>
      </div>
      <div className="staff-stats">
        <StaffStat
          icon={<CalendarOutlined />}
          value={next ? `${next.start} – ${next.end}` : "Chưa có"}
          label={
            next ? `Ca tiếp theo · ${weekdayOf(next.date)} ${formatDay(next.date)}` : "Ca tiếp theo"
          }
          hint={next ? storeShort(state, next.storeId) : "Lịch tuần chưa được công bố"}
        />
        <StaffStat
          icon={<BarChartOutlined />}
          tone="green"
          value={sales ? money(netSales(sales)) : "—"}
          label={`Doanh số thuần ${formatPeriod(PREVIEW_PERIOD)}`}
        />
        <StaffStat
          icon={<AimOutlined />}
          value={sales ? percent(netSales(sales), sales.target) : "—"}
          label="Hoàn thành mục tiêu"
          hint={sales ? `của ${money(sales.target)}` : "Chức danh không bán hàng"}
        />
        <StaffStat
          icon={<GiftOutlined />}
          tone="purple"
          value={
            approvedBonus
              ? money(approvedBonus.approved)
              : bonusReview
                ? money(bonusReview.proposed)
                : "—"
          }
          label={approvedBonus ? "Thưởng đã duyệt" : "Thưởng dự kiến"}
          hint={
            approvedBonus ? undefined : bonusReview ? "Chờ xét duyệt, có thể thay đổi" : undefined
          }
        />
      </div>
      <div className="staff-split">
        <div className="staff-stack">
          <Card className="staff-card" title="Doanh số của tôi">
            {sales ? (
              <>
                <Progress
                  percent={Math.min(100, Math.round((netSales(sales) / sales.target) * 100))}
                  format={() => percent(netSales(sales), sales.target)}
                />
                <div className="staff-equation">
                  <div>
                    <small>Doanh số sau giảm giá</small>
                    <strong>{money(sales.grossAfterDiscount)}</strong>
                  </div>
                  <span aria-hidden>−</span>
                  <div>
                    <small>Hàng trả</small>
                    <strong>{money(sales.returns)}</strong>
                  </div>
                  <span aria-hidden>=</span>
                  <div>
                    <small>Doanh số thuần</small>
                    <strong>{money(netSales(sales))}</strong>
                  </div>
                </div>
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Chức danh của bạn không tính doanh số bán hàng"
              />
            )}
          </Card>
          <Card className="staff-card" title="Lịch sắp tới">
            {upcoming.length ? (
              <ul className="staff-upcoming">
                {upcoming.map((shift) => (
                  <li key={shift.id}>
                    <small>
                      {weekdayOf(shift.date)} · {formatDay(shift.date)}
                    </small>
                    <strong>
                      {shift.start} – {shift.end}
                    </strong>
                    <span>{storeShort(state, shift.storeId)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có lịch đã công bố" />
            )}
          </Card>
        </div>
        <div className="staff-stack">
          <Card className="staff-card" title={`Phiếu lương tháng ${formatPeriod(PREVIEW_PERIOD)}`}>
            {slip ? (
              <>
                <div className="staff-payslip-tags">
                  <StatusDot tone={PAYROLL_STATUS.published.tone}>
                    {PAYROLL_STATUS.published.label}
                  </StatusDot>
                  <StatusDot tone={state.payroll.paymentStatus === "paid" ? "green" : "orange"}>
                    {state.payroll.paymentStatus === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}
                  </StatusDot>
                </div>
                <Pairs
                  items={[
                    ["Lương theo công", money(slip.basePay)],
                    ["Phụ cấp", money(slip.allowance)],
                    ["Thưởng đã duyệt", money(slip.bonus)],
                    ["Khấu trừ", money(slip.deduction)],
                  ]}
                />
                <div className="staff-total">
                  <span>Thực nhận</span>
                  <strong>{money(slip.net)}</strong>
                </div>
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Phiếu lương chưa được công bố"
              />
            )}
          </Card>
          <Card className="staff-card" title={`Đánh giá tháng ${formatPeriod(PREVIEW_PERIOD)}`}>
            {review?.ratings ? (
              <div className="staff-review-result">
                <strong>{overallRating(review.ratings)}</strong>
                {review.comment ? <p>{review.comment}</p> : null}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Chưa có đánh giá tháng này"
              />
            )}
          </Card>
        </div>
      </div>
      <StaffNote>Bạn chỉ xem dữ liệu của chính mình.</StaffNote>
    </>
  );
}
