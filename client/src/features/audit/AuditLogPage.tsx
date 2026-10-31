import { AuditOutlined, LeftOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, DatePicker, Drawer, Empty, Input, Select, Table, Tag } from "antd";
import type { Dayjs } from "dayjs";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type AuditLogItem, type AuditLogPage, type Envelope } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/auth-context.js";
import { useStaffList } from "../users/staff-api.js";

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
  RECALL_CUSTOMER_CONTACTED: "Đã liên hệ khách thu hồi",
  RECALL_CUSTOMER_CONTACT_REMOVED: "Bỏ đánh dấu liên hệ thu hồi",
  QUALITY_REPORT_CREATE: "Ghi phiếu khiếu nại / ADR",
  QUALITY_REPORT_UPDATE: "Cập nhật phiếu khiếu nại / ADR",
  QUALITY_REPORT_CLOSE: "Đóng phiếu khiếu nại / ADR",
  RETURN_CREATE: "Nhận trả hàng",
  STOCK_ADJUSTMENT_APPROVE: "Duyệt điều chỉnh tồn",
  STOCK_ADJUSTMENT_CANCEL: "Hủy phiếu điều chỉnh",
  STOCK_ADJUSTMENT_REJECT: "Từ chối điều chỉnh tồn",
  STOCK_TRANSFER_CANCEL: "Hủy phiếu chuyển hàng",
  STOCK_TRANSFER_RECEIVE: "Nhận hàng chuyển đến",
  STOCK_TRANSFER_SHIP: "Xuất hàng chuyển đi",
  STORAGE_LOCATION_CREATE: "Thêm khu vực bảo quản",
  STORAGE_LOCATION_UPDATE: "Sửa khu vực bảo quản",
  STORE_CREATE: "Mở cửa hàng",
  STORE_DEACTIVATE: "Ngừng cửa hàng",
  USER_ACTIVATE: "Kích hoạt tài khoản",
  USER_CREATE: "Tạo tài khoản",
  USER_DEACTIVATE: "Khóa tài khoản",
  USER_PASSWORD_RESET: "Đặt lại mật khẩu",
  USER_ROLES_REPLACE: "Đổi vai trò",
  USER_SELF_PHARMACIST: "Tự thêm vai trò Dược sĩ",
};

const RESOURCE_LABEL: Record<string, string> = {
  batch: "Lô hàng",
  customer: "Khách hàng",
  goods_receipt: "Phiếu nhập",
  invoice: "Hóa đơn",
  prescription: "Đơn thuốc",
  recall: "Thu hồi",
  quality_report: "Khiếu nại – ADR",
  return: "Phiếu trả",
  stock_adjustment: "Điều chỉnh tồn",
  stock_transfer: "Phiếu chuyển hàng",
  store: "Cửa hàng",
  user: "Tài khoản",
};

function actionTone(action: string): string {
  if (/VOID|DEACTIVATE|ANONYMIZE|REJECT|QUARANTINE|CANCEL/.test(action)) return "red";
  if (/VIEW/.test(action)) return "blue";
  if (/RESET|ROLES/.test(action)) return "orange";
  return "green";
}

type Filters = {
  action?: string;
  resourceType?: string;
  actorId?: string;
  resourceId?: string;
  range?: [Dayjs, Dayjs] | null;
};

/**
 * Nhật ký thao tác — chỉ đọc, backend tự ghi ở từng nghiệp vụ (contract §18). Lọc theo người,
 * khoảng ngày, hành động, loại và mã đối tượng; bấm một dòng thì chi tiết mở trong ngăn trượt.
 */
export function AuditLogPage() {
  const { can } = useAuth();
  const [filters, setFilters] = useState<Filters>({});
  const [cursors, setCursors] = useState<string[]>([]); // ngăn xếp con trỏ để "Trang trước" quay lại được
  const [detail, setDetail] = useState<AuditLogItem | null>(null);
  const currentCursor = cursors.at(-1);
  // Danh sách nhân viên cần user.manage; kiểm toán không có thì ẩn ô lọc người.
  const canPickActor = can("user.manage");
  const staff = useStaffList(canPickActor);

  const setFilter = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setCursors([]);
  };
  const params = {
    action: filters.action,
    resourceType: filters.resourceType,
    actorId: filters.actorId,
    resourceId: filters.resourceId?.trim() || undefined,
    from: filters.range?.[0].startOf("day").toISOString(),
    to: filters.range?.[1].endOf("day").toISOString(),
  };

  const list = useQuery({
    queryKey: ["audit-logs", params, currentCursor],
    queryFn: async () =>
      (
        await http.get<Envelope<AuditLogPage>>("/audit-logs", {
          params: { ...params, cursor: currentCursor, limit: 30 },
        })
      ).data.data,
    placeholderData: (previous) => previous,
  });

  return (
    <div>
      <PageHeader icon={<AuditOutlined />} title="Nhật ký hệ thống" />
      <Card>
        <div className="toolbar audit-toolbar">
          <DatePicker.RangePicker
            format="DD/MM/YYYY"
            placeholder={["Từ ngày", "Đến ngày"]}
            value={filters.range ?? null}
            onChange={(range) => setFilter({ range: range as [Dayjs, Dayjs] | null })}
          />
          {canPickActor ? (
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Mọi người"
              value={filters.actorId}
              onChange={(actorId) => setFilter({ actorId })}
              options={(staff.data ?? []).map((user) => ({
                value: user.id,
                label: user.fullName,
              }))}
            />
          ) : null}
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Mọi hành động"
            value={filters.action}
            onChange={(action) => setFilter({ action })}
            options={Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            allowClear
            placeholder="Mọi đối tượng"
            value={filters.resourceType}
            onChange={(resourceType) => setFilter({ resourceType })}
            options={Object.entries(RESOURCE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Input
            allowClear
            prefix={<SearchOutlined aria-hidden />}
            placeholder="Mã đối tượng"
            aria-label="Mã đối tượng"
            value={filters.resourceId}
            onChange={(event) => setFilter({ resourceId: event.target.value })}
          />
        </div>
        <Table
          rowKey="id"
          loading={list.isFetching}
          dataSource={list.data?.items ?? []}
          scroll={{ x: 820 }}
          onRow={(row) => ({ onClick: () => setDetail(row), style: { cursor: "pointer" } })}
          rowClassName={(row) => (row.id === detail?.id ? "row-selected" : "")}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  list.isError
                    ? getErrorMessage(list.error, "Không tải được nhật ký")
                    : Object.values(params).some(Boolean)
                      ? "Không có bản ghi khớp bộ lọc"
                      : "Chưa có bản ghi"
                }
              />
            ),
          }}
          columns={[
            {
              title: "Thời gian",
              key: "time",
              width: 150,
              render: (_: unknown, row: AuditLogItem) => (
                <span className="mono">{formatDateTime(row.occurredAt)}</span>
              ),
            },
            {
              title: "Hành động",
              key: "action",
              width: 220,
              render: (_: unknown, row: AuditLogItem) => (
                <Tag color={actionTone(row.action)}>{ACTION_LABEL[row.action] ?? row.action}</Tag>
              ),
            },
            {
              title: "Người thực hiện",
              key: "actor",
              width: 170,
              ellipsis: true,
              render: (_: unknown, row: AuditLogItem) => row.actorName ?? "Hệ thống",
            },
            {
              title: "Đối tượng",
              key: "resource",
              width: 170,
              render: (_: unknown, row: AuditLogItem) => (
                <div className="cell-main">
                  <strong>{RESOURCE_LABEL[row.resourceType] ?? row.resourceType}</strong>
                  {row.resourceId ? (
                    <span className="mono" title={row.resourceId}>
                      #{row.resourceId.slice(0, 8)}
                    </span>
                  ) : null}
                </div>
              ),
            },
            {
              title: "Lý do",
              key: "reason",
              ellipsis: true,
              render: (_: unknown, row: AuditLogItem) => row.reason ?? "—",
            },
          ]}
        />
        <div className="cursor-pager">
          <Button
            icon={<LeftOutlined />}
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Trang trước
          </Button>
          <span>Trang {cursors.length + 1}</span>
          <Button
            disabled={!list.data?.nextCursor}
            onClick={() =>
              list.data?.nextCursor && setCursors((current) => [...current, list.data!.nextCursor!])
            }
          >
            Trang tiếp <RightOutlined />
          </Button>
        </div>
      </Card>
      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="Chi tiết bản ghi"
        size="large"
      >
        {detail ? <AuditDetail detail={detail} /> : null}
      </Drawer>
    </div>
  );
}

function AuditDetail({ detail }: { detail: AuditLogItem }) {
  return (
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
            {detail.resourceId ? (
              <div className="mono text-secondary">{detail.resourceId}</div>
            ) : null}
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
        <pre className="json-block">
          {detail.before ? JSON.stringify(detail.before, null, 2) : "—"}
        </pre>
      </div>
      <div className="field">
        <span>Sau khi đổi</span>
        <pre className="json-block">
          {detail.after ? JSON.stringify(detail.after, null, 2) : "—"}
        </pre>
      </div>
    </div>
  );
}
