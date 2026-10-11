import { useRef } from "react";

/**
 * Khóa Idempotency-Key cho một lần ghi chứng từ (contract §2.3). Cùng nội
 * dung thì giữ nguyên khóa: bấm lại sau khi mạng chập chờn, máy chủ trả lại
 * kết quả lần trước thay vì ghi thêm một chứng từ. Đổi nội dung thì sinh khóa
 * mới. Gọi `done()` khi đã ghi xong để lần gửi sau là một chứng từ mới.
 */
export function useSubmitKey() {
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  return {
    headers(...content: unknown[]): { "Idempotency-Key": string } {
      const signature = JSON.stringify(content);
      if (attempt.current?.signature !== signature) {
        attempt.current = { signature, key: crypto.randomUUID() };
      }
      return { "Idempotency-Key": attempt.current.key };
    },
    done(): void {
      attempt.current = null;
    },
  };
}
