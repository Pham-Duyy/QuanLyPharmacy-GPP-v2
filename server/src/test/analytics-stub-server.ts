import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Máy chủ giả đóng vai analytics-service (Python) cho test cổng `/api/v1/bi`.
 * Trả lời theo bảng `routes`; ghi lại mọi đường dẫn đã gọi để test kiểm tra
 * cổng đã chuyển tiếp đúng tham số.
 */
export type AnalyticsStub = {
  baseUrl: string;
  /** Đường dẫn kèm query, ví dụ "/api/analytics/summary?store=NT01". */
  requests: string[];
  /** Ghi đè phản hồi của một endpoint (tên sau /api/analytics/). */
  respond: (name: string, status: number, body: unknown) => void;
  close: () => Promise<void>;
};

export async function startAnalyticsStub(initial: Record<string, unknown>): Promise<AnalyticsStub> {
  const routes = new Map<string, { status: number; body: unknown }>(
    Object.entries(initial).map(([name, body]) => [name, { status: 200, body }]),
  );
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const name = new URL(req.url ?? "/", "http://stub").pathname.replace("/api/analytics/", "");
    const route = routes.get(name) ?? { status: 404, body: { detail: "Not Found" } };
    res.writeHead(route.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    respond: (name, status, body) => routes.set(name, { status, body }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
