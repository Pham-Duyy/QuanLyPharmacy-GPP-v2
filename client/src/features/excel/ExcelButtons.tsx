import { FileExcelOutlined, UploadOutlined } from "@ant-design/icons";
import { App, Button, Dropdown, Tooltip } from "antd";
import { useState } from "react";
import { downloadExport, type ExportType } from "./excel-api.js";

type ExportProps = {
  type: ExportType;
  label?: string;
  range?: { from?: string; to?: string };
  tooltip?: string;
};

export function ExcelExportButton({ type, label = "Xuất Excel", range, tooltip }: ExportProps) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      await downloadExport(type, range);
      void message.success("Đã xuất tệp Excel");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không xuất được tệp");
    } finally {
      setLoading(false);
    }
  }

  const button = (
    <Button icon={<FileExcelOutlined />} loading={loading} onClick={() => void run()}>
      {label}
    </Button>
  );
  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button;
}

type MenuProps = {
  onImport?: () => void;
  exportType?: ExportType;
  range?: { from?: string; to?: string };
  importLabel?: string;
  exportLabel?: string;
};

/** Một nút "Excel" gom nhập và xuất cho các trang danh mục, đỡ chật thanh công cụ. */
export function ExcelMenuButton({ onImport, exportType, range, importLabel = "Nhập từ Excel", exportLabel = "Xuất ra Excel" }: MenuProps) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  async function runExport() {
    if (!exportType) return;
    setLoading(true);
    try {
      await downloadExport(exportType, range);
      void message.success("Đã xuất tệp Excel");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không xuất được tệp");
    } finally {
      setLoading(false);
    }
  }

  const items = [
    ...(onImport ? [{ key: "import", icon: <UploadOutlined />, label: importLabel }] : []),
    ...(exportType ? [{ key: "export", icon: <FileExcelOutlined />, label: exportLabel }] : []),
  ];
  if (items.length === 0) return null;

  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === "import") onImport?.();
          else void runExport();
        },
      }}
    >
      <Button icon={<FileExcelOutlined />} loading={loading}>
        Excel
      </Button>
    </Dropdown>
  );
}
