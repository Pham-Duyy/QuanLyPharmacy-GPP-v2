import { useQuery } from "@tanstack/react-query";
import type { App } from "antd";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, PrintTemplateState } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

type MessageApi = ReturnType<typeof App.useApp>["message"];

export const PRINT_TEMPLATE_QUERY = "print-template";

/** Mẫu in đang áp dụng tại cửa hàng hiện tại; nhân viên bán hàng cũng đọc được. */
export function usePrintTemplate(enabled = true) {
  const { storeId } = useAuth();
  return useQuery({
    queryKey: [PRINT_TEMPLATE_QUERY, storeId],
    enabled: enabled && storeId !== null,
    queryFn: async () =>
      (await http.get<Envelope<PrintTemplateState>>("/settings/invoice-print-template")).data.data,
  });
}

/**
 * HTML in của một hóa đơn, dựng ở server theo mẫu in đã lưu (contract §14).
 * Gọi qua `http` vì endpoint cần token trong header — điều hướng trình duyệt
 * thường không kèm được. `autoprint=0` để trang không tự bật hộp thoại in;
 * việc in do `printHtml` điều khiển.
 */
export async function fetchInvoicePrintHtml(invoiceId: string): Promise<string> {
  const response = await http.get<string>(`/invoices/${invoiceId}/print`, {
    params: { autoprint: 0 },
    responseType: "text",
  });
  return response.data;
}

/**
 * In một trang HTML qua iframe ẩn: không mở tab mới nên không bị trình duyệt
 * chặn popup, và giao diện ứng dụng (menu, nút) không lẫn vào bản in.
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    Object.assign(frame.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "0",
      height: "0",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });

    const cleanup = () => {
      // Chờ một nhịp: một số trình duyệt còn đọc iframe ngay sau khi hộp thoại in đóng.
      window.setTimeout(() => frame.remove(), 1000);
      resolve();
    };

    frame.onload = () => {
      const view = frame.contentWindow;
      if (!view) {
        cleanup();
        return;
      }
      view.addEventListener("afterprint", cleanup, { once: true });
      view.focus();
      view.print();
      // Chrome chặn luồng tới khi đóng hộp thoại; Safari/Firefox có thể không bắn afterprint.
      window.setTimeout(cleanup, 60_000);
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** In (hoặc in lại) hóa đơn đã lưu. Chỉ đọc dữ liệu, không đổi hóa đơn hay tồn kho. */
export async function printInvoice(invoiceId: string, message: MessageApi): Promise<void> {
  try {
    await printHtml(await fetchInvoicePrintHtml(invoiceId));
  } catch (error) {
    void message.error(getErrorMessage(error, "Không in được hóa đơn"));
  }
}
