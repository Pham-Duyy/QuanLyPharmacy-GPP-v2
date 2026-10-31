# Giao diện (Phase 7, D33): build bằng Node, phục vụ bằng nginx.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Chỉ đóng gói. Kiểm tra kiểu (npm run build = tsc -b + vite build) chạy lúc phát triển:
# vài tệp test import mã của server, không có trong ngữ cảnh build này.
RUN npx vite build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
