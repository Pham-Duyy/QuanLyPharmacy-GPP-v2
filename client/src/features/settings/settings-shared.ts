import { App } from "antd";
import { AxiosError } from "axios";
import { useEffect } from "react";
import { getErrorMessage } from "../../api/http.js";
import { registerLeaveGuard } from "../../app/leave-guard.js";

/**
 * Khi còn thay đổi chưa lưu: hỏi lại trước khi rời trang trong ứng dụng
 * (menu, tìm nhanh, đổi cửa hàng…) và bật cảnh báo của trình duyệt khi tải
 * lại hoặc đóng tab.
 */
export function useUnsavedGuard(dirty: boolean, what: string): void {
  const { modal } = App.useApp();

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    const unregister = registerLeaveGuard((proceed) => {
      modal.confirm({
        title: `${what} chưa được lưu`,
        content: `Các thay đổi trên ${what.toLowerCase()} sẽ bị bỏ nếu rời trang. Bạn vẫn muốn rời đi?`,
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
  }, [dirty, modal, what]);
}

export type ApiFieldError = { field: string; message: string };

/** Lỗi trả về khi gọi với responseType "text" vẫn là JSON dạng chuỗi — đọc lại để lấy đúng thông điệp. */
export function readApiError(error: unknown): { message: string; details: ApiFieldError[] } {
  if (error instanceof AxiosError && typeof error.response?.data === "string") {
    try {
      const payload = JSON.parse(error.response.data) as { error?: { message?: string; details?: ApiFieldError[] } };
      return { message: payload.error?.message ?? error.message, details: payload.error?.details ?? [] };
    } catch {
      return { message: error.message, details: [] };
    }
  }
  const payload = error instanceof AxiosError ? (error.response?.data as { error?: { details?: ApiFieldError[] } } | undefined) : undefined;
  return { message: getErrorMessage(error, "Có lỗi xảy ra"), details: payload?.error?.details ?? [] };
}
