import { DeleteOutlined, InfoCircleOutlined, PictureOutlined, PrinterOutlined, SaveOutlined, ShopOutlined, UndoOutlined, UploadOutlined } from "@ant-design/icons";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, Card, Checkbox, Form, Grid, Input, Radio, Result, Segmented, Skeleton, Tag, Upload } from "antd";
import { AxiosError } from "axios";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, PaperSize, PrintTemplate, PrintTemplateState } from "../../api/types.js";
import { registerLeaveGuard } from "../../app/leave-guard.js";
import { formatDateTime } from "../../ui/format.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { PRINT_TEMPLATE_QUERY, printHtml, usePrintTemplate } from "../sales/print-invoice.js";
import { PrintPaper } from "../sales/PrintPaper.js";

const MAX_LOGO_BYTES = 300 * 1024;

const PAPER_OPTIONS: Array<{ value: PaperSize; label: string; hint: string }> = [
  { value: "K80", label: "80 mm", hint: "Máy in nhiệt phổ biến" },
  { value: "K58", label: "58 mm", hint: "Máy in nhiệt mini" },
  { value: "A5", label: "A5", hint: "Máy in văn phòng" },
];

const DISPLAY_OPTIONS: Array<{ key: keyof PrintTemplate["display"]; label: string }> = [
  { key: "logo", label: "Logo" },
  { key: "customer", label: "Khách hàng" },
  { key: "seller", label: "Nhân viên bán hàng" },
  { key: "unit", label: "Đơn vị tính" },
  { key: "discount", label: "Chiết khấu" },
  { key: "paymentMethod", label: "Phương thức thanh toán" },
  { key: "cashChange", label: "Khách đưa & tiền thừa" },
];

const TITLE_SUGGESTIONS = ["HÓA ĐƠN BÁN HÀNG", "HÓA ĐƠN BÁN LẺ", "PHIẾU THANH TOÁN"].map((value) => ({ value }));

type Sample = "standard" | "long" | "walk_in";

async function renderPreview(template: PrintTemplate, sample: Sample): Promise<string> {
  const response = await http.post<string>(
    "/settings/invoice-print-template/preview",
    { template, sample },
    { responseType: "text" },
  );
  return response.data;
}

/** Lỗi trả về khi gọi với responseType "text" vẫn là JSON dạng chuỗi — đọc lại để lấy đúng thông điệp. */
function readApiError(error: unknown): { message: string; details: Array<{ field: string; message: string }> } {
  if (error instanceof AxiosError && typeof error.response?.data === "string") {
    try {
      const payload = JSON.parse(error.response.data) as { error?: { message?: string; details?: Array<{ field: string; message: string }> } };
      return { message: payload.error?.message ?? error.message, details: payload.error?.details ?? [] };
    } catch {
      return { message: error.message, details: [] };
    }
  }
  const payload = error instanceof AxiosError ? (error.response?.data as { error?: { details?: Array<{ field: string; message: string }> } } | undefined) : undefined;
  return { message: getErrorMessage(error, "Có lỗi xảy ra"), details: payload?.error?.details ?? [] };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Không đọc được tệp"));
    reader.readAsDataURL(file);
  });
}

/** Ô chọn logo: tải lên, đổi, gỡ. Chỉ nhận PNG/JPG ≤ 300 KB; server kiểm tra lại theo nội dung tệp. */
function LogoField({ value, onChange }: { value?: string | null; onChange?: (value: string | null) => void }) {
  const { message } = App.useApp();

  async function pick(file: File) {
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      void message.error("Logo phải là ảnh PNG hoặc JPG");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      void message.error("Logo quá lớn, tối đa 300 KB. Hãy thu nhỏ ảnh rồi tải lại");
      return;
    }
    try {
      onChange?.(await readAsDataUrl(file));
    } catch {
      void message.error("Không đọc được tệp ảnh");
    }
  }

  const uploader = (children: ReactNode) => (
    <Upload
      accept="image/png,image/jpeg"
      showUploadList={false}
      beforeUpload={(file) => {
        void pick(file);
        return false;
      }}
    >
      {children}
    </Upload>
  );

  return (
    <div className="logo-field">
      {value ? (
        <>
          <div className="logo-field-box has-logo">
            <img src={value} alt="Logo nhà thuốc" />
          </div>
          <div className="logo-field-actions">
            {uploader(
              <Button size="small" icon={<UploadOutlined />}>
                Đổi
              </Button>,
            )}
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onChange?.(null)} aria-label="Gỡ logo" />
          </div>
        </>
      ) : (
        uploader(
          <button type="button" className="logo-field-box">
            <PictureOutlined />
            <span>Tải logo</span>
          </button>,
        )
      )}
      <small>PNG, JPG · tối đa 300 KB</small>
    </div>
  );
}

/** Cài đặt → Bán hàng & hóa đơn → Mẫu in hóa đơn. */
export function InvoiceTemplateSettings() {
  const { storeId } = useAuth();
  const query = usePrintTemplate();

  if (query.isLoading) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 12 }} />
      </Card>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <Result
          status="error"
          title="Không tải được mẫu in"
          subTitle={getErrorMessage(query.error, "Kiểm tra kết nối rồi thử lại.")}
          extra={<Button onClick={() => void query.refetch()}>Thử lại</Button>}
        />
      </Card>
    );
  }

  // Đổi key sau mỗi lần lưu (hoặc khi đổi cửa hàng) để trình chỉnh sửa lấy bản đã lưu làm mốc so sánh mới.
  return <TemplateEditor key={`${storeId}:${query.data.updatedAt ?? "default"}`} state={query.data} />;
}

function TemplateEditor({ state }: { state: PrintTemplateState }) {
  const { message, modal } = App.useApp();
  const { me, storeId } = useAuth();
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const wide = screens.xl ?? true;
  const [form] = Form.useForm<PrintTemplate>();
  const [draft, setDraft] = useState<PrintTemplate>(state.template);
  const [mobileTab, setMobileTab] = useState<"form" | "preview">("form");
  const [sample, setSample] = useState<Sample>("standard");

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.template);
  const storeName = me?.stores.find((item) => item.id === storeId)?.name;

  // Xem trước dùng đúng hàm render của in thật ở server, với dữ liệu mẫu.
  const debounced = useDebounced(draft, 350);
  const previewable = debounced.storeName.trim() !== "" && debounced.title.trim() !== "";
  const preview = useQuery({
    queryKey: ["print-template-preview", storeId, sample, debounced],
    enabled: previewable,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () => renderPreview(debounced, sample),
  });

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    const unregister = registerLeaveGuard((proceed) => {
      modal.confirm({
        title: "Mẫu in chưa được lưu",
        content: "Các thay đổi trên mẫu in hóa đơn sẽ bị bỏ nếu rời trang. Bạn vẫn muốn rời đi?",
        okText: "Rời trang, bỏ thay đổi",
        okButtonProps: { danger: true },
        cancelText: "Ở lại",
        onOk: proceed,
      });
      return true;
    });
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      unregister();
    };
  }, [dirty, modal]);

  function applyServerErrors(error: unknown): string {
    const { message: text, details } = readApiError(error);
    if (details.length > 0) {
      form.setFields(
        details.map((item) => ({
          name: item.field.split(".") as never,
          errors: [item.message],
        })),
      );
    }
    return text;
  }

  const save = useMutation({
    mutationFn: async (template: PrintTemplate) =>
      (await http.put<Envelope<PrintTemplateState>>("/settings/invoice-print-template", template)).data.data,
    onSuccess: (saved) => {
      void message.success("Đã lưu mẫu in. Các hóa đơn in từ bây giờ sẽ dùng mẫu này");
      queryClient.setQueryData([PRINT_TEMPLATE_QUERY, storeId], saved);
    },
    onError: (error) => void message.error(applyServerErrors(error)),
  });

  const testPrint = useMutation({
    mutationFn: async (template: PrintTemplate) => printHtml(await renderPreview(template, sample)),
    onError: (error) => void message.error(applyServerErrors(error)),
  });

  async function validated(): Promise<PrintTemplate | null> {
    try {
      await form.validateFields();
      return draft;
    } catch {
      if (!wide) setMobileTab("form");
      void message.warning("Kiểm tra lại các trường được đánh dấu đỏ");
      return null;
    }
  }

  function discard() {
    form.resetFields();
    setDraft(state.template);
  }

  const paperLabel = PAPER_OPTIONS.find((item) => item.value === draft.paperSize)?.label;

  const formPanel = (
    <Card className="tpl-form-card">
      <Form<PrintTemplate>
        form={form}
        layout="vertical"
        requiredMark
        initialValues={state.template}
        onValuesChange={(_, all) => setDraft({ ...state.template, ...all, display: { ...state.template.display, ...all.display } })}
      >
        <div className="tpl-section-head">
          <h3>1. Thông tin cố định</h3>
          <Tag color="blue">Dùng cho mọi hóa đơn</Tag>
        </div>
        <div className="tpl-identity">
          <div className="tpl-identity-fields">
            <Form.Item name="companyName" label="Tên công ty / hộ kinh doanh">
              <Input placeholder="VD: Hộ kinh doanh Nhà thuốc Minh An" maxLength={150} />
            </Form.Item>
            <Form.Item name="storeName" label="Tên nhà thuốc" rules={[{ required: true, whitespace: true, message: "Phải nhập tên nhà thuốc" }]}>
              <Input maxLength={150} />
            </Form.Item>
          </div>
          <Form.Item name="logo" label="Logo (tùy chọn)" className="tpl-logo-item">
            <LogoField />
          </Form.Item>
        </div>
        <Form.Item name="address" label="Địa chỉ">
          <Input maxLength={250} placeholder="Số nhà, đường, phường/xã, tỉnh/thành" />
        </Form.Item>
        <div className="tpl-row2">
          <Form.Item name="phone" label="Số điện thoại" rules={[{ pattern: /^[0-9 +().-]*$/, message: "Số điện thoại không hợp lệ" }]}>
            <Input maxLength={30} inputMode="tel" />
          </Form.Item>
          <Form.Item name="taxCode" label="Mã số thuế (nếu có)" rules={[{ pattern: /^[0-9-]*$/, message: "Chỉ gồm chữ số và dấu gạch ngang" }]}>
            <Input maxLength={20} placeholder="Nhập mã số thuế" inputMode="numeric" />
          </Form.Item>
        </div>

        <div className="tpl-section-head tpl-section-divider">
          <h3>2. Nội dung bản in</h3>
        </div>
        <div className="tpl-row2">
          <Form.Item name="title" label="Tiêu đề" rules={[{ required: true, whitespace: true, message: "Phải nhập tiêu đề" }]}>
            <AutoComplete options={TITLE_SUGGESTIONS} maxLength={80} />
          </Form.Item>
          <Form.Item name="paperSize" label="Khổ giấy">
            <Radio.Group className="tpl-paper">
              {PAPER_OPTIONS.map((option) => (
                <Radio key={option.value} value={option.value} title={option.hint}>
                  {option.label}
                </Radio>
              ))}
            </Radio.Group>
          </Form.Item>
        </div>
        <Form.Item label="Hiển thị trên hóa đơn" className="tpl-display" extra={<><InfoCircleOutlined /> Dữ liệu đơn bán (thuốc, số lượng, tiền) được điền tự động khi in. Mục tắt hoặc để trống sẽ không in ra.</>}>
          <div className="tpl-display-grid">
            {DISPLAY_OPTIONS.map((option) => (
              <Form.Item key={option.key} name={["display", option.key]} valuePropName="checked" noStyle>
                <Checkbox>{option.label}</Checkbox>
              </Form.Item>
            ))}
          </div>
        </Form.Item>
        <Form.Item name="footer" label="Lời cảm ơn / chân trang">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={300} showCount placeholder="VD: Cảm ơn quý khách! Vui lòng giữ hóa đơn để đối chiếu." />
        </Form.Item>
      </Form>
    </Card>
  );

  const previewPanel = (
    <Card
      className="tpl-preview-card"
      title="Xem trước bản in"
      extra={
        <span className="tpl-preview-meta">
          {paperLabel} · Dữ liệu minh họa
        </span>
      }
    >
      <Segmented<Sample>
        size="small"
        block
        value={sample}
        onChange={setSample}
        options={[
          { value: "standard", label: "Đơn thường" },
          { value: "long", label: "Nhiều thuốc, tên dài" },
          { value: "walk_in", label: "Khách lẻ" },
        ]}
      />
      {!previewable ? (
        <Alert type="warning" showIcon className="tpl-preview-alert" title="Nhập tên nhà thuốc và tiêu đề để xem trước." />
      ) : preview.isError ? (
        <Alert type="error" showIcon className="tpl-preview-alert" title={readApiError(preview.error).message} />
      ) : null}
      <PrintPaper html={preview.data} paperSize={debounced.paperSize} loading={preview.isFetching} />
      <p className="tpl-preview-note">Tên thuốc dài tự xuống dòng. Bản xem trước không tạo giao dịch nào.</p>
    </Card>
  );

  return (
    <div className="tpl-editor">
      {state.isDefault ? (
        <Alert
          type="info"
          showIcon
          className="tpl-default-alert"
          title="Đang dùng mẫu mặc định"
          description="Thông tin được lấy từ hồ sơ cửa hàng. Chỉnh sửa rồi bấm “Lưu mẫu in” để áp dụng chính thức cho cửa hàng này."
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
          <Button icon={<UndoOutlined />} disabled={!dirty || save.isPending} onClick={discard}>
            <span className="label-long">Hủy thay đổi</span>
            <span className="label-short">Hủy</span>
          </Button>
          <Button
            icon={<PrinterOutlined />}
            loading={testPrint.isPending}
            onClick={async () => {
              const template = await validated();
              if (template) testPrint.mutate(template);
            }}
          >
            In thử
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={save.isPending}
            disabled={!dirty && !state.isDefault}
            onClick={async () => {
              const template = await validated();
              if (template) save.mutate(template);
            }}
          >
            <span className="label-long">Lưu mẫu in</span>
            <span className="label-short">Lưu</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
