import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Máy chủ chạy tại http://localhost:${env.PORT}/api/v1 (môi trường ${env.NODE_ENV})`);
});

/** Dừng gọn gàng: đóng server rồi đóng pool kết nối CSDL. */
async function shutdown(signal: string): Promise<void> {
  console.log(`Nhận tín hiệu ${signal}, đang dừng máy chủ...`);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
