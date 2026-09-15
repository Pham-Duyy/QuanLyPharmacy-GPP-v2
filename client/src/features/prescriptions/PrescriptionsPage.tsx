import { CheckOutlined, CloseOutlined, EditOutlined, FilePdfOutlined, FileProtectOutlined, FileSearchOutlined, PlusOutlined, SendOutlined, UploadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Empty, Image, Input, Modal, Segmented, Skeleton, Table, Tag, Typography } from "antd";
import { useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, PrescriptionDetail, PrescriptionListItem, PrescriptionStatus } from "../../api/types.js";
import { daysUntil, formatDate, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useAuth } from "../auth/AuthProvider.js";
import { PrescriptionFormModal } from "./PrescriptionFormModal.js";

const STATUS_TAG: Record<PrescriptionStatus, { text: string; color: string }> = {
  DRAFT: { text: "Nháp", color: "default" },
  PENDING_REVIEW: { text: "Chờ xác nhận", color: "gold" },
  VERIFIED: { text: "Đã xác nhận", color: "green" },
  PARTIALLY_DISPENSED: { text: "Đã bán một phần", color: "blue" },
  DISPENSED: { text: "Đã bán hết", color: "purple" },
  REJECTED: { text: "Đã từ chối", color: "red" },
};

function StatusTag({ status }: { status: PrescriptionStatus }) {
  return <Tag color={STATUS_TAG[status].color}>{STATUS_TAG[status].text}</Tag>;
}

export function PrescriptionsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PrescriptionStatus | "ALL">("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PrescriptionDetail | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["prescriptions", status],
    queryFn: async () => (await http.get<Envelope<PrescriptionListItem[]>>("/prescriptions", { params: { status: status === "ALL" ? undefined : status } })).data.data,
    placeholderData: (previous) => previous,
  });

  const detail = useQuery({
    queryKey: ["prescription", openId],
    enabled: openId !== null,
    queryFn: async () => (await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${openId}`)).data.data,
  });

  function afterAction() {
    return Promise.all([queryClient.invalidateQueries({ queryKey: ["prescriptions"] }), queryClient.invalidateQueries({ queryKey: ["prescription", openId] })]);
  }

  const submit = useMutation({
    mutationFn: () => http.post(`/prescriptions/${openId}/submit`, {}, { headers: { "Idempotency-Key": crypto.randomUUID() } }),
    onSuccess: async () => {
      void message.success("Đã nộp đơn chờ dược sĩ xác nhận");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không nộp được đơn")),
  });

  const verify = useMutation({
    mutationFn: () => http.post(`/prescriptions/${openId}/verify`, {}, { headers: { "Idempotency-Key": crypto.randomUUID() } }),
    onSuccess: async () => {
      void message.success("Đã xác nhận đơn thuốc");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận được đơn")),
  });

  const reject = useMutation({
    mutationFn: () => http.post(`/prescriptions/${openId}/reject`, { reason: rejectReason }, { headers: { "Idempotency-Key": crypto.randomUUID() } }),
    onSuccess: async () => {
      void message.success("Đã từ chối đơn thuốc");
      setRejecting(false);
      setRejectReason("");
      await afterAction();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không từ chối được đơn")),
  });

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
  const canVerify = data && can("prescription.verify") && ["DRAFT", "PENDING_REVIEW"].includes(data.status);

  return (
    <div>
      <PageHeader
        icon={<FileProtectOutlined />}
        title="Đơn thuốc"
        description="Nhập đơn thuốc, dược sĩ xác nhận rồi mới bán được thuốc kê đơn theo đơn."
        extra={
          can("prescription.create") ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              Tạo đơn thuốc
            </Button>
          ) : null
        }
      />

      <div className="split-layout">
        <Card>
          <div className="toolbar">
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[{ value: "ALL", label: "Tất cả" }, ...(["PENDING_REVIEW", "VERIFIED", "PARTIALLY_DISPENSED", "DRAFT", "REJECTED"] as PrescriptionStatus[]).map((value) => ({ value, label: STATUS_TAG[value].text }))]}
            />
          </div>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data ?? []}
            pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
            scroll={{ x: 620 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có đơn thuốc" /> }}
            columns={[
              {
                title: "Đơn thuốc",
                key: "code",
                render: (_: unknown, row: PrescriptionListItem) => (
                  <div className="cell-main">
                    <strong className="mono">{row.code}</strong>
                    <span>
                      {row.customer?.fullName ?? "Khách lẻ"} · {row._count.items} thuốc
                    </span>
                  </div>
                ),
              },
              { title: "Ngày kê", key: "date", width: 110, render: (_: unknown, row: PrescriptionListItem) => formatDate(row.prescribedDate) },
              {
                title: "Hiệu lực",
                key: "valid",
                width: 130,
                render: (_: unknown, row: PrescriptionListItem) => {
                  const days = daysUntil(row.validUntil);
                  return (
                    <div className="cell-main">
                      <strong>{formatDate(row.validUntil)}</strong>
                      <span className={days < 0 ? "text-danger" : undefined}>{days < 0 ? "Đã hết hạn" : `Còn ${days} ngày`}</span>
                    </div>
                  );
                },
              },
              { title: "Trạng thái", key: "status", width: 140, render: (_: unknown, row: PrescriptionListItem) => <StatusTag status={row.status} /> },
            ]}
          />
        </Card>

        <aside className="split-aside">
          {openId === null ? (
            <Card title="Chi tiết đơn thuốc">
              <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn đơn thuốc" description="Bấm vào một đơn để xem thuốc trong đơn, ảnh đơn và xác nhận." />
            </Card>
          ) : (
            <Card
              title={data ? <span className="mono">{data.code}</span> : "Chi tiết đơn thuốc"}
              extra={
                <Button type="text" size="small" onClick={() => setOpenId(null)}>
                  Đóng
                </Button>
              }
            >
              {detail.isLoading || !data ? (
                <Skeleton active paragraph={{ rows: 8 }} />
              ) : (
                <div className="detail-stack">
                  <div>
                    <StatusTag status={data.status} />
                    <h3 className="detail-title" style={{ marginTop: 8 }}>
                      {data.customer?.fullName ?? "Khách lẻ"}
                    </h3>
                    {data.externalCode ? <span className="detail-sub">Mã đơn quốc gia: <span className="mono">{data.externalCode}</span></span> : null}
                  </div>
                  <dl className="kv-list">
                    <div>
                      <dt>Bác sĩ kê đơn</dt>
                      <dd>{data.prescriberName ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Cơ sở khám</dt>
                      <dd>{data.facilityName ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Chẩn đoán</dt>
                      <dd>{data.diagnosisText ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Ngày kê · hết hạn</dt>
                      <dd>
                        {formatDate(data.prescribedDate)} · {formatDate(data.validUntil)}
                      </dd>
                    </div>
                    {data.verifiedBy ? (
                      <div>
                        <dt>Dược sĩ xác nhận</dt>
                        <dd>{data.verifiedBy.fullName}</dd>
                      </div>
                    ) : null}
                    {data.rejectedReason ? (
                      <div>
                        <dt>Lý do từ chối</dt>
                        <dd className="text-danger">{data.rejectedReason}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {canEdit || canSubmit || canVerify ? (
                    <div className="panel-actions">
                      {canVerify ? (
                        <div className="panel-actions-row">
                          <Button type="primary" icon={<CheckOutlined />} onClick={() => verify.mutate()} loading={verify.isPending}>
                            Xác nhận đơn
                          </Button>
                          <Button danger icon={<CloseOutlined />} onClick={() => setRejecting(true)}>
                            Từ chối
                          </Button>
                        </div>
                      ) : null}
                      {canEdit || canSubmit ? (
                        <div className="panel-actions-row">
                          {canEdit ? (
                            <Button
                              icon={<EditOutlined />}
                              onClick={() => {
                                setEditing(data);
                                setFormOpen(true);
                              }}
                            >
                              Sửa đơn
                            </Button>
                          ) : null}
                          {canSubmit ? (
                            <Button icon={<SendOutlined />} onClick={() => submit.mutate()} loading={submit.isPending}>
                              Nộp duyệt
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="line-list">
                    <div className="line-list-head">
                      <span>{data.items.length} thuốc trong đơn</span>
                      <span>Đã bán / theo đơn</span>
                    </div>
                    {data.items.map((item) => (
                      <div className="line-item" key={item.id}>
                        <div className="line-item-main">
                          <strong>{item.drugNameText}</strong>
                          {item.productId ? (
                            <span>
                              Khớp: {item.productName} ({item.productCode})
                            </span>
                          ) : (
                            <Typography.Text type="warning" style={{ fontSize: 12 }}>
                              Chưa khớp sản phẩm trong danh mục
                            </Typography.Text>
                          )}
                          {item.dosageInstruction ? <span>Liều dùng: {item.dosageInstruction}</span> : null}
                        </div>
                        <div className="line-item-side">
                          <strong>
                            {formatNumber(item.quantity)} {item.unitName ?? ""}
                          </strong>
                          <span>{item.baseQuantity !== null ? `${formatNumber(item.dispensedBaseQuantity)}/${formatNumber(item.baseQuantity)}` : "—"}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="field">
                    <span>Ảnh đơn thuốc</span>
                    {data.images.length === 0 ? (
                      <Typography.Text type="secondary">Chưa có ảnh nào.</Typography.Text>
                    ) : (
                      <div className="image-grid">
                        {data.images.map((image) =>
                          image.contentType === "application/pdf" ? (
                            <Button key={image.id} icon={<FilePdfOutlined />} onClick={() => window.open(image.url, "_blank", "noopener")}>
                              Bản {image.versionNo} (PDF)
                            </Button>
                          ) : (
                            <figure key={image.id}>
                              <Image src={image.url} width={88} height={88} style={{ objectFit: "cover", borderRadius: 8 }} />
                              <figcaption>Bản {image.versionNo}</figcaption>
                            </figure>
                          ),
                        )}
                      </div>
                    )}
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
                        <Button icon={<UploadOutlined />} loading={uploadImage.isPending} onClick={() => fileInputRef.current?.click()}>
                          Tải ảnh / PDF đơn thuốc
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </Card>
          )}
        </aside>
      </div>

      <PrescriptionFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />

      <Modal
        open={rejecting}
        title="Từ chối đơn thuốc"
        okText="Xác nhận từ chối"
        cancelText="Đóng"
        okButtonProps={{ danger: true, disabled: rejectReason.trim().length === 0 }}
        confirmLoading={reject.isPending}
        onOk={() => reject.mutate()}
        onCancel={() => setRejecting(false)}
      >
        <Input.TextArea rows={3} placeholder="Lý do từ chối (bắt buộc)" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
      </Modal>
    </div>
  );
}
