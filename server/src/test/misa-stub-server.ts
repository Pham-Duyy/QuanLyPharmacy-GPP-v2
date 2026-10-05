import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Máy chủ giả mô phỏng API MISA meInvoice cho hóa đơn máy tính tiền, theo tài
 * liệu doc.meinvoice.vn. Chỉ dùng trong test: không có đường nào từ app.ts
 * dẫn tới đây.
 *
 * Mô phỏng những chỗ dễ làm phần mềm sai:
 *   - Data của phát hành là CHUỖI JSON, không phải mảng;
 *   - mã cơ quan thuế cấp sau, phải hỏi lại trạng thái;
 *   - mất phản hồi sau khi đã nhận hóa đơn (để kiểm tra không phát hành trùng);
 *   - token hết hạn trả ErrorCode TokenExpiredCode.
 */

export type MisaAccount = { appId: string; taxCode: string; username: string; password: string };

type Submission = { payload: Record<string, unknown>; transactionId: string; taxCode: string };

export type MisaStub = {
  baseUrl: string;
  close: () => Promise<void>;
  submissions: Map<string, Submission>;
  /** Mã cơ quan thuế và SendTaxStatus theo RefID. */
  setTaxStatus: (refId: string, sendTaxStatus: number, invoiceCode?: string) => void;
  /** Lần phát hành tới: ghi nhận hóa đơn rồi trả lỗi 500 (mất phản hồi). */
  loseNextPublishResponse: () => void;
  /** Lần phát hành tới bị từ chối với mã lỗi này. */
  rejectNextPublish: (errorCode: string) => void;
  expireTokens: () => void;
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

export async function startMisaStub(accounts: MisaAccount[]): Promise<MisaStub> {
  const submissions = new Map<string, Submission>();
  const taxStatus = new Map<string, { status: number; code: string | null }>();
  const tokens = new Map<string, string>(); // token → taxCode
  let counter = 0;
  let logins = 0;
  let loseNext = false;
  let rejectNext: string | null = null;

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, errorCode: string, message: string) =>
    json(res, 200, { Success: false, ErrorCode: errorCode, Errors: [message], Data: null });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stub.local");
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as unknown) : null;

      if (url.pathname === "/api/v3/auth/token" && req.method === "POST") {
        logins += 1;
        const input = body as Record<string, string>;
        const account = accounts.find(
          (item) => item.taxCode === input.taxcode && item.username === input.username,
        );
        if (!account || account.appId !== input.appid)
          return fail(res, "InvalidAppID", "AppID không đúng");
        if (account.password !== input.password)
          return fail(res, "UnAuthorize", "Sai tài khoản hoặc mật khẩu");
        counter += 1;
        const token = `misa-token-${counter}`;
        tokens.set(token, account.taxCode);
        return json(res, 200, {
          Success: true,
          Data: token,
          ErrorCode: null,
          Errors: [],
          CustomData: null,
        });
      }

      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const tokenTaxCode = tokens.get(token);
      if (!tokenTaxCode) return fail(res, "TokenExpiredCode", "Token hết hạn");

      if (
        url.pathname === "/api/v3/code/itg/invoice-calculating/invoiceandpublish" &&
        req.method === "POST"
      ) {
        if (req.headers["companytaxcode"] !== tokenTaxCode) {
          return fail(res, "InvalidTaxCode", "CompanyTaxCode không khớp tài khoản");
        }
        const items = body as Array<{
          OrgInvoiceData: Record<string, unknown>;
          IsInvoiceCalculatingMachine: boolean;
        }>;
        const first = items?.[0];
        if (
          !first?.IsInvoiceCalculatingMachine ||
          !first.OrgInvoiceData?.["RefID"] ||
          !first.OrgInvoiceData["InvSeries"]
        ) {
          return fail(res, "InvalidInvoiceData", "Thiếu RefID, InvSeries hoặc cờ máy tính tiền");
        }
        if (rejectNext) {
          const code = rejectNext;
          rejectNext = null;
          return fail(res, code, `Dữ liệu hóa đơn không hợp lệ (${code})`);
        }
        const refId = String(first.OrgInvoiceData["RefID"]);
        const existing = submissions.get(refId);
        const transactionId =
          existing?.transactionId ?? `TX${String(submissions.size + 1).padStart(6, "0")}`;
        submissions.set(refId, {
          payload: first.OrgInvoiceData,
          transactionId,
          taxCode: tokenTaxCode,
        });
        if (loseNext) {
          loseNext = false;
          return json(res, 500, { Success: false, ErrorCode: "Timeout", Errors: ["mất phản hồi"] });
        }
        const data = [
          {
            RefID: refId,
            TransactionID: transactionId,
            InvTemplateNo: "1",
            InvSeries: first.OrgInvoiceData["InvSeries"],
            InvNo: String(submissions.size).padStart(8, "0"),
          },
        ];
        return json(res, 200, {
          Success: true,
          ErrorCode: null,
          Errors: [],
          Data: JSON.stringify(data),
        });
      }

      if (url.pathname === "/api/integration/invoice/status" && req.method === "POST") {
        const refIds = (body as string[]) ?? [];
        const data = refIds
          .filter((refId) => submissions.has(refId))
          .map((refId) => {
            const status = taxStatus.get(refId) ?? { status: 0, code: null };
            return {
              RefID: refId,
              TransactionID: submissions.get(refId)!.transactionId,
              PublishStatus: 1,
              InvoiceCode: status.code,
              SendTaxStatus: status.status,
            };
          });
        return json(res, 200, { Success: true, Data: data, ErrorCode: null, Errors: [] });
      }

      return json(res, 404, { Success: false, ErrorCode: "NotFound", Errors: [url.pathname] });
    })().catch((error: unknown) => json(res, 500, { Success: false, Errors: [String(error)] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    submissions,
    setTaxStatus: (refId, status, code) => taxStatus.set(refId, { status, code: code ?? null }),
    loseNextPublishResponse: () => {
      loseNext = true;
    },
    rejectNextPublish: (code) => {
      rejectNext = code;
    },
    expireTokens: () => tokens.clear(),
    loginCount: () => logins,
  };
}
