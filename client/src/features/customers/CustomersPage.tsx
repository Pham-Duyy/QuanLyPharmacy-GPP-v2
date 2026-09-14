import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type {
  CustomerDetail,
  CustomerHealthProfile,
  CustomerInvoiceHistoryItem,
  CustomerSearchItem,
  Envelope,
  Paged,
} from "../../api/types.js";
import { formatVnd } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

/** Màn hình khách hàng: tìm/tạo/sửa thông tin cơ bản, hồ sơ sức khỏe, lịch sử mua (contract §11). */
export function CustomersPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ["customers", search],
    enabled: search.trim().length >= 3,
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerSearchItem[]>>("/customers", {
        params: { search },
      });
      return response.data.data;
    },
  });

  const detail = useQuery({
    queryKey: ["customer", openId],
    enabled: openId !== null,
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerDetail>>(`/customers/${openId}`);
      return response.data.data;
    },
  });

  return (
    <Card
      title="Khách hàng"
      extra={
        <Space>
          <Input.Search
            allowClear
            style={{ width: 320 }}
            placeholder="Gõ ít nhất 3 ký tự — tên hoặc số điện thoại"
            onSearch={setSearch}
            onChange={(event) => {
              if (event.target.value === "") setSearch("");
            }}
          />
          {can("customer.manage") ? (
            <Button type="primary" onClick={() => setCreating(true)}>
              Thêm khách
            </Button>
          ) : null}
        </Space>
      }
    >
      {search.trim().length > 0 && search.trim().length < 3 ? (
        <Alert type="info" showIcon message="Gõ thêm ít nhất 3 ký tự để tìm" style={{ marginBottom: 12 }} />
      ) : null}

      <Table
        rowKey="id"
        size="small"
        loading={list.isFetching}
        dataSource={list.data ?? []}
        pagination={false}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        locale={{ emptyText: search.trim().length >= 3 ? "Không tìm thấy khách hàng nào" : "Tìm khách hàng ở ô bên trên" }}
        columns={[
          { title: "Họ tên", dataIndex: "fullName", render: (value) => value ?? "—" },
          {
            title: "Điện thoại",
            dataIndex: "phone",
            width: 160,
            render: (value) => value ?? "—",
          },
        ]}
      />

      <CustomerDrawer
        open={openId !== null}
        customerId={openId}
        detail={detail.data ?? null}
        onClose={() => setOpenId(null)}
        onSaved={async () => {
          await queryClient.invalidateQueries({ queryKey: ["customer", openId] });
          await queryClient.invalidateQueries({ queryKey: ["customers"] });
        }}
      />

      <CustomerFormModal
        open={creating}
        customer={null}
        onClose={() => setCreating(false)}
        onSaved={async (id) => {
          setCreating(false);
          await queryClient.invalidateQueries({ queryKey: ["customers"] });
          setOpenId(id);
        }}
      />
    </Card>
  );
}

function CustomerDrawer({
  open,
  customerId,
  detail,
  onClose,
  onSaved,
}: {
  open: boolean;
  customerId: string | null;
  detail: CustomerDetail | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [anonymizing, setAnonymizing] = useState(false);

  return (
    <Drawer
      width={640}
      open={open}
      onClose={onClose}
      title={detail?.fullName ?? "Chi tiết khách hàng"}
      extra={
        detail ? (
          <Space>
            {can("customer.sensitive") && !detail.isAnonymized ? (
              <Button danger onClick={() => setAnonymizing(true)}>
                Ẩn danh
              </Button>
            ) : null}
            {can("customer.manage") && !detail.isAnonymized ? (
              <Button onClick={() => setEditing(true)}>Sửa</Button>
            ) : null}
          </Space>
        ) : null
      }
    >
      {detail?.isAnonymized ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Khách hàng này đã được ẩn danh"
          description="Họ tên, số điện thoại và hồ sơ sức khỏe đã bị xóa theo yêu cầu của khách. Chứng từ đã phát sinh vẫn giữ nguyên."
        />
      ) : null}
      {detail ? (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: "p", label: "Điện thoại", children: detail.phone ?? "—" },
              { key: "b", label: "Năm sinh", children: detail.birthYear ?? "—" },
              {
                key: "g",
                label: "Giới tính",
                children:
                  detail.gender === "MALE" ? "Nam" : detail.gender === "FEMALE" ? "Nữ" : detail.gender === "OTHER" ? "Khác" : "—",
              },
              { key: "n", label: "Ghi chú", children: detail.note ?? "—" },
            ]}
          />

          {can("customer.sensitive") ? (
            <Tabs
              items={[
                {
                  key: "health",
                  label: "Hồ sơ sức khỏe",
                  children: <HealthProfilePanel customerId={customerId!} onSaved={onSaved} />,
                },
                {
                  key: "invoices",
                  label: "Lịch sử mua",
                  children: <InvoiceHistoryPanel customerId={customerId!} />,
                },
              ]}
            />
          ) : (
            <Alert
              type="info"
              showIcon
              message="Không có quyền xem hồ sơ sức khỏe và lịch sử mua của khách"
            />
          )}
        </Space>
      ) : null}

      <CustomerFormModal
        open={editing}
        customer={detail}
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
    </Drawer>
  );
}

function AnonymizeModal({
  open,
  customerId,
  onClose,
  onSaved,
}: {
  open: boolean;
  customerId: string | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
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
        message="Thao tác không thể hoàn tác"
        description="Họ tên, số điện thoại và hồ sơ sức khỏe sẽ bị xóa vĩnh viễn, thay bằng mã ẩn danh. Hóa đơn và đơn thuốc đã phát sinh vẫn được giữ lại."
      />
      <Input.TextArea
        rows={3}
        placeholder="Lý do ẩn danh (bắt buộc — ví dụ: khách yêu cầu xóa dữ liệu cá nhân)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        autoFocus
      />
    </Modal>
  );
}

function HealthProfilePanel({
  customerId,
  onSaved,
}: {
  customerId: string;
  onSaved: () => Promise<unknown>;
}) {
  const profile = useQuery({
    queryKey: ["customer-health", customerId],
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerHealthProfile>>(
        `/customers/${customerId}/health-profile`,
      );
      return response.data.data;
    },
  });

  const [editing, setEditing] = useState(false);

  if (profile.isLoading) return null;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      {!profile.data?.hasHealthConsent ? (
        <Alert
          type="warning"
          showIcon
          message="Khách chưa đồng ý lưu hồ sơ sức khỏe"
          description="Chỉ được ghi dị ứng và bệnh nền sau khi đã hỏi và được khách đồng ý (contract §11)."
        />
      ) : null}

      <div>
        <Typography.Text type="secondary">Bệnh nền</Typography.Text>
        <div>{profile.data?.chronicConditions ?? "—"}</div>
      </div>

      <div>
        <Typography.Text type="secondary">Dị ứng theo hoạt chất</Typography.Text>
        {profile.data?.allergies.length ? (
          <Space wrap style={{ marginTop: 4 }}>
            {profile.data.allergies.map((allergy) => (
              <Tag key={allergy.ingredientId} color="red">
                {allergy.ingredientName}
                {allergy.note ? ` — ${allergy.note}` : ""}
              </Tag>
            ))}
          </Space>
        ) : (
          <div>Chưa ghi nhận dị ứng nào.</div>
        )}
      </div>

      <Button onClick={() => setEditing(true)}>
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
    </Space>
  );
}

function InvoiceHistoryPanel({ customerId }: { customerId: string }) {
  const history = useQuery({
    queryKey: ["customer-invoices", customerId],
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerInvoiceHistoryItem[]>>(
        `/customers/${customerId}/invoices`,
      );
      return response.data.data;
    },
  });

  return (
    <Table
      rowKey="id"
      size="small"
      loading={history.isLoading}
      dataSource={history.data ?? []}
      pagination={false}
      locale={{ emptyText: "Khách chưa mua lần nào" }}
      columns={[
        { title: "Số hóa đơn", dataIndex: "code" },
        { title: "Cửa hàng", dataIndex: "storeCode", width: 80 },
        {
          title: "Ngày",
          width: 150,
          render: (_, row) => new Date(row.soldAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
        },
        {
          title: "Tổng tiền",
          width: 120,
          align: "right",
          render: (_, row) => formatVnd(row.totalAmount),
        },
        {
          title: "Trạng thái",
          width: 100,
          render: (_, row) => (row.status === "VOIDED" ? <Tag color="red">Đã hủy</Tag> : <Tag color="green">Hoàn tất</Tag>),
        },
      ]}
    />
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
      const body = {
        fullName: fullName || null,
        phone: phone || null,
        birthYear,
        gender: gender ?? null,
        note: note || null,
      };
      if (customer) {
        const response = await http.patch<Envelope<CustomerDetail>>(`/customers/${customer.id}`, {
          ...body,
          version: customer.version,
        });
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
      confirmLoading={save.isPending}
      title={customer ? "Sửa thông tin khách hàng" : "Thêm khách hàng"}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Input placeholder="Họ tên" value={fullName} onChange={(event) => setFullName(event.target.value)} />
        <Input placeholder="Số điện thoại" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <InputNumber
          style={{ width: "100%" }}
          placeholder="Năm sinh"
          value={birthYear}
          onChange={setBirthYear}
        />
        <Select
          allowClear
          style={{ width: "100%" }}
          placeholder="Giới tính"
          value={gender}
          onChange={setGender}
          options={[
            { value: "MALE", label: "Nam" },
            { value: "FEMALE", label: "Nữ" },
            { value: "OTHER", label: "Khác" },
          ]}
        />
        <Input.TextArea rows={2} placeholder="Ghi chú" value={note} onChange={(event) => setNote(event.target.value)} />
      </Space>
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
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<{ id: string; name: string }>>>(
        "/active-ingredients",
        { params: { search: ingredientSearch, limit: 10 } },
      );
      return response.data.data.items;
    },
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
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => save.mutate()}
      okText="Lưu"
      okButtonProps={{ disabled: needsConsent && !consent }}
      confirmLoading={save.isPending}
      title="Hồ sơ sức khỏe"
      width={600}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {needsConsent ? (
          <Checkbox checked={consent} onChange={(event) => setConsent(event.target.checked)}>
            Tôi đã hỏi và khách đồng ý lưu hồ sơ sức khỏe (dị ứng, bệnh nền)
          </Checkbox>
        ) : (
          <Alert type="success" showIcon message="Khách đã đồng ý lưu hồ sơ sức khỏe" />
        )}

        <Input.TextArea
          rows={2}
          placeholder="Bệnh nền (ví dụ: tiểu đường, cao huyết áp)"
          value={chronicConditions}
          onChange={(event) => setChronicConditions(event.target.value)}
        />
        <Input.TextArea rows={2} placeholder="Ghi chú khác" value={note} onChange={(event) => setNote(event.target.value)} />

        <div>
          <Typography.Text type="secondary">Dị ứng theo hoạt chất</Typography.Text>
          <Select
            showSearch
            style={{ width: "100%", marginTop: 4 }}
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

          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
            {allergies.map((allergy) => (
              <Space key={allergy.ingredientId} style={{ width: "100%" }}>
                <Tag color="red">{allergy.ingredientName}</Tag>
                <Input
                  size="small"
                  placeholder="Ghi chú (biểu hiện dị ứng...)"
                  value={allergy.note}
                  onChange={(event) =>
                    setAllergies((current) =>
                      current.map((a) =>
                        a.ingredientId === allergy.ingredientId ? { ...a, note: event.target.value } : a,
                      ),
                    )
                  }
                />
                <Button
                  size="small"
                  danger
                  onClick={() =>
                    setAllergies((current) => current.filter((a) => a.ingredientId !== allergy.ingredientId))
                  }
                >
                  Xóa
                </Button>
              </Space>
            ))}
          </Space>
        </div>
      </Space>
    </Modal>
  );
}
