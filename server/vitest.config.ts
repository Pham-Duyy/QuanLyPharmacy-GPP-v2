import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Kiểm thử tích hợp chạy trên CSDL thật (pharmacy_gpp_test), không dùng mock,
    // vì phần lớn quy tắc quan trọng nằm ở ràng buộc của PostgreSQL.
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    // Các test dùng chung một CSDL nên chạy tuần tự, tránh xóa dữ liệu của nhau.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
