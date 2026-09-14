import { FilePdfOutlined, UploadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Descriptions,
  Drawer,
  Image,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type {
  Envelope,
  PrescriptionDetail,
  PrescriptionListItem,
  PrescriptionStatus,
} from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";
import { PrescriptionFormModal } from "./PrescriptionFormModal.js";

const STATUS_TAG: Record<PrescriptionStatus, { text: string; color: string }> = {
  DRAFT: { text: "Nháp", color: "default" },
  PENDING_REVIEW: { text: "Chờ xác nhận", color: "gold" },
  VERIFIED: { text: "Đã xác nhận", color: "green" },
  PARTIALLY_DISPENSED: { text: "Đã bán một phần", color: "blue" },
  DISPENSED: { text: "Đã bán hết", color: "blue" },
  REJECTED: { text: "Đã từ chối", color: "red" },
};

export function PrescriptionsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PrescriptionDetail | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const list = useQuery({
    queryKey: ["prescriptions", status],
    queryFn: async () => {
      const response = await http.get<Envelope<PrescriptionListItem[]>>("/prescriptions", {
        params: { status },
      });
      return response.data.data;
    },
  });

  const detail = useQuery({
    queryKey: ["prescription", openId],
    enabled: openId !== null,
    queryFn: async () => {
      const response = await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${openId}`);
      return response.data.data;
    },
  });

  function afterAction() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["prescriptions"] }),
      queryClient.invalidateQueries({ queryKey: ["prescription", openId] }),
    ]);
  }

  const submit = useMutation({
    mutationFn: () =>
      http.post(
        `/prescriptions/${openId}/submit`,
        {},
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã nộp đơn chờ dược sĩ xác nhận");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không nộp được đơn")),
  });

  const verify = useMutation({
    mutationFn: () =>
      http.post(
        `/prescriptions/${openId}/verify`,
        {},
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã xác nhận đơn thuốc");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận được đơn")),
  });

  const reject = useMutation({
    mutationFn: () =>
      http.post(
        `/prescriptions/${openId}/reject`,
        { reason: rejectReason },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã từ chối đơn thuốc");
      setRejecting(false);
      setRejectReason("");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không từ chối được đơn")),
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      // Không tự đặt Content-Type: trình duyệt cần tự thêm boundary của multipart.
      await http.post(`/prescriptions/${openId}/images`, form);
    },
    onSuccess: async () => {
      void message.success("Đã tải ảnh lên");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không tải được ảnh lên")),
  });

  const data = detail.data;
  const canEdit = data && can("prescription.create") && ["DRAFT", "PENDING_REVIEW"].includes(data.status);
  const canSubmit = data && can("prescription.create") && data.status === "DRAFT";
  const canVerify =
    data && can("prescription.verify") && ["DRAFT", "PENDING_REVIEW"].includes(data.status);

  return (
    <Card
      title="Đơn thuốc"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="Lọc theo trạng thái"
            style={{ width: 180 }}
            value={status}
            onChange={setStatus}
            options={Object.entries(STATUS_TAG).map(([value, { text }]) => ({ value, label: text }))}
          />
          {can("prescription.create") ? (
            <Button
              type="primary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              Tạo đơn thuốc
            </Button>
          ) : null}
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        pagination={false}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        columns={[
          { title: "Số đơn", dataIndex: "code", width: 200 },
          {
            title: "Khách",
            render: (_, row: PrescriptionListItem) => row.customer?.fullName ?? "—",
          },
          {
            title: "Ngày kê",
            width: 110,
            render: (_, row: PrescriptionListItem) =>
              new Date(row.prescribedDate).toLocaleDateString("vi-VN"),
          },
          {
            title: "Hết hạn",
            width: 110,
            render: (_, row: PrescriptionListItem) =>
              new Date(row.validUntil).toLocaleDateString("vi-VN"),
          },
          { title: "Số dòng", dataIndex: ["_count", "items"], width: 80, align: "right" },
          {
            title: "Trạng thái",
            width: 130,
            render: (_, row: PrescriptionListItem) => {
              const info = STATUS_TAG[row.status];
              return <Tag color={info.color}>{info.text}</Tag>;
            },
          },
        ]}
      />

      <Drawer
        width={640}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={data?.code ?? "Chi tiết đơn thuốc"}
        extra={
          data ? (
            <Space>
              {canEdit ? (
                <Button
                  onClick={() => {
                    setEditing(data);
                    setFormOpen(true);
                  }}
                >
                  Sửa
                </Button>
              ) : null}
              {canSubmit ? (
                <Button onClick={() => submit.mutate()} loading={submit.isPending}>
                  Nộp duyệt
                </Button>
              ) : null}
              {canVerify ? (
                <>
                  <Button danger onClick={() => setRejecting(true)}>
                    Từ chối
                  </Button>
                  <Button type="primary" onClick={() => verify.mutate()} loading={verify.isPending}>
                    Xác nhận
                  </Button>
                </>
              ) : null}
            </Space>
          ) : null
        }
      >
        {data ? (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: "s",
                  label: "Trạng thái",
                  children: <Tag color={STATUS_TAG[data.status].color}>{STATUS_TAG[data.status].text}</Tag>,
                },
                { key: "bs", label: "Bác sĩ kê đơn", children: data.prescriberName ?? "—" },
                { key: "cs", label: "Cơ sở khám", children: data.facilityName ?? "—" },
                { key: "cd", label: "Chẩn đoán", children: data.diagnosisText ?? "—" },
                {
                  key: "pd",
                  label: "Ngày kê",
                  children: new Date(data.prescribedDate).toLocaleDateString("vi-VN"),
                },
                {
                  key: "vu",
                  label: "Hết hạn",
                  children: new Date(data.validUntil).toLocaleDateString("vi-VN"),
                },
                ...(data.verifiedBy
                  ? [{ key: "vb", label: "Người xác nhận", children: data.verifiedBy.fullName }]
                  : []),
                ...(data.rejectedReason
                  ? [{ key: "rr", label: "Lý do từ chối", children: data.rejectedReason }]
                  : []),
              ]}
            />

            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={data.items}
              columns={[
                {
                  title: "Thuốc",
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{item.drugNameText}</Typography.Text>
                      {item.productId ? (
                        <Typography.Text type="secondary">
                          Khớp: {item.productName} ({item.productCode})
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="warning">Chưa khớp sản phẩm</Typography.Text>
                      )}
                    </Space>
                  ),
                },
                {
                  title: "SL",
                  width: 100,
                  align: "right",
                  render: (_, item) => `${item.quantity} ${item.unitName ?? ""}`,
                },
                {
                  title: "Đã bán",
                  width: 90,
                  align: "right",
                  render: (_, item) =>
                    item.baseQuantity !== null ? `${item.dispensedBaseQuantity}/${item.baseQuantity}` : "—",
                },
                { title: "Liều dùng", dataIndex: "dosageInstruction" },
              ]}
            />

            <div>
              <Space align="center" style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary">Ảnh đơn thuốc</Typography.Text>
                {can("prescription.create") ? (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadImage.mutate(file);
                        event.target.value = "";
                      }}
                    />
                    <Button
                      size="small"
                      icon={<UploadOutlined />}
                      loading={uploadImage.isPending}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Tải ảnh lên
                    </Button>
                  </>
                ) : null}
              </Space>

              {data.images.length === 0 ? (
                <Typography.Text type="secondary">Chưa có ảnh nào.</Typography.Text>
              ) : (
                <Space wrap>
                  {data.images.map((image) =>
                    image.contentType === "application/pdf" ? (
                      <Button
                        key={image.id}
                        icon={<FilePdfOutlined />}
                        onClick={() => window.open(image.url, "_blank")}
                      >
                        Phiên bản {image.versionNo} (PDF)
                      </Button>
                    ) : (
                      <div key={image.id} style={{ textAlign: "center" }}>
                        <Image src={image.url} width={90} height={90} style={{ objectFit: "cover" }} />
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            Phiên bản {image.versionNo}
                          </Typography.Text>
                        </div>
                      </div>
                    ),
                  )}
                </Space>
              )}
            </div>
          </Space>
        ) : null}
      </Drawer>

      <PrescriptionFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />

      <Modal
        open={rejecting}
        title="Từ chối đơn thuốc"
        okText="Xác nhận từ chối"
        okButtonProps={{ danger: true, disabled: rejectReason.trim().length === 0 }}
        confirmLoading={reject.isPending}
        onOk={() => reject.mutate()}
        onCancel={() => setRejecting(false)}
      >
        <Input.TextArea
          rows={3}
          placeholder="Lý do từ chối (bắt buộc)"
          value={rejectReason}
          onChange={(event) => setRejectReason(event.target.value)}
        />
      </Modal>
    </Card>
  );
}
