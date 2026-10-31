# analytics-service (Phase 7, D33): đọc CSDL phần mềm qua tài khoản chỉ đọc analytics_reader.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  TZ=Asia/Ho_Chi_Minh \
  ANALYTICS_SOURCE=postgres

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p data/inbox && chmod +x docker-entrypoint.sh
VOLUME ["/app/data"]
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/analytics/version', timeout=4).status == 200 else 1)"

ENTRYPOINT ["./docker-entrypoint.sh"]
