import { useEffect, useState } from "react";

/** Giá trị chỉ cập nhật sau khi ngừng thay đổi `delay` ms — tránh gọi API mỗi lần gõ phím. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
