import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Máy chủ giả mô phỏng API Hệ thống CSDL về Dược theo đúng đặc tả v1.1.
 *
 * Nằm trong `src/test` cùng chỗ với các tiện ích kiểm thử khác: không có
 * đường nào từ `app.ts` dẫn tới đây, nên mã mô phỏng lỗi không thể chạy
 * trong môi trường thật.
 *
 * Mô phỏng đủ những chỗ dễ làm phần mềm sai:
 *   - bắt buộc form-urlencoded và mật khẩu base64 khi đăng nhập;
 *   - token hết hạn trả 401 để kiểm tra việc tự đăng nhập lại;
 *   - phân trang danh mục;
 *   - xử lý bất đồng bộ: gửi xong chỉ trả transaction_id, trạng thái đổi dần.
 */

export type StubOptions = {
  username: string;
  password: string;
  units: Array<{ id: string; name: string }>;
  drugs: unknown[];
  pageSize?: number;
};

export type StubServer = {
  baseUrl: string;
  close: () => Promise<void>;
  /** Mọi yêu cầu đã nhận, để test khẳng định phần mềm gửi đúng cái gì. */
  requests: Array<{ method: string; path: string; body: unknown; authorization: string | null }>;
  submissions: Map<string, { kind: string; payload: unknown; status: string }>;
  /** Buộc N lần gọi tiếp theo (trừ đăng nhập) trả về mã lỗi này. */
  failNext: (times: number, status: number) => void;
  /** Làm token đang phát hết hiệu lực, lần gọi sau sẽ nhận 401. */
  expireTokens: () => void;
  setStatus: (transactionId: string, status: string, messages?: string[]) => void;
  loginCount: () => number;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export async function startStubServer(options: StubOptions): Promise<StubServer> {
  const pageSize = options.pageSize ?? 50;
  const requests: StubServer["requests"] = [];
  const submissions = new Map<string, { kind: string; payload: unknown; status: string }>();
  const messagesByTransaction = new Map<string, string[]>();
  const validTokens = new Set<string>();

  let tokenCounter = 0;
  let loginCount = 0;
  let failTimes = 0;
  let failStatus = 500;

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stub.local");
      const raw = await readBody(req);
      const authorization = req.headers.authorization ?? null;

      let parsedBody: unknown = raw;
      if (raw && (req.headers["content-type"] ?? "").includes("json")) {
        try {
          parsedBody = JSON.parse(raw) as unknown;
        } catch {
          parsedBody = raw;
        }
      }
      requests.push({ method: req.method ?? "GET", path: url.pathname, body: parsedBody, authorization });

      // --- Đăng nhập ---
      if (url.pathname === "/v2/auth/login" && req.method === "POST") {
        loginCount += 1;
        if (!(req.headers["content-type"] ?? "").includes("x-www-form-urlencoded")) {
          return json(res, 400, { message: "Content-Type phải là x-www-form-urlencoded" });
        }
        const form = new URLSearchParams(raw);
        const username = form.get("username");
        const password = form.get("password");
        if (!username || !password) return json(res, 400, { message: "Thiếu username hoặc password" });

        // Đặc tả: mật khẩu gửi lên đã mã hóa base64.
        const decoded = Buffer.from(password, "base64").toString("utf8");
        if (username !== options.username || decoded !== options.password) {
          return json(res, 401, { message: "Sai tài khoản hoặc mật khẩu" });
        }

        tokenCounter += 1;
        const token = `stub-token-${tokenCounter}`;
        validTokens.add(token);
        return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
      }

      // --- Các API còn lại đều cần token ---
      const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
      if (!validTokens.has(token)) return json(res, 401, { message: "Token không hợp lệ" });

      if (failTimes > 0) {
        failTimes -= 1;
        return json(res, failStatus, { message: `Lỗi mô phỏng ${failStatus}` });
      }

      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Math.min(Number(url.searchParams.get("page_size") ?? pageSize), pageSize);
      const slice = <T>(all: T[]): { page: number; total: number; data: T[] } => ({
        page,
        total: all.length,
        data: all.slice((page - 1) * size, page * size),
      });

      if (url.pathname === "/v2/master/units") return json(res, 200, slice(options.units));
      if (url.pathname === "/v2/master/drugs") return json(res, 200, slice(options.drugs));

      const submitMatch = url.pathname.match(/^\/v2\/transactions\/(stock-in|stock-out|stock-taking)$/);
      if (submitMatch && req.method === "POST") {
        const body = parsedBody as { reference_number?: string; items?: unknown[] };
        if (!body?.reference_number) {
          return json(res, 400, { message: "Thiếu reference_number" });
        }
        // Đặc tả: sửa chứng từ là gửi lại cùng reference_number.
        const transactionId = `tx-${submitMatch[1]}-${body.reference_number}`;
        submissions.set(transactionId, {
          kind: submitMatch[1]!,
          payload: parsedBody,
          status: "accepted",
        });
        return json(res, 200, { transaction_id: transactionId, status: "accepted" });
      }

      const statusMatch = url.pathname.match(
        /^\/v2\/transactions?\/(stock-in|stock-out|stock-taking)\/(.+)\/status$/,
      );
      if (statusMatch && req.method === "GET") {
        const transactionId = decodeURIComponent(statusMatch[2]!);
        const found = submissions.get(transactionId);
        if (!found) return json(res, 404, { message: "Không tìm thấy giao dịch" });
        return json(res, 200, {
          transaction_id: transactionId,
          status: found.status,
          messages: messagesByTransaction.get(transactionId) ?? [],
          submitted_at: new Date().toISOString(),
        });
      }

      return json(res, 404, { message: `Không có đường dẫn ${url.pathname}` });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v2`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
    submissions,
    failNext: (times, status) => {
      failTimes = times;
      failStatus = status;
    },
    expireTokens: () => validTokens.clear(),
    setStatus: (transactionId, status, messages) => {
      const found = submissions.get(transactionId);
      if (found) found.status = status;
      if (messages) messagesByTransaction.set(transactionId, messages);
    },
    loginCount: () => loginCount,
  };
}
