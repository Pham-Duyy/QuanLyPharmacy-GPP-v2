# Máy chủ Node (Phase 7, D33). Build: docker compose build server
FROM node:24-bookworm-slim

WORKDIR /app
ENV TZ=Asia/Ho_Chi_Minh
# Lúc áp migration Prisma có thể cảnh báo "failed to detect the libssl/openssl version":
# vô hại, migration vẫn chạy (đã thử trên image này).

COPY package.json package-lock.json prisma7.config.ts ./
COPY prisma ./prisma
# Giữ cả devDependencies: lệnh bảo trì (seed, sao lưu, phục hồi, migration) chạy bằng tsx và prisma.
# postinstall chạy prisma generate nên cần schema ở trên và một DATABASE_URL giả.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm ci --no-audit --no-fund

COPY . .
# prisma generate không cần CSDL thật, chỉ cần biến có mặt.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate --config prisma7.config.ts \
  && npm run build \
  && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production \
  PORT=3000 \
  BACKUP_DIR=/backups
EXPOSE 3000
VOLUME ["/app/storage", "/backups", "/secrets"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
