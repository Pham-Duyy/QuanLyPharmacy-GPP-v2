import { message } from "antd";
import { getErrorMessage, http } from "../../api/http.js";

/**
 * Mở trang in hóa đơn ở tab mới (contract §14, `GET /invoices/{id}/print`).
 *
 * Không dùng thẻ `<a href>` vì endpoint cần token đăng nhập gắn trong
 * header, mà điều hướng trình duyệt thường không kèm được header tùy chỉnh
 * — nên gọi qua `http` (đã tự đính token) rồi đổ HTML nhận về vào một cửa
 * sổ mới. Trang trả về tự gọi `window.print()` khi tải xong.
 */
export async function printInvoice(invoiceId: string, format: "k80" | "a5"): Promise<void> {
  try {
    const response = await http.get<string>(`/invoices/${invoiceId}/print`, {
      params: { format },
      responseType: "text",
    });
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      void message.error("Trình duyệt đã chặn cửa sổ in, hãy cho phép popup rồi thử lại");
      return;
    }
    printWindow.document.write(response.data);
    printWindow.document.close();
  } catch (error) {
    void message.error(getErrorMessage(error, "Không in được hóa đơn"));
  }
}
