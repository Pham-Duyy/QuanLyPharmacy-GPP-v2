import { InboxOutlined, PrinterOutlined, RollbackOutlined, SaveOutlined, ShopOutlined, SwapOutlined, UndoOutlined } from "@ant-design/icons";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, Card, Checkbox, Form, Grid, Input, Radio, Result, Segmented, Skeleton, Tag } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { DocumentPrintConfig, DocumentPrintSettings, DocumentPrintState, DocumentPrintType, Envelope, PaperSize } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { fetchPrintPage, printHtml } from "../printing/printing.js";
import { PrintPaper } from "../printing/PrintPaper.js";
import { readApiError, useUnsavedGuard } from "./settings-shared.js";

const QUERY_KEY = "document-print-settings";

const PAPER_LABEL: Record<PaperSize, string> = { A4: "A4", A5: "A5", K80: "80 mm", K58: "58 mm" };

type TypeMeta = {
  label: string;
  /** Nhãn ngắn trên thanh chọn loại phiếu. */
  short: string;
  icon: ReactNode;
  description: string;
  papers: PaperSize[];
  titles: string[];
  /** Phiếu có số tiền để đọc bằng chữ / có ghi chú riêng hay không. */
  hasAmount: boolean;
  hasNote: boolean;
};

const TYPES: Record<DocumentPrintType, TypeMeta> = {
  goodsReceipt: {
    label: "Phiếu nhập kho",
    short: "Nhập kho",
    icon: <InboxOutlined />,
    description: "In từ màn Nhập hàng: nhà cung cấp, số lô, hạn dùng, giá nhập và chữ ký kiểm nhập.",
    papers: ["A4", "A5"],
    titles: ["PHIẾU NHẬP KHO", "PHIẾU NHẬP HÀNG", "BIÊN BẢN KIỂM NHẬP"],
    hasAmount: true,
    hasNote: true,
  },
  return: {
    label: "Phiếu trả hàng",
    short: "Trả hàng",
    icon: <RollbackOutlined />,
    description: "In từ màn Trả hàng để đưa khách: hóa đơn gốc, thuốc trả, số tiền hoàn.",
    papers: ["K80", "K58", "A5", "A4"],
    titles: ["PHIẾU TRẢ HÀNG", "PHIẾU HOÀN TIỀN", "PHIẾU NHẬN HÀNG TRẢ LẠI"],
    hasAmount: true,
    hasNote: false,
  },
  stockAdjustment: {
    label: "Phiếu điều chỉnh tồn",
    short: "Điều chỉnh tồn",
    icon: <SwapOutlined />,
    description: "In từ màn Điều chỉnh tồn: tồn sổ sách, số thực tế, chênh lệch và chữ ký duyệt.",
    papers: ["A4", "A5"],
    titles: ["PHIẾU ĐIỀU CHỈNH TỒN KHO", "BIÊN BẢN KIỂM KÊ", "BIÊN BẢN XUẤT HỦY"],
    hasAmount: false,
    hasNote: false,
  },
};

const TYPE_KEYS = Object.keys(TYPES) as DocumentPrintType[];

/** Cài đặt → Kho & chứng từ → Mẫu in phiếu. */
export function DocumentTemplateSettings({ onOpenInvoiceTemplate }: { onOpenInvoiceTemplate: () => void }) {
  const { storeId } = useAuth();
  const query = useQuery({
    queryKey: [QUERY_KEY, storeId],
    enabled: storeId !== null,
    queryFn: async () => (await http.get<Envelope<DocumentPrintState>>("/settings/document-print")).data.data,
  });

  if (query.isLoading) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 10 }} />
      </Card>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <Result
          status="error"
          title="Không tải được cài đặt in phiếu"
          subTitle={getErrorMessage(query.error, "Kiểm tra kết nối rồi thử lại.")}
          extra={<Button onClick={() => void query.refetch()}>Thử lại</Button>}
        />
      </Card>
    );
  }

  return <DocumentEditor key={`${storeId}:${query.data.updatedAt ?? "default"}`} state={query.data} onOpenInvoiceTemplate={onOpenInvoiceTemplate} />;
}

function DocumentEditor({ state, onOpenInvoiceTemplate }: { state: DocumentPrintState; onOpenInvoiceTemplate: () => void }) {
  const { message } = App.useApp();
  const { me, storeId } = useAuth();
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const wide = screens.xl ?? true;
  const [draft, setDraft] = useState<DocumentPrintSettings>(state.settings);
  const [type, setType] = useState<DocumentPrintType>("goodsReceipt");
  const [mobileTab, setMobileTab] = useState<"form" | "preview">("form");
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const config = draft[type];
  const meta = TYPES[type];
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const dirtyTypes = TYPE_KEYS.filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(state.settings[key]));
  const invalidTypes = TYPE_KEYS.filter((key) => draft[key].title.trim() === "");
  const storeName = me?.stores.find((item) => item.id === storeId)?.name;

  useUnsavedGuard(dirty, "Mẫu in phiếu");

  const debounced = useDebounced(draft, 350);
  const previewable = debounced[type].title.trim() !== "";
  const preview = useQuery({
    queryKey: ["document-print-preview", storeId, type, debounced],
    enabled: previewable,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () => fetchPrintPage("/settings/document-print/preview", { type, settings: debounced }),
  });

  function change(patch: Partial<DocumentPrintConfig>) {
    setDraft((current) => ({ ...current, [type]: { ...current[type], ...patch } }));
    setServerErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[`${type}.${key}`];
      return next;
    });
  }

  function readErrors(error: unknown): string {
    const { message: text, details } = readApiError(error);
    setServerErrors(Object.fromEntries(details.map((item) => [item.field, item.message])));
    const first = details[0]?.field.split(".")[0] as DocumentPrintType | undefined;
    if (first && first in TYPES) setType(first);
    return text;
  }

  function validated(): boolean {
    if (invalidTypes.length === 0) return true;
    setType(invalidTypes[0]!);
    if (!wide) setMobileTab("form");
    void message.warning(`Phải nhập tiêu đề cho ${invalidTypes.map((key) => TYPES[key].label.toLowerCase()).join(", ")}`);
    return false;
  }

  const save = useMutation({
    mutationFn: async () => (await http.put<Envelope<DocumentPrintState>>("/settings/document-print", draft)).data.data,
    onSuccess: (saved) => {
      void message.success("Đã lưu mẫu in phiếu. Các phiếu in từ bây giờ sẽ dùng mẫu này");
      queryClient.setQueryData([QUERY_KEY, storeId], saved);
    },
    onError: (error) => void message.error(readErrors(error)),
  });

  const testPrint = useMutation({
    mutationFn: async () => printHtml((await fetchPrintPage("/settings/document-print/preview", { type, settings: draft })).html),
    onError: (error) => void message.error(readErrors(error)),
  });

  const titleError = config.title.trim() === "" ? "Phải nhập tiêu đề phiếu" : serverErrors[`${type}.title`];
  const paperError = serverErrors[`${type}.paperSize`];

  const formPanel = (
    <Card className="tpl-form-card">
      <Segmented<DocumentPrintType>
        block
        className="doc-type-tabs"
        value={type}
        onChange={setType}
        options={TYPE_KEYS.map((key) => ({
          value: key,
          label: (
            <span className="doc-type-option">
              {TYPES[key].icon}
              <span title={TYPES[key].label}>{TYPES[key].short}</span>
              {dirtyTypes.includes(key) ? <span className="doc-type-dot" aria-label="Có thay đổi chưa lưu" /> : null}
            </span>
          ),
        }))}
      />
      <p className="doc-type-desc">{meta.description}</p>

      <Alert
        type="info"
        showIcon
        className="doc-issuer-alert"
        title="Logo, tên, địa chỉ và mã số thuế lấy từ Mẫu in hóa đơn"
        description={
          <span>
            Mọi chứng từ của cửa hàng dùng chung phần đầu này.{" "}
            <Button type="link" size="small" className="inline-link" onClick={onOpenInvoiceTemplate}>
              Sửa thông tin đơn vị
            </Button>
          </span>
        }
      />

      <Form layout="vertical" requiredMark component="div">
        <div className="tpl-section-head tpl-section-divider">
          <h3>Nội dung {meta.label.toLowerCase()}</h3>
        </div>
        <div className="tpl-row2">
          <Form.Item label="Tiêu đề" required validateStatus={titleError ? "error" : undefined} help={titleError}>
            <AutoComplete
              aria-label="Tiêu đề phiếu"
              value={config.title}
              options={meta.titles.map((value) => ({ value }))}
              maxLength={80}
              onChange={(value: string) => change({ title: value })}
            />
          </Form.Item>
          <Form.Item label="Khổ giấy" validateStatus={paperError ? "error" : undefined} help={paperError}>
            <Radio.Group className="tpl-paper" value={config.paperSize} onChange={(event) => change({ paperSize: event.target.value as PaperSize })}>
              {meta.papers.map((paper) => (
                <Radio key={paper} value={paper}>
                  {PAPER_LABEL[paper]}
                </Radio>
              ))}
            </Radio.Group>
          </Form.Item>
        </div>
        <Form.Item label="Hiển thị trên phiếu" extra="Dữ liệu phiếu (thuốc, số lô, số lượng, tiền) được điền tự động khi in.">
          <div className="tpl-display-grid">
            <Checkbox checked={config.showSignatures} onChange={(event) => change({ showSignatures: event.target.checked })}>
              Ô ký tên cuối phiếu
            </Checkbox>
            {meta.hasAmount ? (
              <Checkbox checked={config.showAmountInWords} onChange={(event) => change({ showAmountInWords: event.target.checked })}>
                Số tiền bằng chữ
              </Checkbox>
            ) : null}
            {meta.hasNote ? (
              <Checkbox checked={config.showNote} onChange={(event) => change({ showNote: event.target.checked })}>
                Ghi chú của phiếu
              </Checkbox>
            ) : null}
          </div>
        </Form.Item>
        <Form.Item label="Chân trang">
          <Input.TextArea
            aria-label="Chân trang"
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={300}
            showCount
            value={config.footer}
            placeholder="VD: Lưu hồ sơ GPP. Liên hệ quản lý khi có sai lệch."
            onChange={(event) => change({ footer: event.target.value })}
          />
        </Form.Item>
      </Form>
    </Card>
  );

  const previewPanel = (
    <Card
      className="tpl-preview-card"
      title={`Xem trước ${meta.label.toLowerCase()}`}
      extra={
        <span className="tpl-preview-meta">
          {PAPER_LABEL[config.paperSize]} · Dữ liệu minh họa
        </span>
      }
    >
      {!previewable ? (
        <Alert type="warning" showIcon className="tpl-preview-alert" title="Nhập tiêu đề phiếu để xem trước." />
      ) : preview.isError ? (
        <Alert type="error" showIcon className="tpl-preview-alert" title={readApiError(preview.error).message} />
      ) : null}
      <PrintPaper html={preview.data?.html} paperSize={preview.data?.paperSize ?? config.paperSize} loading={preview.isFetching} />
      <p className="tpl-preview-note">Bản xem trước dùng dữ liệu mẫu, không tạo chứng từ nào.</p>
    </Card>
  );

  return (
    <div className="tpl-editor">
      {state.isDefault ? (
        <Alert
          type="info"
          showIcon
          className="tpl-default-alert"
          title="Đang dùng mẫu phiếu mặc định"
          description="Mọi phiếu vẫn in được ngay. Chỉnh sửa rồi bấm “Lưu mẫu in” để áp dụng riêng cho cửa hàng này."
        />
      ) : null}

      {wide ? null : (
        <Segmented
          block
          className="tpl-mobile-tabs"
          value={mobileTab}
          onChange={(value) => setMobileTab(value as "form" | "preview")}
          options={[
            { value: "form", label: "Thiết lập" },
            { value: "preview", label: "Xem trước" },
          ]}
        />
      )}

      <div className="tpl-grid">
        <div className={!wide && mobileTab !== "form" ? "tpl-pane is-hidden" : "tpl-pane"}>{formPanel}</div>
        <div className={!wide && mobileTab !== "preview" ? "tpl-pane is-hidden" : "tpl-pane tpl-pane-preview"}>{previewPanel}</div>
      </div>

      <div className="tpl-actionbar">
        <div className="tpl-scope">
          <ShopOutlined />
          <span>
            Áp dụng cho: <strong>{storeName ?? "Cửa hàng hiện tại"}</strong>
          </span>
          {dirty ? <Tag color="orange">Chưa lưu</Tag> : state.updatedAt ? <span className="tpl-updated">Lưu lúc {formatDateTime(state.updatedAt)}</span> : null}
        </div>
        <div className="tpl-actions">
          <Button
            icon={<UndoOutlined />}
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(state.settings);
              setServerErrors({});
            }}
          >
            <span className="label-long">Hủy thay đổi</span>
            <span className="label-short">Hủy</span>
          </Button>
          <Button icon={<PrinterOutlined />} loading={testPrint.isPending} onClick={() => validated() && testPrint.mutate()}>
            In thử
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} disabled={!dirty && !state.isDefault} onClick={() => validated() && save.mutate()}>
            <span className="label-long">Lưu mẫu in</span>
            <span className="label-short">Lưu</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
