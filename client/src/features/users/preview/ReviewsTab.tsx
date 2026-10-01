import { SendOutlined, StarOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Modal,
  Radio,
  Select,
  Table,
  Tabs,
} from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { PersonCell, StaffNote, StatusDot } from "../staff-ui.js";
import { PREVIEW_PERIOD, PREVIEW_TODAY } from "./preview-fixtures.js";
import { CRITERIA, overallRating, RATING_LABEL } from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import type {
  Criterion,
  MonthlyReview,
  PreviewEmployee,
  PromotionProposal,
  Rating,
} from "./preview-types.js";
import { employeeOf, formatDay, formatPeriod, PROPOSAL_STATUS } from "./preview-format.js";
import { SampleTag, SectionHead } from "./preview-ui.js";

const RATING_TONE: Record<Rating, "green" | "blue" | "orange"> = {
  good: "green",
  pass: "blue",
  improve: "orange",
};
/** Chức danh mẫu cho bản xem trước; hệ thống chưa có danh mục chức danh. */
const SAMPLE_TITLES = [
  "Dược sĩ",
  "Dược sĩ trưởng ca",
  "Dược sĩ phụ trách chuyên môn",
  "Quản lý cửa hàng",
  "Nhân viên kho",
  "Trưởng kho",
];

export function ReviewsTab({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { state } = usePreview();
  const employee = employeeOf(state, selectedId) ?? state.employees[0]!;
  return (
    <div className="staff-split">
      <Card className="staff-card">
        <SectionHead
          title="Đánh giá nhân viên"
          description={`Tháng ${formatPeriod(PREVIEW_PERIOD)}`}
          extra={<SampleTag />}
        />
        <Tabs
          className="staff-subtabs"
          items={[
            {
              key: "monthly",
              label: "Đánh giá tháng",
              children: <MonthlyReviews selected={employee} onSelect={onSelect} />,
            },
            {
              key: "proposals",
              label: "Đề xuất thăng chức",
              children: <ProposalList onSelect={onSelect} />,
            },
            { key: "history", label: "Lịch sử", children: <History employee={employee} /> },
          ]}
        />
      </Card>
      <Card className="staff-card staff-aside" title="Đề xuất thăng chức">
        <ProposalForm key={employee.id} employee={employee} />
      </Card>
    </div>
  );
}

function reviewOf(reviews: MonthlyReview[], employeeId: string) {
  return reviews.find(
    (review) => review.employeeId === employeeId && review.period === PREVIEW_PERIOD,
  );
}

function MonthlyReviews({
  selected,
  onSelect,
}: {
  selected: PreviewEmployee;
  onSelect: (id: string) => void;
}) {
  const { state } = usePreview();
  const [editing, setEditing] = useState(false);
  const review = reviewOf(state.reviews, selected.id);
  const people = state.employees.filter((employee) => employee.workStatus !== "on_leave");

  return (
    <>
      <Table<PreviewEmployee>
        rowKey="id"
        className="staff-table"
        dataSource={people}
        pagination={false}
        scroll={{ x: 860 }}
        rowClassName={(row) => (row.id === selected.id ? "staff-row-selected" : "")}
        onRow={(row) => ({
          onClick: () => onSelect(row.id),
          onKeyDown: (event) => event.key === "Enter" && onSelect(row.id),
          tabIndex: 0,
        })}
        columns={[
          {
            title: "Nhân viên",
            key: "person",
            fixed: "left",
            width: 200,
            render: (_, row) => <PersonCell name={row.fullName} id={row.id} sub={row.code} />,
          },
          ...CRITERIA.map((criterion) => ({
            title: criterion.label,
            key: criterion.key,
            render: (_: unknown, row: PreviewEmployee) => {
              const rating = reviewOf(state.reviews, row.id)?.ratings?.[criterion.key];
              return rating ? RATING_LABEL[rating] : <span className="staff-muted">—</span>;
            },
          })),
          {
            title: "Kết quả",
            key: "overall",
            render: (_, row) => {
              const ratings = reviewOf(state.reviews, row.id)?.ratings;
              return ratings ? overallRating(ratings) : <span className="staff-muted">—</span>;
            },
          },
          {
            title: "Trạng thái",
            key: "status",
            render: (_, row) =>
              reviewOf(state.reviews, row.id)?.status === "done" ? (
                <StatusDot tone="green">Đã đánh giá</StatusDot>
              ) : (
                <StatusDot tone="orange">Chưa đánh giá</StatusDot>
              ),
          },
        ]}
      />
      <div className="staff-review-detail">
        <div className="staff-review-head">
          <h3>
            Kết quả đánh giá: {selected.fullName} ({selected.code})
          </h3>
          <Button icon={<StarOutlined />} onClick={() => setEditing(true)}>
            {review?.status === "done" ? "Sửa đánh giá" : "Đánh giá"}
          </Button>
        </div>
        {review?.ratings ? (
          <ul className="staff-criteria">
            {CRITERIA.map((criterion) => (
              <li key={criterion.key}>
                <div>
                  <strong>{criterion.label}</strong>
                  <small>{criterion.hint}</small>
                </div>
                <StatusDot tone={RATING_TONE[review.ratings![criterion.key]]}>
                  {RATING_LABEL[review.ratings![criterion.key]]}
                </StatusDot>
              </li>
            ))}
          </ul>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa đánh giá tháng này" />
        )}
        {review?.comment ? <p className="staff-review-comment">{review.comment}</p> : null}
        <StaffNote>
          Doanh số là một tiêu chí trong tổng thể; đề xuất thăng chức xét nhiều tiêu chí, không chỉ
          dựa vào doanh số.
        </StaffNote>
      </div>
      {editing ? (
        <ReviewModal employee={selected} review={review} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

/** Mount khi mở nên khởi tạo một lần từ đánh giá hiện có. */
function ReviewModal({
  employee,
  review,
  onClose,
}: {
  employee: PreviewEmployee;
  review?: MonthlyReview;
  onClose: () => void;
}) {
  const { dispatch } = usePreview();
  const { message } = App.useApp();
  const [ratings, setRatings] = useState<Partial<Record<Criterion, Rating>>>(
    () => review?.ratings ?? {},
  );
  const [comment, setComment] = useState(review?.comment ?? "");
  const [tried, setTried] = useState(false);

  const complete = CRITERIA.every((criterion) => ratings[criterion.key]);
  return (
    <Modal
      open
      title={`Đánh giá tháng ${formatPeriod(PREVIEW_PERIOD)} · ${employee.fullName}`}
      okText="Lưu đánh giá"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => {
        setTried(true);
        if (!complete) return;
        dispatch({
          type: "saveReview",
          employeeId: employee.id,
          ratings: ratings as Record<Criterion, Rating>,
          comment,
        });
        void message.success("Đã lưu đánh giá (mẫu).");
        onClose();
      }}
    >
      <div className="staff-form-grid">
        {CRITERIA.map((criterion) => (
          <fieldset key={criterion.key} className="staff-fieldset">
            <legend>
              {criterion.label} <span className="staff-required">*</span>
            </legend>
            <Radio.Group
              value={ratings[criterion.key]}
              onChange={(event) =>
                setRatings((current) => ({
                  ...current,
                  [criterion.key]: event.target.value as Rating,
                }))
              }
              options={(Object.keys(RATING_LABEL) as Rating[]).map((value) => ({
                value,
                label: RATING_LABEL[value],
              }))}
            />
            {tried && !ratings[criterion.key] ? (
              <div className="staff-field-error">Chọn mức đánh giá</div>
            ) : null}
          </fieldset>
        ))}
        <label className="staff-field">
          <span>Nhận xét</span>
          <Input.TextArea
            rows={3}
            maxLength={500}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}

function ProposalForm({ employee }: { employee: PreviewEmployee }) {
  const { state, dispatch } = usePreview();
  const { message } = App.useApp();
  const existing = state.proposals.find(
    (proposal) =>
      proposal.employeeId === employee.id &&
      (proposal.status === "draft" || proposal.status === "submitted"),
  );
  const [edit, setDraft] = useState<PromotionProposal>(
    () =>
      existing ?? {
        id: crypto.randomUUID(),
        employeeId: employee.id,
        currentTitle: employee.title,
        proposedTitle: "",
        effectiveDate: "",
        reason: "",
        salaryChange: "",
        accessReview: "keep",
        status: "draft",
        decisionNote: "",
        updatedAt: PREVIEW_TODAY,
      },
  );
  const [tried, setTried] = useState(false);
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const [note, setNote] = useState("");
  // Đã gửi, duyệt hay từ chối thì hiển thị đúng bản trong store; còn nháp thì hiển thị bản đang sửa.
  const stored = state.proposals.find((proposal) => proposal.id === edit.id);
  const draft = stored && stored.status !== "draft" ? stored : edit;
  const saved = stored !== undefined;
  const readOnly = draft.status !== "draft";
  const errors = {
    proposedTitle: !draft.proposedTitle
      ? "Chọn chức danh đề xuất"
      : draft.proposedTitle === employee.title
        ? "Chức danh đề xuất trùng chức danh hiện tại"
        : null,
    effectiveDate: !draft.effectiveDate
      ? "Chọn ngày hiệu lực"
      : draft.effectiveDate <= PREVIEW_TODAY
        ? "Ngày hiệu lực phải sau hôm nay"
        : null,
    reason: !draft.reason.trim() ? "Nhập lý do đề xuất" : null,
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const patch = (next: Partial<PromotionProposal>) =>
    setDraft((current) => ({ ...current, ...next, updatedAt: PREVIEW_TODAY }));

  const statusTag = saved ? (
    <StatusDot tone={PROPOSAL_STATUS[draft.status].tone}>
      {PROPOSAL_STATUS[draft.status].label}
    </StatusDot>
  ) : (
    <StatusDot tone="slate">Chưa lưu</StatusDot>
  );

  return (
    <div className="staff-proposal">
      <div className="staff-proposal-head">
        <PersonCell name={employee.fullName} id={employee.id} sub={employee.code} />
        {statusTag}
      </div>
      <label className="staff-field">
        <span>Chức danh hiện tại</span>
        <Input value={employee.title} disabled />
      </label>
      <div className="staff-two">
        <label className="staff-field">
          <span>
            Chức danh đề xuất <span className="staff-required">*</span>
          </span>
          <Select
            value={draft.proposedTitle || undefined}
            placeholder="Chọn chức danh"
            disabled={readOnly}
            onChange={(proposedTitle) => patch({ proposedTitle })}
            options={SAMPLE_TITLES.map((value) => ({ value, label: value }))}
            status={tried && errors.proposedTitle ? "error" : undefined}
          />
          {tried && errors.proposedTitle ? (
            <span className="staff-field-error">{errors.proposedTitle}</span>
          ) : null}
        </label>
        <label className="staff-field">
          <span>
            Ngày hiệu lực <span className="staff-required">*</span>
          </span>
          <DatePicker
            format="DD/MM/YYYY"
            value={draft.effectiveDate ? dayjs(draft.effectiveDate) : null}
            disabled={readOnly}
            onChange={(value) => patch({ effectiveDate: value ? value.format("YYYY-MM-DD") : "" })}
            status={tried && errors.effectiveDate ? "error" : undefined}
            style={{ width: "100%" }}
          />
          {tried && errors.effectiveDate ? (
            <span className="staff-field-error">{errors.effectiveDate}</span>
          ) : null}
        </label>
      </div>
      <label className="staff-field">
        <span>
          Lý do đề xuất <span className="staff-required">*</span>
        </span>
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={draft.reason}
          disabled={readOnly}
          onChange={(event) => patch({ reason: event.target.value })}
          status={tried && errors.reason ? "error" : undefined}
        />
        {tried && errors.reason ? <span className="staff-field-error">{errors.reason}</span> : null}
      </label>
      <div className="staff-two">
        <label className="staff-field">
          <span>Thay đổi lương (nếu có)</span>
          <Input
            value={draft.salaryChange}
            disabled={readOnly}
            placeholder="Ví dụ: Chờ thỏa thuận"
            maxLength={100}
            onChange={(event) => patch({ salaryChange: event.target.value })}
          />
        </label>
        <label className="staff-field">
          <span>Quyền truy cập phần mềm</span>
          <Select
            value={draft.accessReview}
            disabled={readOnly}
            onChange={(accessReview) => patch({ accessReview })}
            options={[
              { value: "keep", label: "Giữ nguyên" },
              { value: "review_separately", label: "Cần xem xét riêng" },
            ]}
          />
        </label>
      </div>
      <StaffNote>
        Thăng chức không tự cấp thêm quyền phần mềm. Thay đổi quyền làm riêng ở Quản lý vai trò, sau
        khi xem xét.
      </StaffNote>
      {draft.status === "rejected" || draft.status === "approved" ? (
        <Alert
          type={draft.status === "approved" ? "success" : "warning"}
          showIcon
          title={draft.decisionNote || PROPOSAL_STATUS[draft.status].label}
        />
      ) : null}

      {draft.status === "draft" ? (
        <div className="staff-inline-actions end">
          <Button
            onClick={() => {
              dispatch({ type: "saveProposal", proposal: draft });
              void message.success("Đã lưu nháp đề xuất (mẫu). Chưa gửi để duyệt.");
            }}
          >
            Lưu nháp
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={() => {
              setTried(true);
              if (hasErrors) return;
              dispatch({ type: "saveProposal", proposal: draft });
              dispatch({ type: "submitProposal", id: draft.id });
              void message.success("Đã gửi đề xuất (mẫu). Chức danh và quyền chưa thay đổi.");
            }}
          >
            Gửi đề xuất
          </Button>
        </div>
      ) : null}
      {draft.status === "submitted" ? (
        <div className="staff-inline-actions end">
          <span className="staff-muted">Người có quyền duyệt:</span>
          <Button danger onClick={() => setDeciding("rejected")}>
            Từ chối
          </Button>
          <Button type="primary" onClick={() => setDeciding("approved")}>
            Duyệt
          </Button>
        </div>
      ) : null}

      <Modal
        open={deciding !== null}
        title={deciding === "approved" ? "Duyệt đề xuất thăng chức" : "Từ chối đề xuất thăng chức"}
        okText={deciding === "approved" ? "Duyệt" : "Từ chối"}
        okButtonProps={{ danger: deciding === "rejected" }}
        cancelText="Hủy"
        onCancel={() => {
          setDeciding(null);
          setNote("");
        }}
        onOk={() => {
          if (!deciding || (deciding === "rejected" && !note.trim())) return;
          dispatch({ type: "decideProposal", id: draft.id, decision: deciding, note });
          void message.success(
            deciding === "approved"
              ? "Đã duyệt đề xuất (mẫu). Vai trò truy cập không thay đổi."
              : "Đã từ chối đề xuất (mẫu).",
          );
          setDeciding(null);
          setNote("");
        }}
      >
        <label className="staff-field">
          <span>
            Ghi chú quyết định{" "}
            {deciding === "rejected" ? <span className="staff-required">*</span> : "(nếu có)"}
          </span>
          <Input.TextArea
            rows={3}
            maxLength={300}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            status={deciding === "rejected" && !note.trim() ? "error" : undefined}
          />
        </label>
        {deciding === "rejected" && !note.trim() ? (
          <div className="staff-field-error">Ghi lý do từ chối.</div>
        ) : null}
      </Modal>
    </div>
  );
}

function ProposalList({ onSelect }: { onSelect: (id: string) => void }) {
  const { state } = usePreview();
  return (
    <Table<PromotionProposal>
      rowKey="id"
      className="staff-table"
      dataSource={state.proposals}
      pagination={false}
      scroll={{ x: 760 }}
      onRow={(row) => ({
        onClick: () => onSelect(row.employeeId),
        tabIndex: 0,
        onKeyDown: (event) => event.key === "Enter" && onSelect(row.employeeId),
      })}
      locale={{
        emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có đề xuất nào" />,
      }}
      columns={[
        {
          title: "Nhân viên",
          key: "person",
          render: (_, row) => {
            const employee = employeeOf(state, row.employeeId);
            return employee ? (
              <PersonCell name={employee.fullName} id={employee.id} sub={employee.code} />
            ) : (
              "—"
            );
          },
        },
        {
          title: "Hiện tại → Đề xuất",
          key: "titles",
          render: (_, row) => `${row.currentTitle} → ${row.proposedTitle}`,
        },
        {
          title: "Hiệu lực",
          key: "date",
          render: (_, row) => (row.effectiveDate ? formatDay(row.effectiveDate) : "—"),
        },
        {
          title: "Trạng thái",
          key: "status",
          render: (_, row) => (
            <StatusDot tone={PROPOSAL_STATUS[row.status].tone}>
              {PROPOSAL_STATUS[row.status].label}
            </StatusDot>
          ),
        },
      ]}
    />
  );
}

function History({ employee }: { employee: PreviewEmployee }) {
  const { state } = usePreview();
  const items = [
    ...state.reviews
      .filter((review) => review.employeeId === employee.id)
      .map((review) => ({
        key: review.id,
        time: formatPeriod(review.period),
        content: `Đánh giá tháng ${formatPeriod(review.period)}`,
        result: review.ratings ? overallRating(review.ratings) : "Chưa đánh giá",
        note: review.comment,
      })),
    ...state.proposals
      .filter((proposal) => proposal.employeeId === employee.id && proposal.status !== "draft")
      .map((proposal) => ({
        key: proposal.id,
        time: formatDay(proposal.updatedAt),
        content: `Đề xuất ${proposal.proposedTitle}`,
        result: PROPOSAL_STATUS[proposal.status].label,
        note: proposal.decisionNote,
      })),
  ];
  return (
    <>
      <p className="staff-muted">
        Lịch sử của <strong>{employee.fullName}</strong> ({employee.code})
      </p>
      <Table
        rowKey="key"
        className="staff-table"
        dataSource={items}
        pagination={false}
        scroll={{ x: 560 }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có lịch sử" />,
        }}
        columns={[
          { title: "Thời gian", dataIndex: "time", width: 110 },
          { title: "Nội dung", dataIndex: "content" },
          { title: "Kết quả", dataIndex: "result" },
          { title: "Ghi chú", dataIndex: "note", render: (value: string) => value || "—" },
        ]}
      />
    </>
  );
}
