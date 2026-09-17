import { PrinterOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Modal } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { fetchInvoicePrintHtml, printHtml, usePrintTemplate } from "./print-invoice.js";
import { PrintPaper } from "./PrintPaper.js";

type Props = { invoiceId: string | null; code?: string; onClose: () => void };

/** Xem trước hóa đơn đã lưu đúng như khi in (cùng mẫu in, cùng hàm render ở server). */
export function InvoicePrintPreview({ invoiceId, code, onClose }: Props) {
  const { message } = App.useApp();
  const template = usePrintTemplate(invoiceId !== null);
  const [printing, setPrinting] = useState(false);
  const html = useQuery({
    queryKey: ["invoice-print-html", invoiceId, template.data?.updatedAt],
    enabled: invoiceId !== null,
    queryFn: () => fetchInvoicePrintHtml(invoiceId!),
  });

  async function print() {
    if (!html.data) return;
    setPrinting(true);
    try {
      await printHtml(html.data);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không in được hóa đơn"));
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Modal
      open={invoiceId !== null}
      onCancel={onClose}
      title={code ? `Xem trước hóa đơn ${code}` : "Xem trước hóa đơn"}
      width={template.data?.template.paperSize === "A5" ? 680 : 440}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          Đóng
        </Button>,
        <Button key="print" type="primary" icon={<PrinterOutlined />} disabled={!html.data} loading={printing} onClick={() => void print()}>
          In lại
        </Button>,
      ]}
    >
      {html.isError ? (
        <Alert type="error" showIcon title={getErrorMessage(html.error, "Không tải được bản in")} />
      ) : (
        <div className="invoice-preview-body">
          <PrintPaper html={html.data} paperSize={template.data?.template.paperSize ?? "K80"} loading={html.isLoading || template.isLoading} title="Bản in hóa đơn" />
        </div>
      )}
    </Modal>
  );
}
