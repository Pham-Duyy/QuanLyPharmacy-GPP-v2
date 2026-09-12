import { Pool } from "pg";
import { env } from "../config/env.js";

/**
 * Pool kết nối dùng chung cho toàn ứng dụng.
 * Lượt sau Prisma sẽ dùng lại chính pool này qua driver adapter,
 * nên không có hai nguồn kết nối song song.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export type DatabaseHealth = {
  ok: boolean;
  latencyMs: number;
  message?: string;
};

/** Kiểm tra CSDL còn trả lời không, dùng cho endpoint health. */
export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : "Lỗi không xác định",
    };
  }
}
