import { useQuery } from "@tanstack/react-query";
import { Button, Card, Drawer, Input, Select, Space, Table, Typography } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type AuditLogItem, type AuditLogPage, type Envelope } from "../../api/types.js";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("vi-VN");
}

/** Xem audit log — chỉ đọc, backend tự ghi ở từng nghiệp vụ (contract §18). */
export function AuditLogPage() {
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [cursors, setCursors] = useState<string[]>([]); // ngăn xếp con trỏ để "Trang trước" quay lại được
  const [detail, setDetail] = useState<AuditLogItem | null>(null);

  const currentCursor = cursors.at(-1);

  const list = useQuery({
    queryKey: ["audit-logs", action, resourceType, currentCursor],
    queryFn: async () =>
      (
        await http.get<Envelope<AuditLogPage>>("/audit-logs", {
          params: {
            action: action || undefined,
            resourceType: resourceType || undefined,
            cursor: currentCursor,
            limit: 30,
          },
        })
      ).data.data,
  });

  function resetPaging(): void {
    setCursors([]);
  }

  return (
    <Card title="Audit log">
      <Typography.Paragraph type="secondary">
        Nhật ký thao tác quan trọng trong hệ thống — chỉ xem, không sửa hay xóa được. Backend tự ghi ở từng nghiệp vụ.
      </Typography.Paragraph>
      <Space style={{ marginBottom: 12 }}>
        <Input
          allowClear
          placeholder="Lọc theo action (vd: BATCH_QUARANTINE)"
          style={{ width: 260 }}
          onChange={(event) => {
            setAction(event.target.value);
            resetPaging();
          }}
        />
        <Select
          allowClear
          placeholder="Loại đối tượng"
          style={{ width: 200 }}
          value={resourceType || undefined}
          onChange={(value) => {
            setResourceType(value ?? "");
            resetPaging();
          }}
          options={[
            "batch",
            "customer",
            "goods_receipt",
            "invoice",
            "prescription",
            "recall",
            "stock_adjustment",
            "store",
            "user",
          ].map((value) => ({ value, label: value }))}
        />
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        onRow={(row) => ({ onClick: () => setDetail(row), style: { cursor: "pointer" } })}
        pagination={false}
        locale={{ emptyText: list.isError ? getErrorMessage(list.error, "Không tải được audit log") : "Chưa có bản ghi" }}
        columns={[
          { title: "Thời điểm", width: 160, render: (_, row: AuditLogItem) => formatDateTime(row.occurredAt) },
          { title: "Người thực hiện", width: 160, render: (_, row: AuditLogItem) => row.actorName ?? "Hệ thống" },
          { title: "Hành động", dataIndex: "action", width: 220 },
          { title: "Đối tượng", render: (_, row: AuditLogItem) => `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ""}` },
          { title: "Lý do", dataIndex: "reason", render: (value) => value ?? "—" },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={cursors.length === 0} onClick={() => setCursors((current) => current.slice(0, -1))}>
          Trang trước
        </Button>
        <Button
          disabled={!list.data?.nextCursor}
          onClick={() => list.data?.nextCursor && setCursors((current) => [...current, list.data!.nextCursor!])}
        >
          Trang tiếp
        </Button>
      </Space>

      <Drawer width={520} open={detail !== null} onClose={() => setDetail(null)} title="Chi tiết audit log">
        {detail ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Typography.Text>Thời điểm: {formatDateTime(detail.occurredAt)}</Typography.Text>
            <Typography.Text>Người thực hiện: {detail.actorName ?? "Hệ thống"}</Typography.Text>
            <Typography.Text>Hành động: {detail.action}</Typography.Text>
            <Typography.Text>
              Đối tượng: {detail.resourceType}
              {detail.resourceId ? ` · ${detail.resourceId}` : ""}
            </Typography.Text>
            <Typography.Text>Lý do: {detail.reason ?? "—"}</Typography.Text>
            <Typography.Text>IP: {detail.ip ?? "—"}</Typography.Text>
            <div>
              <Typography.Text type="secondary">Trước khi đổi</Typography.Text>
              <pre style={{ background: "#f5f5f5", padding: 8, borderRadius: 4, overflowX: "auto" }}>
                {detail.before ? JSON.stringify(detail.before, null, 2) : "—"}
              </pre>
            </div>
            <div>
              <Typography.Text type="secondary">Sau khi đổi</Typography.Text>
              <pre style={{ background: "#f5f5f5", padding: 8, borderRadius: 4, overflowX: "auto" }}>
                {detail.after ? JSON.stringify(detail.after, null, 2) : "—"}
              </pre>
            </div>
          </Space>
        ) : null}
      </Drawer>
    </Card>
  );
}
