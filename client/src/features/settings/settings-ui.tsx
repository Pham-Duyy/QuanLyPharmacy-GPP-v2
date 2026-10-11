import { PrinterOutlined, SaveOutlined, ShopOutlined, UndoOutlined } from "@ant-design/icons";
import type { UseQueryResult } from "@tanstack/react-query";
import { Alert, Button, Card, Result, Segmented, Skeleton, Tag } from "antd";
import type { ReactNode } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatDateTime } from "../../ui/format.js";

/** Khung chờ tải và báo lỗi chung của các trang cài đặt; có dữ liệu mới vẽ nội dung. */
export function SettingsGate<T>({
  query,
  rows,
  errorTitle,
  children,
}: {
  query: UseQueryResult<T>;
  rows: number;
  errorTitle: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows }} />
      </Card>
    );
  }
  if (query.isError || query.data === undefined || query.data === null) {
    return (
      <Card>
        <Result
          status="error"
          title={errorTitle}
          subTitle={getErrorMessage(query.error, "Kiểm tra kết nối rồi thử lại.")}
          extra={<Button onClick={() => void query.refetch()}>Thử lại</Button>}
        />
      </Card>
    );
  }
  return <>{children(query.data)}</>;
}

export type MobileTab = "form" | "preview";

/**
 * Bố cục chung của trình chỉnh sửa mẫu in: thiết lập bên trái, xem trước bên
 * phải (màn hẹp thì chuyển qua lại bằng tab), thanh lưu ở dưới.
 */
export function TemplateEditorLayout(props: {
  defaultNotice: { title: string; description?: string } | null;
  wide: boolean;
  mobileTab: MobileTab;
  onMobileTab: (tab: MobileTab) => void;
  formPanel: ReactNode;
  previewPanel: ReactNode;
  storeName: string | undefined;
  dirty: boolean;
  updatedAt: string | null;
  canSave: boolean;
  saving: boolean;
  testPrinting: boolean;
  onDiscard: () => void;
  onTestPrint: () => void;
  onSave: () => void;
}) {
  const { wide, mobileTab, dirty } = props;
  return (
    <div className="tpl-editor">
      {props.defaultNotice ? (
        <Alert
          type="info"
          showIcon
          className="tpl-default-alert"
          title={props.defaultNotice.title}
          description={props.defaultNotice.description}
        />
      ) : null}

      {wide ? null : (
        <Segmented
          block
          className="tpl-mobile-tabs"
          value={mobileTab}
          onChange={(value) => props.onMobileTab(value as MobileTab)}
          options={[
            { value: "form", label: "Thiết lập" },
            { value: "preview", label: "Xem trước" },
          ]}
        />
      )}

      <div className="tpl-grid">
        <div className={!wide && mobileTab !== "form" ? "tpl-pane is-hidden" : "tpl-pane"}>
          {props.formPanel}
        </div>
        <div
          className={
            !wide && mobileTab !== "preview" ? "tpl-pane is-hidden" : "tpl-pane tpl-pane-preview"
          }
        >
          {props.previewPanel}
        </div>
      </div>

      <div className="tpl-actionbar">
        <div className="tpl-scope">
          <ShopOutlined />
          <span>
            Áp dụng cho: <strong>{props.storeName ?? "Cửa hàng hiện tại"}</strong>
          </span>
          {dirty ? (
            <Tag color="orange">Chưa lưu</Tag>
          ) : props.updatedAt ? (
            <span className="tpl-updated">Lưu lúc {formatDateTime(props.updatedAt)}</span>
          ) : null}
        </div>
        <div className="tpl-actions">
          <Button
            icon={<UndoOutlined />}
            disabled={!dirty || props.saving}
            onClick={props.onDiscard}
          >
            <span className="label-long">Hủy thay đổi</span>
            <span className="label-short">Hủy</span>
          </Button>
          <Button
            icon={<PrinterOutlined />}
            loading={props.testPrinting}
            onClick={props.onTestPrint}
          >
            In thử
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={props.saving}
            disabled={!props.canSave}
            onClick={props.onSave}
          >
            <span className="label-long">Lưu mẫu in</span>
            <span className="label-short">Lưu</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
