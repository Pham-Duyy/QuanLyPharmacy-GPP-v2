#!/bin/sh
# Khởi động máy chủ trong Docker (Phase 7, D33):
#   1. Khóa bí mật: lấy từ biến môi trường, không có thì sinh một lần và giữ trong /secrets.
#   2. Áp migration (kèm kiểm tra checksum của npm run db:migrate).
#   3. Lần đầu (chưa có tài khoản nào): seed dữ liệu nền và tài khoản admin.
#   4. Tạo/đặt lại tài khoản chỉ đọc analytics_reader cho analytics-service.
set -e

secret() {
  # $1 tên biến, $2 tệp lưu. Đã đặt biến thì dùng biến; không thì đọc/sinh tệp.
  name="$1"; file="/secrets/$2"
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    if [ ! -s "$file" ]; then
      mkdir -p /secrets
      node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > "$file"
      chmod 600 "$file"
      echo "Đã sinh $name mới, lưu ở volume secrets ($file)."
    fi
    value=$(cat "$file")
    export "$name=$value"
  fi
}

secret JWT_SECRET jwt_secret
secret ANALYTICS_READER_PASSWORD analytics_reader
# analytics-service đọc mật khẩu này qua volume dùng chung.
printf '%s' "$ANALYTICS_READER_PASSWORD" > /secrets/analytics_reader
chmod 644 /secrets/analytics_reader

echo "Áp migration..."
npm run -s db:migrate

npx tsx src/scripts/docker-init.ts

exec "$@"
