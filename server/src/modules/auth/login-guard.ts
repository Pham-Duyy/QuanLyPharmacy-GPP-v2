import { AppError } from "../../lib/app-error.js";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 20;
const SWEEP_ABOVE = 10_000;

/**
 * Chặn dò mật khẩu từ một máy (contract §3): quá 20 lần đăng nhập sai trong
 * 15 phút từ cùng một địa chỉ IP thì tạm không nhận đăng nhập từ IP đó, kể cả
 * đúng mật khẩu. Bổ sung cho mức chờ tăng dần theo tài khoản, vì kẻ dò có thể
 * thử mỗi tài khoản vài lần để né mức chờ đó. Đếm trong bộ nhớ: đủ cho một
 * máy chủ, khởi động lại thì đếm lại từ đầu.
 */
export function createLoginGuard(now: () => number = Date.now) {
  const failures = new Map<string, number[]>();

  function recent(ip: string): number[] {
    const list = (failures.get(ip) ?? []).filter((at) => now() - at < WINDOW_MS);
    if (list.length) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  }

  return {
    assertAllowed(ip: string): void {
      const list = recent(ip);
      if (list.length < MAX_FAILURES) return;
      const minutes = Math.max(1, Math.ceil((WINDOW_MS - (now() - list[0]!)) / 60_000));
      throw new AppError(
        429,
        "RATE_LIMITED",
        `Đăng nhập sai quá nhiều lần từ máy này, vui lòng thử lại sau ${minutes} phút`,
      );
    },
    recordFailure(ip: string): void {
      failures.set(ip, [...recent(ip), now()]);
      // Nhiều IP khác nhau thì dọn các IP đã hết hạn, không để bộ nhớ phình mãi.
      if (failures.size > SWEEP_ABOVE) for (const key of [...failures.keys()]) recent(key);
    },
  };
}
