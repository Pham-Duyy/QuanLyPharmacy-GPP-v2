import { AuditOutlined, FileSearchOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Empty, Select, Table, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type AuditLogItem, type AuditLogPage, type Envelope } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";

const ACTION_LABEL: Record<string, string> = {
  BATCH_QUARANTINE: "Biệt trữ lô",
  BATCH_RELEASE: "Mở biệt trữ lô",
  CUSTOMER_ANONYMIZE: "Ẩn danh khách hàng",
  CUSTOMER_HEALTH_PROFILE_UPDATE: "Sửa hồ sơ sức khỏe",
  CUSTOMER_HEALTH_PROFILE_VIEW: "Xem hồ sơ sức khỏe",
  CUSTOMER_INVOICES_VIEW: "Xem lịch sử mua",
  GOODS_RECEIPT_LINE_REJECTED: "Kiểm nhập không đạt",
  INVOICE_CREATE: "Lập hóa đơn",
  INVOICE_VOID: "Hủy hóa đơn",
  OPENING_BALANCE_CREATE: "Nhập tồn đầu kỳ",
  PRESCRIPTION_IMAGE_UPLOAD: "Tải ảnh đơn thuốc",
  PRESCRIPTION_VIEW: "Xem đơn thuốc",
  RECALL_AFFECTED_SALES_VIEW: "Xem hóa đơn bị thu hồi",
  RECALL_CLOSE: "Đóng thông báo thu hồi",
  RECALL_CREATE: "Tạo thông báo thu hồi",
  RETURN_CREATE: "Nhận trả hàng",
  STOCK_ADJUSTMENT_APPROVE: "Duyệt điều chỉnh tồn",
  STOCK_ADJUSTMENT_CANCEL: "Hủy phiếu điều chỉnh",
  STOCK_ADJUSTMENT_REJECT: "Từ chối điều chỉnh tồn",
  STORE_CREATE: "Mở cửa hàng",
  STORE_DEACTIVATE: "Ngừng cửa hàng",
  USER_ACTIVATE: "Kích hoạt tài khoản",
  USER_CREATE: "Tạo tài khoản",
  USER_DEACTIVATE: "Khóa tài khoản",
  USER_PASSWORD_RESET: "Đặt lại mật khẩu",
  USER_ROLES_REPLACE: "Đổi vai trò",
};

const RESOURCE_LABEL: Record<string, string> = {
  batch: "Lô hàng",
  customer: "Khách hàng",
  goods_receipt: "Phiếu nhập",
  invoice: "Hóa đơn",
  prescription: "Đơn thuốc",
  recall: "Thu hồi",
  return: "Phiếu trả",
  stock_adjustment: "Điều chỉnh tồn",
  store: "Cửa hàng",
  user: "Tài khoản",
};

function actionTone(action: string): string {
  if (/VOID|DEACTIVATE|ANONYMIZE|REJECT|QUARANTINE|CANCEL/.test(action)) return "red";
  if (/VIEW/.test(action)) return "blue";
  if (/RESET|ROLES/.test(action)) return "orange";
  return "green";
}

/** Nhật ký thao tác — chỉ đọc, backend tự ghi ở từng nghiệp vụ (contract §18). */
export function AuditLogPage() {
  const [action, setAction] = useState<string>();
  const [resourceType, setResourceType] = useState<string>();
  const [cursors, setCursors] = useState<string[]>([]); // ngăn xếp con trỏ để "Trang trước" quay lại được
  const [detail, setDetail] = useState<AuditLogItem | null>(null);
  const currentCursor = cursors.at(-1);

  const list = useQuery({
    queryKey: ["audit-logs", action, resourceType, currentCursor],
    queryFn: async () =>
      (await http.get<Envelope<AuditLogPage>>("/audit-logs", { params: { action, resourceType, cursor: currentCursor, limit: 30 } })).data.data,
    placeholderData: (previous) => previous,
  });

  return (
    <div>
      <PageHeader icon={<AuditOutlined />} title="Nhật ký hệ thống" description="Thao tác quan trọng được ghi tự động — chỉ xem, không sửa hay xóa được." />
      <div className="split-layout">
        <Card>
          <div className="toolbar">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Mọi hành động"
              style={{ minWidth: 220 }}
              value={action}
              onChange={(value) => {
                setAction(value);
                setCursors([]);
              }}
              options={Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }))}
            />
            <Select
              allowClear
              placeholder="Mọi loại đối tượng"
              style={{ minWidth: 180 }}
              value={resourceType}
              onChange={(value) => {
                setResourceType(value);
                setCursors([]);
              }}
              options={Object.entries(RESOURCE_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </div>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data?.items ?? []}
            scroll={{ x: 640 }}
            onRow={(row) => ({ onClick: () => setDetail(row), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === detail?.id ? "row-selected" : "")}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={list.isError ? getErrorMessage(list.error, "Không tải được nhật ký") : "Chưa có bản ghi"} /> }}
            columns={[
              {
                title: "Hành động",
                key: "action",
                render: (_: unknown, row: AuditLogItem) => (
                  <div className="cell-main">
                    <strong>
                      <Tag color={actionTone(row.action)}>{ACTION_LABEL[row.action] ?? row.action}</Tag>
                    </strong>
                    <span>{formatDateTime(row.occurredAt)}</span>
                  </div>
                ),
              },
              { title: "Người thực hiện", key: "actor", width: 170, ellipsis: true, render: (_: unknown, row: AuditLogItem) => row.actorName ?? "Hệ thống" },
              {
                title: "Đối tượng",
                key: "resource",
                width: 170,
                render: (_: unknown, row: AuditLogItem) => (
                  <div className="cell-main">
                    <strong>{RESOURCE_LABEL[row.resourceType] ?? row.resourceType}</strong>
                    {row.resourceId ? <span className="mono" title={row.resourceId}>#{row.resourceId.slice(0, 8)}</span> : null}
                  </div>
                ),
              },
            ]}
          />
          <div className="cursor-pager">
            <Button icon={<LeftOutlined />} disabled={cursors.length === 0} onClick={() => setCursors((current) => current.slice(0, -1))}>
              Trang trước
            </Button>
            <span>Trang {cursors.length + 1}</span>
            <Button disabled={!list.data?.nextCursor} onClick={() => list.data?.nextCursor && setCursors((current) => [...current, list.data!.nextCursor!])}>
              Trang tiếp <RightOutlined />
            </Button>
          </div>
        </Card>
        <aside className="split-aside">
          <Card title="Chi tiết bản ghi" extra={detail ? <Button type="text" size="small" onClick={() => setDetail(null)}>Đóng</Button> : null}>
            {!detail ? (
              <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn bản ghi" description="Bấm vào một dòng để xem dữ liệu trước và sau khi thay đổi." />
            ) : (
              <div className="detail-stack">
                <div>
                  <Tag color={actionTone(detail.action)}>{ACTION_LABEL[detail.action] ?? detail.action}</Tag>
                  <div className="detail-sub mono" style={{ marginTop: 6 }}>
                    {detail.action}
                  </div>
                </div>
                <dl className="kv-list">
                  <div>
                    <dt>Thời điểm</dt>
                    <dd>{formatDateTime(detail.occurredAt)}</dd>
                  </div>
                  <div>
                    <dt>Người thực hiện</dt>
                    <dd>{detail.actorName ?? "Hệ thống"}</dd>
                  </div>
                  <div>
                    <dt>Đối tượng</dt>
                    <dd>
                      {RESOURCE_LABEL[detail.resourceType] ?? detail.resourceType}
                      {detail.resourceId ? <div className="mono text-secondary">{detail.resourceId}</div> : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Lý do</dt>
                    <dd>{detail.reason ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Địa chỉ IP</dt>
                    <dd className="mono">{detail.ip ?? "—"}</dd>
                  </div>
                </dl>
                <div className="field">
                  <span>Trước khi đổi</span>
                  <pre className="json-block">{detail.before ? JSON.stringify(detail.before, null, 2) : "—"}</pre>
                </div>
                <div className="field">
                  <span>Sau khi đổi</span>
                  <pre className="json-block">{detail.after ? JSON.stringify(detail.after, null, 2) : "—"}</pre>
                </div>
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
