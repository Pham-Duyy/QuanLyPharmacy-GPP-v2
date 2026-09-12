import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
