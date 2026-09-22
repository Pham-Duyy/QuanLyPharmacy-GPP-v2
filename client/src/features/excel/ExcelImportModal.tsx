import { CheckCircleFilled, DownloadOutlined, FileExcelOutlined, InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Modal, Result, Space, Spin, Table, Tabs, Tag, Typography, Upload } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatNumber } from "../../ui/format.js";
import { downloadTemplate, sendImport, type ImportPreview, type ImportResult, type ImportType } from "./excel-api.js";

type Props = {
  type: ImportType;
  title: string;
  open: boolean;
  onClose: () => void;
  /** Gọi sau khi ghi thành công để trang tải lại dữ liệu. */
  onDone?: (result: ImportResult) => void;
  /** Dòng chú thích riêng của từng loại (vd. tồn đầu kỳ chỉ dùng trước khi bán). */
  hint?: string;
};

const MAX_MB = 5;

export function ExcelImportModal({ type, title, open, onClose, onDone, hint }: Props) {
  const { message } = App.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | "template" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function check(next: File) {
    setFile(next);
    setPreview(null);
    setError(null);
    if (next.size > MAX_MB * 1024 * 1024) {
      setError(`Tệp lớn hơn ${MAX_MB} MB — chia nhỏ tệp rồi nhập từng phần`);
      return;
    }
    setBusy("preview");
    try {
      setPreview(await sendImport(type, next, "preview"));
    } catch (caught) {
      setError(getErrorMessage(caught, "Không đọc được tệp"));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy("commit");
    try {
      const saved = await sendImport<ImportResult>(type, file, "commit");
      setResult(saved);
      onDone?.(saved);
    } catch (caught) {
      // Dữ liệu có thể đã đổi từ lúc xem trước (người khác vừa sửa): kiểm tra lại cho người dùng thấy.
      void message.error(getErrorMessage(caught, "Không ghi được dữ liệu"));
      await check(file);
    } finally {
      setBusy(null);
    }
  }

  async function template() {
    setBusy("template");
    try {
      await downloadTemplate(type);
    } catch (caught) {
      void message.error(caught instanceof Error ? caught.message : "Không tải được tệp mẫu");
    } finally {
      setBusy(null);
    }
  }

  const blocked = !preview || preview.missingColumns.length > 0 || preview.issueCount > 0 || preview.validRows === 0;

  const footer = result
    ? [
        <Button key="again" onClick={reset}>
          Nhập tệp khác
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          Xong
        </Button>,
      ]
    : [
        <Button key="template" icon={<DownloadOutlined />} loading={busy === "template"} onClick={() => void template()}>
          Tải tệp mẫu
        </Button>,
        <Button key="cancel" onClick={onClose}>
          Hủy
        </Button>,
        <Button key="commit" type="primary" disabled={blocked || busy !== null} loading={busy === "commit"} onClick={() => void commit()}>
          {preview && !blocked ? `Ghi ${formatNumber(preview.validRows)} dòng` : "Ghi dữ liệu"}
        </Button>,
      ];

  return (
    <Modal
      title={
        <Space>
          <FileExcelOutlined style={{ color: "#1d6f42" }} />
          Nhập {title.toLowerCase()} từ Excel
        </Space>
      }
      open={open}
      onCancel={onClose}
      afterOpenChange={(visible) => {
        if (!visible) reset();
      }}
      width={880}
      footer={footer}
      destroyOnHidden
      mask={{ closable: busy === null }}
    >
      {result ? (
        <Result
          status="success"
          title="Đã ghi dữ liệu"
          subTitle={[result.created ? `Tạo mới ${formatNumber(result.created)}` : null, result.updated ? `cập nhật ${formatNumber(result.updated)}` : null].filter(Boolean).join(", ") + ` · tệp ${result.fileName}`}
        />
      ) : (
        <div className="excel-import">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {hint ?? "Dùng tệp mẫu để đúng tên cột."} Hệ thống kiểm tra toàn bộ tệp trước; còn một lỗi là chưa ghi dòng nào, sửa trong Excel rồi chọn lại tệp.
          </Typography.Paragraph>

          <Upload.Dragger
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            multiple={false}
            showUploadList={false}
            disabled={busy !== null}
            beforeUpload={(next) => {
              void check(next);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">{file ? <FileExcelOutlined style={{ color: "#1d6f42" }} /> : <InboxOutlined />}</p>
            <p className="ant-upload-text">{file ? file.name : "Kéo tệp .xlsx vào đây hoặc bấm để chọn"}</p>
            <p className="ant-upload-hint">Excel 2007 trở lên, tối đa {MAX_MB} MB, 5.000 dòng</p>
          </Upload.Dragger>

          {busy === "preview" ? (
            <div className="excel-import-busy">
              <Spin /> <span>Đang đọc và kiểm tra tệp…</span>
            </div>
          ) : null}
          {error ? <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} /> : null}
          {preview ? <PreviewBody preview={preview} onRetry={() => file && void check(file)} /> : null}
        </div>
      )}
    </Modal>
  );
}

function PreviewBody({ preview, onRetry }: { preview: ImportPreview; onRetry: () => void }) {
  const stats = [
    { label: "Dòng dữ liệu", value: preview.totalRows },
    { label: "Hợp lệ", value: preview.validRows, tone: "ok" },
    { label: "Tạo mới", value: preview.creates },
    { label: "Cập nhật", value: preview.updates },
    { label: "Lỗi", value: preview.issueCount, tone: preview.issueCount ? "bad" : undefined },
  ];
  return (
    <div style={{ marginTop: 14 }}>
      <div className="excel-import-stats">
        {stats.map((stat) => (
          <div key={stat.label} className={`excel-import-stat ${stat.tone ?? ""}`}>
            <span>{stat.label}</span>
            <strong>{formatNumber(stat.value)}</strong>
          </div>
        ))}
      </div>

      {preview.missingColumns.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          title="Tệp thiếu cột bắt buộc"
          description={`${preview.missingColumns.join(", ")}. Tải tệp mẫu để xem đúng tên cột (thứ tự cột không quan trọng).`}
        />
      ) : null}
      {preview.notes.map((note) => (
        <Alert key={note} type="info" showIcon style={{ marginTop: 12 }} title={note} />
      ))}
      {preview.issueCount === 0 && preview.missingColumns.length === 0 && preview.validRows > 0 ? (
        <Alert type="success" showIcon icon={<CheckCircleFilled />} style={{ marginTop: 12 }} title="Tệp hợp lệ, sẵn sàng ghi" />
      ) : null}
      {preview.totalRows === 0 && preview.missingColumns.length === 0 ? <Alert type="warning" showIcon style={{ marginTop: 12 }} title="Tệp không có dòng dữ liệu nào" /> : null}

      <Tabs
        key={`${preview.fileName}-${preview.issueCount}`}
        style={{ marginTop: 8 }}
        defaultActiveKey={preview.issueCount > 0 ? "issues" : "rows"}
        tabBarExtraContent={
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRetry}>
            Kiểm tra lại
          </Button>
        }
        items={[
          {
            key: "issues",
            label: `Lỗi cần sửa (${formatNumber(preview.issueCount)})`,
            disabled: preview.issueCount === 0,
            children: (
              <>
                <Table
                  size="small"
                  rowKey={(issue) => `${issue.row}-${issue.column ?? ""}-${issue.message}`}
                  dataSource={preview.issues}
                  pagination={preview.issues.length > 8 ? { pageSize: 8, size: "small" } : false}
                  columns={[
                    { title: "Dòng", dataIndex: "row", width: 64 },
                    { title: "Cột", dataIndex: "column", width: 190, render: (value?: string) => value ?? "—" },
                    { title: "Lỗi", dataIndex: "message" },
                  ]}
                />
                {preview.issueCount > preview.issues.length ? (
                  <Typography.Text type="secondary">
                    Đang hiện {formatNumber(preview.issues.length)}/{formatNumber(preview.issueCount)} lỗi đầu tiên.
                  </Typography.Text>
                ) : null}
              </>
            ),
          },
          {
            key: "rows",
            label: `Dòng hợp lệ (${formatNumber(preview.validRows)})`,
            disabled: !preview.sample?.length,
            children: (
              <Table
                size="small"
                rowKey="row"
                dataSource={preview.sample ?? []}
                pagination={(preview.sample?.length ?? 0) > 8 ? { pageSize: 8, size: "small" } : false}
                columns={[
                  { title: "Dòng", dataIndex: "row", width: 64 },
                  {
                    title: "Thao tác",
                    dataIndex: "action",
                    width: 110,
                    render: (action: "create" | "update") => (
                      <Tag variant="filled" color={action === "create" ? "green" : "blue"}>
                        {action === "create" ? "Tạo mới" : "Cập nhật"}
                      </Tag>
                    ),
                  },
                  { title: "Nội dung", dataIndex: "label" },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
