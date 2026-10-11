/**
 * Lịch thử lại của các hàng đợi gửi lên hệ thống bên ngoài (CSDL Dược, hóa
 * đơn điện tử, đơn thuốc quốc gia): giãn dần, không thử lại dồn dập; quá bậc
 * cuối thì giữ bậc cuối. `capMinutes` để hàng đợi cần gửi sớm đặt trần thấp hơn.
 */
const BACKOFF_MINUTES = [1, 5, 15, 60, 6 * 60, 24 * 60];

export function nextAttemptAt(attempts: number, capMinutes = 24 * 60): Date {
  const step = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]!;
  return new Date(Date.now() + Math.min(step, capMinutes) * 60_000);
}
