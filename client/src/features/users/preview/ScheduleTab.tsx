import {
  CalendarOutlined,
  ClockCircleOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Table,
  Tabs,
  Tooltip,
} from "antd";
import { useState } from "react";
import { PersonCell, StaffNote, StatusDot } from "../staff-ui.js";
import { PREVIEW_PERIOD, PREVIEW_WEEK_START } from "./preview-fixtures.js";
import { approvedDays, validateShift, type ShiftDraft } from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import type {
  AdjustmentRequest,
  AttendanceFlag,
  AttendanceRecord,
  Shift,
} from "./preview-types.js";
import { employeeOf, formatDay, formatPeriod, storeShort, weekdayOf } from "./preview-format.js";
import { SampleTag, SectionHead } from "./preview-ui.js";

const FLAG_LABEL: Record<AttendanceFlag, string> = {
  late: "Đi muộn",
  early: "Về sớm",
  missing_in: "Thiếu giờ vào",
  missing_out: "Thiếu giờ ra",
};

function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function shiftKind(shift: Shift): "morning" | "afternoon" | "custom" {
  if (shift.start === "07:00" && shift.end === "15:00") return "morning";
  if (shift.start === "14:00" && shift.end === "22:00") return "afternoon";
  return "custom";
}
const KIND_LABEL = { morning: "Sáng", afternoon: "Chiều", custom: "Ca riêng" };

export function ScheduleTab() {
  const { state } = usePreview();
  const pending = state.adjustments.filter((item) => item.status === "pending").length;
  return (
    <Tabs
      className="staff-subtabs"
      items={[
        { key: "roster", label: "Lịch làm", children: <Roster /> },
        { key: "attendance", label: "Bảng công", children: <Attendance /> },
        {
          key: "requests",
          label: (
            <span>
              Yêu cầu điều chỉnh{" "}
              <Badge count={pending} size="small" aria-label={`${pending} yêu cầu chờ xem xét`} />
            </span>
          ),
          children: <Requests />,
        },
      ]}
    />
  );
}

function Roster() {
  const { state, dispatch } = usePreview();
  const { message } = App.useApp();
  const [storeId, setStoreId] = useState(state.stores[0]!.id);
  const [editing, setEditing] = useState<ShiftDraft | null>(null);
  const [selected, setSelected] = useState<Shift | null>(null);
  const days = weekDays(PREVIEW_WEEK_START);
  const week = state.weeks.find(
    (item) => item.storeId === storeId && item.weekStart === PREVIEW_WEEK_START,
  );
  const people = state.employees.filter((employee) => employee.storeId === storeId);
  const currentSelected = selected
    ? (state.shifts.find((shift) => shift.id === selected.id) ?? null)
    : null;

  const status =
    !week || week.status === "draft" ? (
      week?.changedAfterPublish ? (
        <StatusDot tone="orange">Có thay đổi chưa công bố lại</StatusDot>
      ) : (
        <StatusDot tone="orange">Bản nháp chưa công bố</StatusDot>
      )
    ) : (
      <StatusDot tone="green">Đã công bố</StatusDot>
    );

  return (
    <div className="staff-split">
      <Card className="staff-card">
        <SectionHead
          title="Lịch làm tuần"
          description={
            <span className="staff-week-nav">
              <Tooltip title="Bản xem trước chỉ có một tuần mẫu">
                <Button size="small" icon={<LeftOutlined />} disabled aria-label="Tuần trước" />
              </Tooltip>
              <CalendarOutlined aria-hidden /> {formatDay(days[0]!)} – {formatDay(days[6]!)}
              <Tooltip title="Bản xem trước chỉ có một tuần mẫu">
                <Button size="small" icon={<RightOutlined />} disabled aria-label="Tuần sau" />
              </Tooltip>
            </span>
          }
          extra={
            <>
              <Select
                aria-label="Cửa hàng"
                value={storeId}
                onChange={(value) => {
                  setStoreId(value);
                  setSelected(null);
                }}
                options={state.stores.map((store) => ({ value: store.id, label: store.name }))}
              />
              <Button
                icon={<PlusOutlined />}
                onClick={() =>
                  setEditing({
                    employeeId: people.find((person) => person.workStatus !== "on_leave")?.id ?? "",
                    storeId,
                    date: days[0]!,
                    start: "07:00",
                    end: "15:00",
                    note: "",
                  })
                }
              >
                Xếp ca
              </Button>
              <Button
                type="primary"
                disabled={week?.status === "published"}
                onClick={() => {
                  dispatch({ type: "publishWeek", storeId, weekStart: PREVIEW_WEEK_START });
                  void message.success(
                    "Đã công bố lịch mẫu. Nhân viên thấy ca của mình trong Góc nhìn nhân viên.",
                  );
                }}
              >
                Công bố lịch
              </Button>
            </>
          }
        />
        <div className="staff-roster" role="region" aria-label="Bảng lịch làm tuần" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Nhân viên</th>
                <th scope="col">Chức danh</th>
                {days.map((day) => (
                  <th scope="col" key={day}>
                    {weekdayOf(day)}
                    <small>{formatDay(day).slice(0, 5)}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <th scope="row">
                    <PersonCell name={person.fullName} id={person.id} />
                  </th>
                  <td className="staff-roster-title">{person.title}</td>
                  {days.map((day) => {
                    const cell = state.shifts.filter(
                      (shift) =>
                        shift.employeeId === person.id &&
                        shift.storeId === storeId &&
                        shift.date === day,
                    );
                    if (person.workStatus === "on_leave")
                      return (
                        <td key={day}>
                          <span className="staff-shift off">Tạm nghỉ</span>
                        </td>
                      );
                    return (
                      <td key={day}>
                        {cell.length ? (
                          cell.map((shift) => (
                            <button
                              key={shift.id}
                              type="button"
                              className={`staff-shift ${shiftKind(shift)}${currentSelected?.id === shift.id ? " selected" : ""}`}
                              onClick={() => setSelected(shift)}
                              aria-label={`${person.fullName}, ${weekdayOf(day)} ${formatDay(day)}: ${shift.start} đến ${shift.end}`}
                            >
                              <strong>{KIND_LABEL[shiftKind(shift)]}</strong>
                              <small>
                                {shift.start} – {shift.end}
                              </small>
                            </button>
                          ))
                        ) : (
                          <button
                            type="button"
                            className="staff-shift off"
                            onClick={() =>
                              setEditing({
                                employeeId: person.id,
                                storeId,
                                date: day,
                                start: "07:00",
                                end: "15:00",
                                note: "",
                              })
                            }
                            aria-label={`${person.fullName}, ${weekdayOf(day)} ${formatDay(day)}: nghỉ, bấm để xếp ca`}
                          >
                            Nghỉ
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="staff-roster-legend">
          <span className="legend morning">Ca sáng (07:00 – 15:00)</span>
          <span className="legend afternoon">Ca chiều (14:00 – 22:00)</span>
          <span className="legend off">Nghỉ</span>
          <span className="staff-roster-status">{status}</span>
        </div>
        <StaffNote>
          Lịch dự kiến và công thực tế được theo dõi riêng: ca đã xếp không tự thành công.
        </StaffNote>
      </Card>

      <Card className="staff-card staff-aside" title="Chi tiết ca">
        {currentSelected ? (
          <ShiftDetail
            shift={currentSelected}
            onEdit={() => setEditing(currentSelected)}
            onDelete={() => {
              dispatch({ type: "deleteShift", id: currentSelected.id });
              setSelected(null);
            }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Chọn một ca trên bảng để xem chi tiết, hoặc bấm ô Nghỉ để xếp ca."
          />
        )}
      </Card>

      <ShiftModal draft={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ShiftDetail({
  shift,
  onEdit,
  onDelete,
}: {
  shift: Shift;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { state } = usePreview();
  const employee = employeeOf(state, shift.employeeId);
  const week = state.weeks.find(
    (item) => item.storeId === shift.storeId && item.weekStart === PREVIEW_WEEK_START,
  );
  return (
    <div className="staff-shift-detail">
      {employee ? (
        <PersonCell
          name={employee.fullName}
          id={employee.id}
          sub={`${weekdayOf(shift.date)}, ${formatDay(shift.date)}`}
        />
      ) : null}
      <dl className="staff-pairs">
        <div>
          <dt>Cửa hàng</dt>
          <dd>{storeShort(state, shift.storeId)}</dd>
        </div>
        <div>
          <dt>Giờ bắt đầu</dt>
          <dd>{shift.start}</dd>
        </div>
        <div>
          <dt>Giờ kết thúc</dt>
          <dd>{shift.end}</dd>
        </div>
        <div>
          <dt>Trạng thái</dt>
          <dd>
            {week?.status === "published" ? (
              <StatusDot tone="green">Đã công bố</StatusDot>
            ) : (
              <StatusDot tone="orange">Nháp</StatusDot>
            )}
          </dd>
        </div>
        {shift.note ? (
          <div>
            <dt>Ghi chú</dt>
            <dd>{shift.note}</dd>
          </div>
        ) : null}
      </dl>
      <div className="staff-inline-actions">
        <Button onClick={onEdit}>Sửa ca</Button>
        <Button danger onClick={onDelete}>
          Xóa ca
        </Button>
      </div>
    </div>
  );
}

function ShiftModal({ draft, onClose }: { draft: ShiftDraft | null; onClose: () => void }) {
  const { state, dispatch } = usePreview();
  const [form, setForm] = useState<ShiftDraft | null>(null);
  const [touched, setTouched] = useState(false);
  const value = form ?? draft;
  const error = value ? validateShift(state, value) : null;
  const days = weekDays(PREVIEW_WEEK_START);

  const close = () => {
    setForm(null);
    setTouched(false);
    onClose();
  };
  const patch = (next: Partial<ShiftDraft>) => setForm({ ...(value as ShiftDraft), ...next });

  return (
    <Modal
      open={draft !== null}
      title={value?.id ? "Sửa ca làm (mẫu)" : "Xếp ca (mẫu)"}
      okText="Lưu ca"
      cancelText="Hủy"
      onCancel={close}
      onOk={() => {
        setTouched(true);
        if (!value || error) return;
        dispatch({ type: "saveShift", shift: { ...value, id: value.id ?? crypto.randomUUID() } });
        close();
      }}
      destroyOnHidden
    >
      {value ? (
        <div className="staff-form-grid">
          <label className="staff-field">
            <span>Nhân viên</span>
            <Select
              value={value.employeeId || undefined}
              placeholder="Chọn nhân viên"
              onChange={(employeeId) => patch({ employeeId })}
              options={state.employees.map((employee) => ({
                value: employee.id,
                label: `${employee.fullName} (${employee.code})`,
              }))}
            />
          </label>
          <label className="staff-field">
            <span>Cửa hàng</span>
            <Select
              value={value.storeId}
              onChange={(storeId) => patch({ storeId })}
              options={state.stores.map((store) => ({ value: store.id, label: store.name }))}
            />
          </label>
          <label className="staff-field">
            <span>Ngày</span>
            <Select
              value={value.date}
              onChange={(date) => patch({ date })}
              options={days.map((day) => ({
                value: day,
                label: `${weekdayOf(day)}, ${formatDay(day)}`,
              }))}
            />
          </label>
          <div className="staff-two">
            <label className="staff-field">
              <span>Giờ bắt đầu</span>
              <Input
                type="time"
                value={value.start}
                onChange={(event) => patch({ start: event.target.value })}
                status={touched && error ? "error" : undefined}
              />
            </label>
            <label className="staff-field">
              <span>Giờ kết thúc</span>
              <Input
                type="time"
                value={value.end}
                onChange={(event) => patch({ end: event.target.value })}
                status={touched && error ? "error" : undefined}
              />
            </label>
          </div>
          {error && (touched || value.start >= value.end) ? (
            <div className="staff-field-error" role="alert">
              {error}
            </div>
          ) : null}
          <label className="staff-field">
            <span>Ghi chú</span>
            <Input.TextArea
              rows={2}
              maxLength={200}
              value={value.note}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </label>
          <Alert
            type="info"
            showIcon
            title="Lưu ca vào lịch nháp. Nhân viên chỉ thấy sau khi công bố lịch."
          />
        </div>
      ) : null}
    </Modal>
  );
}

function Attendance() {
  const { state } = usePreview();
  const records = [...state.attendance].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="staff-stack">
      <Card className="staff-card">
        <SectionHead
          title={`Công đã duyệt kỳ ${formatPeriod(PREVIEW_PERIOD)}`}
          description="Chỉ tính bản ghi chấm công được duyệt; ca dự kiến không được tính."
          extra={<SampleTag />}
        />
        <Table
          rowKey="id"
          className="staff-table"
          pagination={false}
          scroll={{ x: 520 }}
          dataSource={state.employees.filter(
            (employee) =>
              employee.workStatus !== "on_leave" ||
              approvedDays(state, employee.id, PREVIEW_PERIOD) > 0,
          )}
          columns={[
            {
              title: "Nhân viên",
              key: "person",
              render: (_, row) => <PersonCell name={row.fullName} id={row.id} sub={row.code} />,
            },
            { title: "Cửa hàng", key: "store", render: (_, row) => storeShort(state, row.storeId) },
            {
              title: "Công đã duyệt",
              key: "days",
              align: "right",
              render: (_, row) => `${approvedDays(state, row.id, PREVIEW_PERIOD)} công`,
            },
            {
              title: "Chờ xử lý",
              key: "pending",
              render: (_, row) => {
                const open = state.attendance.filter(
                  (record) => record.employeeId === row.id && !record.approved,
                ).length;
                return open ? (
                  <StatusDot tone="orange">{open} ngày chưa duyệt</StatusDot>
                ) : (
                  <StatusDot tone="green">Đủ</StatusDot>
                );
              },
            },
          ]}
        />
      </Card>
      <Card className="staff-card">
        <SectionHead
          title="Chấm công thực tế"
          description="Giờ vào/ra từ máy chấm công (mẫu) và các bất thường."
        />
        <Table<AttendanceRecord>
          rowKey="id"
          className="staff-table"
          pagination={false}
          scroll={{ x: 760 }}
          dataSource={records}
          columns={[
            {
              title: "Nhân viên",
              key: "person",
              render: (_, row) => {
                const employee = employeeOf(state, row.employeeId);
                return employee ? <PersonCell name={employee.fullName} id={employee.id} /> : "—";
              },
            },
            { title: "Ngày", key: "date", render: (_, row) => formatDay(row.date) },
            {
              title: "Giờ vào",
              key: "in",
              render: (_, row) => row.checkIn ?? <span className="staff-muted">—</span>,
            },
            {
              title: "Giờ ra",
              key: "out",
              render: (_, row) => row.checkOut ?? <span className="staff-muted">—</span>,
            },
            {
              title: "Ghi nhận",
              key: "flags",
              render: (_, row) =>
                row.flags.length ? (
                  row.flags.map((flag) => (
                    <StatusDot key={flag} tone={flag.startsWith("missing") ? "red" : "orange"}>
                      {FLAG_LABEL[flag]}
                    </StatusDot>
                  ))
                ) : (
                  <StatusDot tone="green">Đúng giờ</StatusDot>
                ),
            },
            {
              title: "Công",
              key: "approved",
              render: (_, row) =>
                row.approved ? (
                  <StatusDot tone="green">Đã duyệt</StatusDot>
                ) : (
                  <StatusDot tone="orange">Chưa duyệt</StatusDot>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

function Requests() {
  const { state, dispatch } = usePreview();
  const { message } = App.useApp();
  const [reviewing, setReviewing] = useState<AdjustmentRequest | null>(null);
  const [note, setNote] = useState("");
  const [triedReject, setTriedReject] = useState(false);
  const record = reviewing ? state.attendance.find((item) => item.id === reviewing.recordId) : null;
  const close = () => {
    setReviewing(null);
    setNote("");
    setTriedReject(false);
  };
  const STATUS = {
    pending: <StatusDot tone="orange">Chờ xem xét</StatusDot>,
    approved: <StatusDot tone="green">Đã duyệt</StatusDot>,
    rejected: <StatusDot tone="red">Từ chối</StatusDot>,
  };

  return (
    <Card className="staff-card">
      <SectionHead
        title="Yêu cầu điều chỉnh công"
        description="Duyệt yêu cầu thì bản ghi chấm công được sửa và tính công; từ chối phải ghi lý do."
        extra={<SampleTag />}
      />
      <Table<AdjustmentRequest>
        rowKey="id"
        className="staff-table"
        pagination={false}
        scroll={{ x: 760 }}
        dataSource={state.adjustments}
        locale={{
          emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có yêu cầu nào" />
          ),
        }}
        columns={[
          {
            title: "Nhân viên",
            key: "person",
            render: (_, row) => {
              const employee = employeeOf(state, row.employeeId);
              return employee ? <PersonCell name={employee.fullName} id={employee.id} /> : "—";
            },
          },
          { title: "Ngày", key: "date", render: (_, row) => formatDay(row.date) },
          { title: "Nội dung yêu cầu", dataIndex: "content" },
          { title: "Trạng thái", key: "status", render: (_, row) => STATUS[row.status] },
          {
            title: "Thao tác",
            key: "action",
            render: (_, row) =>
              row.status === "pending" ? (
                <Button size="small" onClick={() => setReviewing(row)}>
                  Xem xét
                </Button>
              ) : (
                <span className="staff-muted">{row.reviewNote || "—"}</span>
              ),
          },
        ]}
      />
      <Modal
        open={reviewing !== null}
        title="Xem xét yêu cầu điều chỉnh"
        onCancel={close}
        footer={[
          <Button key="cancel" onClick={close}>
            Hủy
          </Button>,
          <Button
            key="reject"
            danger
            onClick={() => {
              setTriedReject(true);
              if (!note.trim() || !reviewing) return;
              dispatch({ type: "reviewAdjustment", id: reviewing.id, decision: "rejected", note });
              void message.info("Đã từ chối yêu cầu (mẫu).");
              close();
            }}
          >
            Từ chối
          </Button>,
          <Button
            key="approve"
            type="primary"
            onClick={() => {
              if (!reviewing) return;
              dispatch({ type: "reviewAdjustment", id: reviewing.id, decision: "approved", note });
              void message.success("Đã duyệt yêu cầu; bản ghi chấm công được tính công (mẫu).");
              close();
            }}
          >
            Duyệt
          </Button>,
        ]}
      >
        {reviewing && record ? (
          <div className="staff-form-grid">
            <dl className="staff-pairs">
              <div>
                <dt>Nhân viên</dt>
                <dd>{employeeOf(state, reviewing.employeeId)?.fullName}</dd>
              </div>
              <div>
                <dt>Ngày</dt>
                <dd>{formatDay(reviewing.date)}</dd>
              </div>
              <div>
                <dt>Đang ghi nhận</dt>
                <dd>
                  Vào {record.checkIn ?? "—"} · Ra {record.checkOut ?? "—"}
                </dd>
              </div>
              <div>
                <dt>Đề nghị sửa</dt>
                <dd>
                  {reviewing.requestedCheckIn ? `Vào ${reviewing.requestedCheckIn}` : null}
                  {reviewing.requestedCheckIn && reviewing.requestedCheckOut ? " · " : null}
                  {reviewing.requestedCheckOut ? `Ra ${reviewing.requestedCheckOut}` : null}
                </dd>
              </div>
            </dl>
            <p>{reviewing.content}</p>
            <label className="staff-field">
              <span>
                <ClockCircleOutlined aria-hidden /> Ghi chú xem xét{" "}
                {triedReject ? (
                  <span className="staff-required">* bắt buộc khi từ chối</span>
                ) : null}
              </span>
              <Input.TextArea
                rows={3}
                maxLength={300}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                status={triedReject && !note.trim() ? "error" : undefined}
              />
            </label>
            {triedReject && !note.trim() ? (
              <div className="staff-field-error" role="alert">
                Ghi lý do từ chối để nhân viên biết cần làm gì.
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
