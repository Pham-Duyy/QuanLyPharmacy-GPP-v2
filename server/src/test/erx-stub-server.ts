import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Máy chủ giả mô phỏng hai API phía nhà thuốc của Hệ thống đơn thuốc quốc gia
 * theo tài liệu kết nối ban hành kèm Quyết định 808/QĐ-BYT:
 *
 *   - mục VIII  GET  /api/v1/thong-tin-don-thuoc/{ma_don_thuoc}
 *   - mục IX    POST /api/v1/cap-nhat-don-thuoc
 *
 * Chỉ dùng trong test: không có đường nào từ app.ts dẫn tới đây. Tài liệu
 * không nói trả gì khi sai app-name/app-key; ở đây trả 401.
 */

export type ErxStub = {
  baseUrl: string;
  close: () => Promise<void>;
  /** Đặt sẵn một đơn để nhà thuốc lấy về. */
  addPrescription: (prescription: Record<string, unknown>) => void;
  /** Các lần báo bán đã nhận, theo thứ tự. */
  dispensed: Array<Record<string, unknown>>;
  /** Lần gọi kế tiếp tới API báo bán trả mã lỗi này. */
  failNextDispense: (status: number, errors?: string[]) => void;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export async function startErxStub(account: { appName: string; appKey: string }): Promise<ErxStub> {
  const prescriptions = new Map<string, Record<string, unknown>>();
  const dispensed: Array<Record<string, unknown>> = [];
  let failNext: { status: number; errors: string[] } | null = null;

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json;charset=UTF-8" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (
        req.headers["app-name"] !== account.appName ||
        req.headers["app-key"] !== account.appKey
      ) {
        json(res, 401, { danh_sach_cac_loi: ["Sai app-name hoặc app-key"] });
        return;
      }
      const url = new URL(req.url ?? "/", "http://stub");

      const lookup = /^\/api\/v1\/thong-tin-don-thuoc\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && lookup) {
        const found = prescriptions.get(decodeURIComponent(lookup[1]!).toLowerCase());
        if (!found) json(res, 404, { danh_sach_cac_loi: ["Không tìm thấy đơn thuốc"] });
        else json(res, 200, found);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/cap-nhat-don-thuoc") {
        if (failNext) {
          const { status, errors } = failNext;
          failNext = null;
          json(res, status, { danh_sach_cac_loi: errors });
          return;
        }
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const errors: string[] = [];
        if (!prescriptions.has(String(body["ma_don_thuoc"] ?? "").toLowerCase())) {
          json(res, 404, { danh_sach_cac_loi: ["Không tìm thấy đơn thuốc"] });
          return;
        }
        if (!Array.isArray(body["thong_tin_thuoc"]) || body["thong_tin_thuoc"].length === 0)
          errors.push("Thiếu thông tin thuốc");
        if (String(body["ma_hoa_don"] ?? "").length > 20) errors.push("Mã hóa đơn quá 20 ký tự");
        if (!body["ma_dinh_danh_co_so_cung_ung_thuoc"])
          errors.push("Thiếu mã định danh cơ sở cung ứng thuốc");
        if (errors.length > 0) {
          json(res, 422, { danh_sach_cac_loi: errors });
          return;
        }
        dispensed.push(body);
        json(res, 200, "Cập nhật đơn thuốc đã bán thành công");
        return;
      }

      json(res, 404, { danh_sach_cac_loi: ["Không có API này"] });
    })().catch((error: unknown) => json(res, 500, { danh_sach_cac_loi: [String(error)] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    addPrescription: (prescription) =>
      prescriptions.set(String(prescription["ma_don_thuoc"]).toLowerCase(), prescription),
    dispensed,
    failNextDispense: (status, errors = ["Lỗi giả lập"]) => {
      failNext = { status, errors };
    },
  };
}
