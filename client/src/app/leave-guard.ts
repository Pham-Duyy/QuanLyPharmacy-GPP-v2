/**
 * Chặn rời trang khi đang có thay đổi chưa lưu.
 *
 * App dùng `<BrowserRouter>` nên không có `useBlocker` của react-router
 * (chỉ chạy với data router). Thay vào đó, mọi lối điều hướng của khung
 * ứng dụng (menu, tìm nhanh, chuông thông báo, đổi cửa hàng, đăng xuất) đi
 * qua `confirmLeave`; trang nào có dữ liệu dở dang thì đăng ký một guard.
 */
type Guard = (proceed: () => void) => boolean;

let current: Guard | null = null;

/** Guard trả về true nghĩa là nó đã nhận việc hỏi người dùng và sẽ tự gọi `proceed` nếu đồng ý. */
export function registerLeaveGuard(guard: Guard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

export function confirmLeave(proceed: () => void): void {
  if (current && current(proceed)) return;
  proceed();
}
