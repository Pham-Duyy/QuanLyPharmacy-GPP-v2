import {
  ArrowRightOutlined,
  CalendarOutlined,
  CloseOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileTextOutlined,
  LockOutlined,
  MoreOutlined,
  PlusOutlined,
  RiseOutlined,
  ShoppingCartOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Dropdown, Input, Result, Skeleton, Tabs, Tooltip } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { CustomerDetail, Envelope } from "../../api/types.js";
import { formatDate, formatDateTime } from "../../ui/format.js";
import { useAuth } from "../auth/AuthProvider.js";
import { AnonymizeModal, CustomerFormModal, HealthProfilePanel, InvoiceHistoryPanel } from "./customer-forms.js";
import { GENDER, SEGMENT, avatarTone, initials, money } from "./customer-labels.js";

type Tab = "overview" | "history" | "health" | "note";

function maskPhone(phone: string | null): string | null {
  if (!phone || phone.length < 7) return phone;
  return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
}

/** Hồ sơ một khách: thông tin liên hệ, tổng hợp mua, giao dịch gần đây, ghi chú chăm sóc. */
export function CustomerDetailPanel({ customerId, onClose, onChanged }: { customerId: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  const [phoneShown, setPhoneShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anonymizing, setAnonymizing] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["customer", customerId],
    queryFn: async () => (await http.get<Envelope<CustomerDetail>>(`/customers/${customerId}`)).data.data,
  });
  const detail = detailQuery.data;
  const canSensitive = can("customer.sensitive");
  const canManage = can("customer.manage");

  async function refresh() {
    await detailQuery.refetch();
    await onChanged();
  }

  const saveNote = useMutation({
    mutationFn: async (note: string) => http.patch(`/customers/${customerId}`, { note: note.trim() || null, version: detail!.version }),
    onSuccess: async () => {
      void message.success("Đã lưu ghi chú chăm sóc");
      setNoteDraft(null);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được ghi chú")),
  });

  const head = (
    <div className="cust-panel-close">
      <Button type="text" icon={<CloseOutlined />} aria-label="Đóng hồ sơ khách hàng" onClick={onClose} />
    </div>
  );

  if (detailQuery.isError) {
    return (
      <section className="cust-panel">
        {head}
        <Result status="warning" title="Không tải được hồ sơ khách" subTitle={getErrorMessage(detailQuery.error, "Thử lại sau.")} extra={<Button onClick={() => void detailQuery.refetch()}>Thử lại</Button>} />
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="cust-panel" aria-busy="true">
        {head}
        <Skeleton avatar active paragraph={{ rows: 8 }} />
      </section>
    );
  }

  const segment = SEGMENT[detail.stats.segment];
  const average = detail.stats.orderCount > 0 ? Math.round(detail.stats.totalSpent / detail.stats.orderCount) : null;
  const missing = <span className="muted">Chưa cập nhật</span>;
  const phoneValue = detail.phone ? (
    <span className="cust-phone">
      <span className="mono">{phoneShown ? detail.phone : maskPhone(detail.phone)}</span>
      <Tooltip title={phoneShown ? "Che số điện thoại" : "Hiện đầy đủ"}>
        <Button type="text" size="small" icon={phoneShown ? <EyeInvisibleOutlined /> : <EyeOutlined />} aria-label={phoneShown ? "Che số điện thoại" : "Hiện đầy đủ số điện thoại"} onClick={() => setPhoneShown((value) => !value)} />
      </Tooltip>
    </span>
  ) : (
    missing
  );
  const facts: Array<{ label: string; value: ReactNode }> = [
    { label: "Điện thoại", value: phoneValue },
    { label: "Năm sinh", value: detail.birthYear ?? missing },
    { label: "Giới tính", value: detail.gender ? GENDER[detail.gender] : missing },
    { label: "Email", value: detail.email ?? missing },
    { label: "Địa chỉ", value: detail.address ?? missing },
    { label: "Ngày tạo", value: formatDate(detail.createdAt) },
  ];

  const noteEditor = (
    <div className="cust-note-edit">
      <Input.TextArea
        autoSize={{ minRows: 3, maxRows: 6 }}
        maxLength={1000}
        showCount
        value={noteDraft ?? detail.note ?? ""}
        placeholder="VD: Ưu tiên liên hệ qua điện thoại; hay mua thuốc huyết áp đầu tháng"
        onChange={(event) => setNoteDraft(event.target.value)}
        aria-label="Ghi chú chăm sóc"
      />
      <div className="cust-note-actions">
        <Button disabled={noteDraft === null} onClick={() => setNoteDraft(null)}>
          Hủy
        </Button>
        <Button type="primary" loading={saveNote.isPending} disabled={noteDraft === null} onClick={() => saveNote.mutate(noteDraft ?? "")}>
          Lưu ghi chú
        </Button>
      </div>
    </div>
  );

  const overview = (
    <div className="cust-overview">
      <section>
        <h4>Thông tin khách hàng</h4>
        <dl className="cust-facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="cust-metrics">
        <div className="cust-metric tone-blue">
          <ShoppingCartOutlined aria-hidden />
          <span>Tổng mua</span>
          <strong>{money(detail.stats.totalSpent)}</strong>
        </div>
        <div className="cust-metric tone-purple">
          <FileTextOutlined aria-hidden />
          <span>Số đơn</span>
          <strong>{detail.stats.orderCount}</strong>
        </div>
        <div className="cust-metric tone-orange">
          <RiseOutlined aria-hidden />
          <span>Trung bình / đơn</span>
          <strong>{average === null ? "—" : money(average)}</strong>
        </div>
        <div className="cust-metric tone-green">
          <CalendarOutlined aria-hidden />
          <span>Lần mua cuối</span>
          <strong>{detail.stats.lastPurchaseAt ? formatDate(detail.stats.lastPurchaseAt) : "Chưa mua"}</strong>
        </div>
      </div>

      <section>
        <div className="cust-section-head">
          <h4>Giao dịch gần đây</h4>
          {canSensitive ? (
            <Button type="link" size="small" onClick={() => setTab("history")}>
              Xem tất cả <ArrowRightOutlined />
            </Button>
          ) : null}
        </div>
        {canSensitive ? (
          <InvoiceHistoryPanel customerId={customerId} limit={3} onOpenInvoice={(id) => void navigate(`/hoa-don?id=${id}`)} />
        ) : (
          <p className="cust-locked">
            <LockOutlined /> Vai trò hiện tại chỉ xem được số liệu tổng hợp, không xem chi tiết từng lần mua.
          </p>
        )}
      </section>

      <section>
        <div className="cust-section-head">
          <h4>Ghi chú chăm sóc</h4>
          {canManage && noteDraft === null ? (
            <Button type="link" size="small" onClick={() => setTab("note")}>
              {detail.note ? "Sửa ghi chú" : "Thêm ghi chú"}
            </Button>
          ) : null}
        </div>
        {detail.note ? (
          <div className="cust-note">
            <span>{detail.note}</span>
            <small>Cập nhật hồ sơ: {formatDateTime(detail.updatedAt)}</small>
          </div>
        ) : (
          <p className="muted cust-note-empty">Chưa có ghi chú chăm sóc.</p>
        )}
      </section>
    </div>
  );

  return (
    <section className="cust-panel" aria-label={`Hồ sơ ${detail.fullName ?? detail.code}`}>
      <header className="cust-panel-head">
        <span className={`cust-avatar lg tone-${avatarTone(detail.code)}`} aria-hidden>
          {initials(detail.fullName)}
        </span>
        <div className="cust-panel-title">
          <h2>{detail.fullName ?? "Khách chưa có tên"}</h2>
          <div>
            <span className="mono muted">{detail.code}</span>
            <span className={`class-badge tone-${segment.tone}`}>{segment.label}</span>
            {detail.hasHealthConsent ? <span className="class-badge tone-purple">Có hồ sơ SK</span> : null}
          </div>
        </div>
        <div className="cust-panel-actions">
          {canManage && !detail.isAnonymized ? (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Chỉnh sửa
            </Button>
          ) : null}
          {canSensitive && !detail.isAnonymized ? (
            <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: [{ key: "anonymize", danger: true, icon: <EyeInvisibleOutlined />, label: "Ẩn danh hồ sơ" }], onClick: () => setAnonymizing(true) }}>
              <Button icon={<MoreOutlined />} aria-label="Thao tác khác" />
            </Dropdown>
          ) : null}
          <Button type="text" icon={<CloseOutlined />} aria-label="Đóng hồ sơ khách hàng" onClick={onClose} />
        </div>
      </header>

      {detail.isAnonymized ? <Alert type="warning" showIcon title="Khách hàng này đã được ẩn danh" description="Họ tên, liên hệ và hồ sơ sức khỏe đã bị xóa theo yêu cầu. Chứng từ đã phát sinh vẫn giữ nguyên." /> : null}

      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as Tab)}
        items={[
          { key: "overview", label: "Tổng quan", children: overview },
          {
            key: "history",
            label: "Lịch sử mua",
            children: canSensitive ? <InvoiceHistoryPanel customerId={customerId} onOpenInvoice={(id) => void navigate(`/hoa-don?id=${id}`)} /> : <p className="cust-locked"><LockOutlined /> Cần quyền xem dữ liệu nhạy cảm của khách.</p>,
          },
          {
            key: "health",
            label: "Hồ sơ sức khỏe",
            children: canSensitive ? <HealthProfilePanel customerId={customerId} onSaved={refresh} /> : <p className="cust-locked"><LockOutlined /> Cần quyền xem dữ liệu nhạy cảm của khách.</p>,
          },
          {
            key: "note",
            label: "Ghi chú",
            children: canManage && !detail.isAnonymized ? noteEditor : detail.note ? <div className="cust-note"><span>{detail.note}</span></div> : <p className="muted">Chưa có ghi chú chăm sóc.</p>,
          },
        ]}
      />

      <div className="cust-panel-footer">
        {can("invoice.create") && !detail.isAnonymized ? (
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => void navigate(`/ban-hang?khach=${customerId}`)}>
            Tạo đơn bán cho khách
          </Button>
        ) : null}
        {canSensitive ? (
          <Button size="large" icon={<UnorderedListOutlined />} onClick={() => setTab("history")}>
            Xem lịch sử mua hàng
          </Button>
        ) : null}
      </div>

      <CustomerFormModal
        open={editing}
        customer={detail}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await refresh();
        }}
      />
      <AnonymizeModal
        open={anonymizing}
        customerId={customerId}
        onClose={() => setAnonymizing(false)}
        onSaved={async () => {
          setAnonymizing(false);
          await refresh();
        }}
      />
    </section>
  );
}
