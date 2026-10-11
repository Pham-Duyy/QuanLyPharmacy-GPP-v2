import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Thư viện nền ít đổi tách thành gói riêng: không gói nào vượt 500 kB,
        // và cập nhật phần mềm thì trình duyệt vẫn dùng lại bản đã lưu đệm.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    // Gọi /api/... như cùng một địa chỉ với backend: tránh lỗi CORS khi phát
    // triển, và cookie refresh token (SameSite=Strict) vẫn hoạt động.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
