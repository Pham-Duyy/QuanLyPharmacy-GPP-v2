import { DeleteOutlined, EditOutlined, EyeInvisibleOutlined, HeartOutlined, PlusOutlined, SearchOutlined, TeamOutlined, UserOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Checkbox, Empty, Input, InputNumber, Modal, Select, Skeleton, Table, Tabs, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { CustomerDetail, CustomerHealthProfile, CustomerInvoiceHistoryItem, CustomerSearchItem, Envelope, Paged } from "../../api/types.js";
import { formatVnd } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

const GENDER: Record<string, string> = { MALE: "Nam", FEMALE: "Nữ", OTHER: "Khác" };

/** Màn hình khách hàng: tìm/tạo/sửa thông tin cơ bản, hồ sơ sức khỏe, lịch sử mua (contract §11). */
export function CustomersPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get("id");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const term = useDebounced(search.trim(), 300);

  const list = useQuery({
    queryKey: ["customers", term],
    enabled: term.length >= 3,
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerSearchItem[]>>("/customers", { params: { search: term } });
      return response.data.data;
    },
  });

  return (
    <div>
      <PageHeader
        icon={<TeamOutlined />}
        title="Khách hàng"
        description="Tìm khách theo tên hoặc số điện thoại. Hồ sơ sức khỏe chỉ lưu khi khách đồng ý."
        extra={
          can("customer.manage") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Thêm khách hàng
            </Button>
          ) : null
        }
      />

      <div className="split-layout">
        <Card>
          <Input
            size="large"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Gõ ít nhất 3 ký tự — tên hoặc số điện thoại"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ marginBottom: 14 }}
          />
          {term.length < 3 ? (
            <PanelEmpty
              icon={<SearchOutlined />}
              title="Tìm khách hàng để bắt đầu"
              description="Danh sách không hiển thị sẵn để bảo vệ thông tin cá nhân của khách. Số điện thoại được che bớt ở kết quả tìm kiếm."
            />
          ) : (
            <Table
              rowKey="id"
              loading={list.isFetching}
              dataSource={list.data ?? []}
              pagination={false}
              onRow={(row) => ({ onClick: () => setParams({ id: row.id }), style: { cursor: "pointer" } })}
              rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không tìm thấy khách hàng nào" /> }}
              columns={[
                {
                  title: "Khách hàng",
                  key: "name",
                  render: (_: unknown, row: CustomerSearchItem) => (
                    <div className="person-cell">
                      <span className="person-avatar">
                        <UserOutlined />
                      </span>
                      <strong>{row.fullName ?? "Khách chưa có tên"}</strong>
                    </div>
                  ),
                },
                { title: "Điện thoại", key: "phone", width: 160, render: (_: unknown, row: CustomerSearchItem) => <span className="mono">{row.phone ?? "—"}</span> },
              ]}
            />
          )}
        </Card>

        <aside className="split-aside">
          <CustomerPanel
            customerId={openId}
            onClose={() => setParams({})}
            onSaved={async () => {
              await queryClient.invalidateQueries({ queryKey: ["customer", openId] });
              await queryClient.invalidateQueries({ queryKey: ["customers"] });
            }}
          />
        </aside>
      </div>

      <CustomerFormModal
        open={creating}
        customer={null}
        onClose={() => setCreating(false)}
        onSaved={async (id) => {
          setCreating(false);
          await queryClient.invalidateQueries({ queryKey: ["customers"] });
          setParams({ id });
        }}
      />
    </div>
  );
}

function CustomerPanel({ customerId, onClose, onSaved }: { customerId: string | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [anonymizing, setAnonymizing] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["customer", customerId],
    enabled: customerId !== null,
    queryFn: async () => (await http.get<Envelope<CustomerDetail>>(`/customers/${customerId}`)).data.data,
  });
  const detail = detailQuery.data;

  if (customerId === null) {
    return (
      <Card title="Hồ sơ khách hàng">
        <PanelEmpty icon={<UserOutlined />} title="Chưa chọn khách hàng" description="Chọn một khách trong kết quả tìm kiếm để xem hồ sơ và lịch sử mua." />
      </Card>
    );
  }

  return (
    <Card
      title="Hồ sơ khách hàng"
      extra={
        <Button type="text" size="small" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      {detailQuery.isLoading || !detail ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <div className="detail-stack">
          <div className="person-head">
            <span className="person-avatar lg">
              <UserOutlined />
            </span>
            <div>
              <h3 className="detail-title">{detail.fullName ?? "Khách chưa có tên"}</h3>
              <span className="detail-sub mono">{detail.phone ?? "Không có số điện thoại"}</span>
            </div>
          </div>

          {detail.isAnonymized ? (
            <Alert
              type="warning"
              showIcon
              title="Khách hàng này đã được ẩn danh"
              description="Họ tên, số điện thoại và hồ sơ sức khỏe đã bị xóa theo yêu cầu của khách. Chứng từ đã phát sinh vẫn giữ nguyên."
            />
          ) : null}

          <dl className="kv-list">
            <div>
              <dt>Năm sinh</dt>
              <dd>{detail.birthYear ?? "—"}</dd>
            </div>
            <div>
              <dt>Giới tính</dt>
              <dd>{detail.gender ? GENDER[detail.gender] : "—"}</dd>
            </div>
            <div>
              <dt>Ghi chú</dt>
              <dd>{detail.note ?? "—"}</dd>
            </div>
          </dl>

          {!detail.isAnonymized && (can("customer.manage") || can("customer.sensitive")) ? (
            <div className="panel-actions-row">
              {can("customer.manage") ? (
                <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                  Sửa thông tin
                </Button>
              ) : null}
              {can("customer.sensitive") ? (
                <Button danger icon={<EyeInvisibleOutlined />} onClick={() => setAnonymizing(true)}>
                  Ẩn danh
                </Button>
              ) : null}
            </div>
          ) : null}

          {can("customer.sensitive") ? (
            <Tabs
              items={[
                { key: "health", label: "Hồ sơ sức khỏe", children: <HealthProfilePanel customerId={customerId} onSaved={onSaved} /> },
                { key: "invoices", label: "Lịch sử mua", children: <InvoiceHistoryPanel customerId={customerId} /> },
              ]}
            />
          ) : (
            <Alert type="info" showIcon title="Vai trò hiện tại không được xem hồ sơ sức khỏe và lịch sử mua của khách." />
          )}
        </div>
      )}

      <CustomerFormModal
        open={editing}
        customer={detail ?? null}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await onSaved();
        }}
      />
      <AnonymizeModal
        open={anonymizing}
        customerId={customerId}
        onClose={() => setAnonymizing(false)}
        onSaved={async () => {
          setAnonymizing(false);
          await onSaved();
        }}
      />
    </Card>
  );
}

function AnonymizeModal({ open, customerId, onClose, onSaved }: { open: boolean; customerId: string | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
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

function HealthProfilePanel({ customerId, onSaved }: { customerId: string; onSaved: () => Promise<unknown> }) {
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

function InvoiceHistoryPanel({ customerId }: { customerId: string }) {
  const history = useQuery({
    queryKey: ["customer-invoices", customerId],
    queryFn: async () => (await http.get<Envelope<CustomerInvoiceHistoryItem[]>>(`/customers/${customerId}/invoices`)).data.data,
  });

  if (history.isLoading) return <Skeleton active paragraph={{ rows: 3 }} />;
  if ((history.data ?? []).length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Khách chưa mua lần nào" />;

  return (
    <div className="mini-list">
      {history.data!.map((row) => (
        <div className="mini-list-item" key={row.id}>
          <div className="cell-main">
            <strong className="mono">{row.code}</strong>
            <span>
              {formatDateTime(row.soldAt)} · {row.storeCode} · {row.lineCount} dòng
            </span>
          </div>
          <div className="cell-main cell-right">
            <strong>{formatVnd(row.totalAmount)}</strong>
            {row.status === "VOIDED" ? <Tag color="red">Đã hủy</Tag> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function CustomerFormModal({
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

  useEffect(() => {
    if (!open) return;
    setFullName(customer?.fullName ?? "");
    setPhone(customer?.phone ?? "");
    setBirthYear(customer?.birthYear ?? null);
    setGender(customer?.gender ?? undefined);
    setNote(customer?.note ?? "");
  }, [open, customer]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { fullName: fullName || null, phone: phone || null, birthYear, gender: gender ?? null, note: note || null };
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
        </div>
        <label className="field">
          <span>Ghi chú</span>
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
