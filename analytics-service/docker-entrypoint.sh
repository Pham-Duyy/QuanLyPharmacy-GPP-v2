#!/bin/sh
# Chuỗi kết nối chỉ đọc dựng từ mật khẩu do máy chủ Node tạo trong volume secrets
# (xem server/docker-entrypoint.sh). Chỉ nghe trong mạng nội bộ của Docker: không
# mở cổng ra ngoài, mọi truy cập đi qua cổng /api/v1/bi của máy chủ Node.
set -e
if [ -z "${ANALYTICS_PG_DSN:-}" ]; then
  i=0
  while [ ! -s /secrets/analytics_reader ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 2; done
  password=$(cat /secrets/analytics_reader)
  export ANALYTICS_PG_DSN="postgresql://analytics_reader:${password}@${DB_HOST:-db}:5432/${DB_NAME:-pharmacy_gpp}"
fi
exec python main.py serve --host 0.0.0.0 --port 8000 --source postgres
