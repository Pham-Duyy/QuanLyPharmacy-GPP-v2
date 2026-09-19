import { DeleteOutlined, HeartOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Empty, Input, InputNumber, Modal, Select, Skeleton, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { CustomerDetail, CustomerHealthProfile, CustomerInvoiceHistoryItem, Envelope, Paged } from "../../api/types.js";
import { formatVnd } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { GENDER } from "./customer-labels.js";

export function AnonymizeModal({ open, customerId, onClose, onSaved }: { open: boolean; customerId: string | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { message } = App.useApp();
  const [reason, setReason] = useState("");

  const anonymize = useMutation({
    mutationFn: () => http.post(`/customers/${customerId}/anonymize`, { reason }),
    onSuccess: async () => {
      void message.success("Đã ẩn danh hồ sơ khách hàng");
      setReason("");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ẩn danh được khách hàng")),
  });

  return (
    <Modal
      open={open}
      title="Ẩn danh hồ sơ khách hàng"
      okText="Xác nhận ẩn danh"
      cancelText="Hủy"
      onCancel={() => {
        setReason("");
        onClose();
      }}
      onOk={() => anonymize.mutate()}
      confirmLoading={anonymize.isPending}
      okButtonProps={{ danger: true, disabled: reason.trim().length === 0 }}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        title="Thao tác không thể hoàn tác"
        description="Họ tên, số điện thoại và hồ sơ sức khỏe sẽ bị xóa vĩnh viễn, thay bằng mã ẩn danh. Hóa đơn và đơn thuốc đã phát sinh vẫn được giữ lại."
      />
      <Input.TextArea rows={3} placeholder="Lý do ẩn danh (bắt buộc — ví dụ: khách yêu cầu xóa dữ liệu cá nhân)" value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
    </Modal>
  );
}

export function HealthProfilePanel({ customerId, onSaved }: { customerId: string; onSaved: () => Promise<unknown> }) {
  const profile = useQuery({
    queryKey: ["customer-health", customerId],
    queryFn: async () => (await http.get<Envelope<CustomerHealthProfile>>(`/customers/${customerId}/health-profile`)).data.data,
  });
  const [editing, setEditing] = useState(false);

  if (profile.isLoading) return <Skeleton active paragraph={{ rows: 3 }} />;

  return (
    <div className="detail-stack">
      {!profile.data?.hasHealthConsent ? (
        <Alert type="warning" showIcon title="Khách chưa đồng ý lưu hồ sơ sức khỏe" description="Chỉ được ghi dị ứng và bệnh nền sau khi đã hỏi và được khách đồng ý." />
      ) : null}
      <dl className="kv-list">
        <div>
          <dt>Bệnh nền</dt>
          <dd>{profile.data?.chronicConditions ?? "—"}</dd>
        </div>
        <div>
          <dt>Dị ứng hoạt chất</dt>
          <dd>
            {profile.data?.allergies.length
              ? profile.data.allergies.map((allergy) => (
                  <Tag key={allergy.ingredientId} color="red" style={{ marginBottom: 4 }}>
                    {allergy.ingredientName}
                    {allergy.note ? ` — ${allergy.note}` : ""}
                  </Tag>
                ))
              : "Chưa ghi nhận"}
          </dd>
        </div>
        {profile.data?.note ? (
          <div>
            <dt>Ghi chú</dt>
            <dd>{profile.data.note}</dd>
          </div>
        ) : null}
      </dl>
      <Button icon={<HeartOutlined />} onClick={() => setEditing(true)}>
        {profile.data?.hasHealthConsent ? "Sửa hồ sơ sức khỏe" : "Ghi nhận đồng ý và nhập hồ sơ"}
      </Button>
      <HealthProfileFormModal
        open={editing}
        customerId={customerId}
        profile={profile.data ?? null}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await profile.refetch();
          await onSaved();
        }}
      />
    </div>
  );
}

/**
 * Lịch sử mua của khách (contract §11): cần quyền customer.sensitive, server
 * ghi audit mỗi lần mở. `limit` để hiện vài giao dịch gần nhất ở tab Tổng quan.
 */
export function InvoiceHistoryPanel({ customerId, limit, onOpenInvoice }: { customerId: string; limit?: number; onOpenInvoice?: (invoiceId: string) => void }) {
  const history = useQuery({
    queryKey: ["customer-invoices", customerId],
    queryFn: async () => (await http.get<Envelope<CustomerInvoiceHistoryItem[]>>(`/customers/${customerId}/invoices`)).data.data,
  });

  if (history.isLoading) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (history.isError) return <Alert type="error" showIcon title={getErrorMessage(history.error, "Không tải được lịch sử mua")} />;
  const rows = (history.data ?? []).slice(0, limit ?? undefined);
  if (rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Khách chưa mua lần nào" />;

  return (
    <div className="cust-tx">
      <div className="cust-tx-head" aria-hidden>
        <span>Hóa đơn</span>
        <span>Ngày mua</span>
        <span className="col-num">Giá trị</span>
        <span>Trạng thái</span>
      </div>
      {rows.map((row) => (
        <div className="cust-tx-row" key={row.id}>
          {onOpenInvoice ? (
            <button type="button" className="link-button mono" onClick={() => onOpenInvoice(row.id)}>
              {row.code}
            </button>
          ) : (
            <span className="mono">{row.code}</span>
          )}
          <span>
            {formatDateTime(row.soldAt)}
            <small className="muted"> · {row.storeCode}</small>
          </span>
          <strong className="col-num">{formatVnd(row.totalAmount)}</strong>
          <span>{row.status === "VOIDED" ? <span className="status-dot is-red">Đã hủy</span> : <span className="status-dot is-green">Đã thanh toán</span>}</span>
        </div>
      ))}
    </div>
  );
}

export function CustomerFormModal({
  open,
  customer,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Có giá trị thì là sửa; không thì tạo mới. */
  customer: CustomerDetail | null;
  onClose: () => void;
  onSaved: (id: string) => Promise<unknown> | unknown;
}) {
  const { message } = App.useApp();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [birthYear, setBirthYear] = useState<number | null>(null);
  const [gender, setGender] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmail(customer?.email ?? "");
    setAddress(customer?.address ?? "");
    setFullName(customer?.fullName ?? "");
    setPhone(customer?.phone ?? "");
    setBirthYear(customer?.birthYear ?? null);
    setGender(customer?.gender ?? undefined);
    setNote(customer?.note ?? "");
  }, [open, customer]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { fullName: fullName || null, phone: phone || null, birthYear, gender: gender ?? null, note: note || null, email: email.trim() || null, address: address.trim() || null };
      if (customer) {
        const response = await http.patch<Envelope<CustomerDetail>>(`/customers/${customer.id}`, { ...body, version: customer.version });
        return response.data.data.id;
      }
      const response = await http.post<Envelope<CustomerDetail>>("/customers", body);
      return response.data.data.id;
    },
    onSuccess: async (id) => {
      void message.success(customer ? "Đã lưu thông tin khách hàng" : "Đã thêm khách hàng");
      await onSaved(id);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được khách hàng")),
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => save.mutate()}
      okText="Lưu"
      cancelText="Hủy"
      okButtonProps={{ disabled: !fullName.trim() && !phone.trim() }}
      confirmLoading={save.isPending}
      title={customer ? "Sửa thông tin khách hàng" : "Thêm khách hàng"}
    >
      <div className="detail-stack">
        <div className="form-grid">
          <label className="field">
            <span>Họ và tên</span>
            <Input placeholder="Nguyễn Văn A" value={fullName} onChange={(event) => setFullName(event.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>Số điện thoại</span>
            <Input placeholder="09xxxxxxxx" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
          </label>
          <label className="field">
            <span>Năm sinh</span>
            <InputNumber style={{ width: "100%" }} placeholder="1980" min={1900} max={new Date().getFullYear()} value={birthYear} onChange={setBirthYear} />
          </label>
          <label className="field">
            <span>Giới tính</span>
            <Select allowClear placeholder="Không rõ" value={gender} onChange={setGender} options={Object.entries(GENDER).map(([value, label]) => ({ value, label }))} />
          </label>
          <label className="field">
            <span>Email</span>
            <Input type="email" placeholder="ten@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="field">
            <span>Địa chỉ</span>
            <Input placeholder="Phường, quận/huyện, tỉnh/thành" value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Ghi chú chăm sóc</span>
          <Input.TextArea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <Typography.Text type="secondary">Cần ít nhất họ tên hoặc số điện thoại.</Typography.Text>
      </div>
    </Modal>
  );
}

function HealthProfileFormModal({
  open,
  customerId,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  customerId: string;
  profile: CustomerHealthProfile | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { message } = App.useApp();
  const [consent, setConsent] = useState(false);
  const [chronicConditions, setChronicConditions] = useState("");
  const [note, setNote] = useState("");
  const [ingredientSearch, setIngredientSearch] = useState("");
  const [allergies, setAllergies] = useState<Array<{ ingredientId: string; ingredientName: string; note: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setConsent(profile?.hasHealthConsent ?? false);
    setChronicConditions(profile?.chronicConditions ?? "");
    setNote(profile?.note ?? "");
    setAllergies((profile?.allergies ?? []).map((a) => ({ ...a, note: a.note ?? "" })));
  }, [open, profile]);

  const ingredientSearchQuery = useQuery({
    queryKey: ["ingredient-search", ingredientSearch],
    enabled: ingredientSearch.length > 0,
    queryFn: async () => (await http.get<Envelope<Paged<{ id: string; name: string }>>>("/active-ingredients", { params: { search: ingredientSearch, limit: 10 } })).data.data.items,
  });

  const save = useMutation({
    mutationFn: () =>
      http.patch(`/customers/${customerId}/health-profile`, {
        consent: profile?.hasHealthConsent ? undefined : consent || undefined,
        chronicConditions: chronicConditions || null,
        note: note || null,
        allergies: allergies.map((a) => ({ ingredientId: a.ingredientId, note: a.note || null })),
      }),
    onSuccess: async () => {
      void message.success("Đã lưu hồ sơ sức khỏe");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được hồ sơ sức khỏe")),
  });

  const needsConsent = !profile?.hasHealthConsent;

  return (
    <Modal open={open} onCancel={onClose} onOk={() => save.mutate()} okText="Lưu" cancelText="Hủy" okButtonProps={{ disabled: needsConsent && !consent }} confirmLoading={save.isPending} title="Hồ sơ sức khỏe" width={600}>
      <div className="detail-stack">
        {needsConsent ? (
          <div className="consent-box">
            <Checkbox checked={consent} onChange={(event) => setConsent(event.target.checked)}>
              Tôi đã hỏi và khách đồng ý lưu hồ sơ sức khỏe (dị ứng, bệnh nền)
            </Checkbox>
          </div>
        ) : (
          <Alert type="success" showIcon title="Khách đã đồng ý lưu hồ sơ sức khỏe" />
        )}
        <label className="field">
          <span>Bệnh nền</span>
          <Input.TextArea rows={2} placeholder="Ví dụ: tiểu đường, cao huyết áp" value={chronicConditions} onChange={(event) => setChronicConditions(event.target.value)} />
        </label>
        <label className="field">
          <span>Ghi chú khác</span>
          <Input.TextArea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="field">
          <span>Dị ứng theo hoạt chất</span>
          <Select
            showSearch
            placeholder="Tìm hoạt chất để thêm dị ứng"
            filterOption={false}
            searchValue={ingredientSearch}
            onSearch={setIngredientSearch}
            onSelect={(ingredientId: string | null) => {
              if (!ingredientId) return;
              const found = ingredientSearchQuery.data?.find((i) => i.id === ingredientId);
              if (found && !allergies.some((a) => a.ingredientId === ingredientId)) {
                setAllergies((current) => [...current, { ingredientId, ingredientName: found.name, note: "" }]);
              }
              setIngredientSearch("");
            }}
            value={null}
            options={(ingredientSearchQuery.data ?? []).map((i) => ({ value: i.id, label: i.name }))}
          />
          {allergies.map((allergy) => (
            <div key={allergy.ingredientId} className="allergy-row">
              <Tag color="red">{allergy.ingredientName}</Tag>
              <Input
                size="small"
                placeholder="Biểu hiện dị ứng…"
                value={allergy.note}
                onChange={(event) => setAllergies((current) => current.map((a) => (a.ingredientId === allergy.ingredientId ? { ...a, note: event.target.value } : a)))}
              />
              <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Xóa dị ứng ${allergy.ingredientName}`} onClick={() => setAllergies((current) => current.filter((a) => a.ingredientId !== allergy.ingredientId))} />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
