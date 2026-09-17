import { PrinterOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Modal } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "../auth/AuthProvider.js";
import { fetchPrintPage, printHtml } from "./printing.js";
import { PrintPaper } from "./PrintPaper.js";

type Props = {
  /** Đường dẫn trang in (xem `printUrl`); `null` là đóng. */
  url: string | null;
  title: string;
  onClose: () => void;
};

/** Xem trước chứng từ đã lưu đúng như khi in (cùng mẫu, cùng hàm render ở server). */
export function PrintPreviewModal({ url, title, onClose }: Props) {
  const { message } = App.useApp();
  const { storeId } = useAuth();
  const [printing, setPrinting] = useState(false);
  const page = useQuery({
    queryKey: ["print-page", storeId, url],
    enabled: url !== null,
    gcTime: 0,
    queryFn: () => fetchPrintPage(url!),
  });
  const paper = page.data?.paperSize ?? "K80";

  async function print() {
    if (!page.data) return;
    setPrinting(true);
    try {
      await printHtml(page.data.html);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không in được chứng từ"));
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Modal
      open={url !== null}
      onCancel={onClose}
      title={title}
      width={paper === "A4" ? 900 : paper === "A5" ? 680 : 440}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          Đóng
        </Button>,
        <Button key="print" type="primary" icon={<PrinterOutlined />} disabled={!page.data} loading={printing} onClick={() => void print()}>
          In
        </Button>,
      ]}
    >
      {page.isError ? (
        <Alert type="error" showIcon title={getErrorMessage(page.error, "Không tải được bản in")} />
      ) : (
        <div className="invoice-preview-body">
          <PrintPaper html={page.data?.html} paperSize={paper} loading={page.isFetching} title={title} />
        </div>
      )}
    </Modal>
  );
}
