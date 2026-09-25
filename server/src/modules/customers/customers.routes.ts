import { Router } from "express";
import { pageResult, parsePageQuery } from "../../lib/pagination.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import {
  anonymizeCustomerSchema,
  createCustomerSchema,
  patchCustomerSchema,
  patchHealthProfileSchema,
  listCustomersSchema,
  searchCustomersSchema,
} from "./customers.schema.js";
import { adjustPointsSchema } from "../loyalty/loyalty.schema.js";
import * as loyalty from "../loyalty/loyalty.service.js";
import { customerSummary } from "./customer-insights.js";
import { exportCustomersCsv } from "./customer-export.js";
import * as service from "./customers.service.js";

export const customersRouter = Router();

// Khách hàng dùng chung toàn chuỗi, không cần X-Store-Id (contract §2.8).
// Giới hạn theo tiền tố "/customers": nhiều router được app.ts gắn chung
// vào "/api/v1", .use() không kèm đường dẫn sẽ chạy cho MỌI request đi
// qua router này, kể cả của router khác đăng ký sau (đã gặp lỗi này ba
// lần ở các router khác, rút kinh nghiệm ngay từ đầu).
customersRouter.use("/customers", authenticate, storeContext);

/**
 * GET /api/v1/customers:
 * - có `search` (≥ 3 ký tự): tìm nhanh, trả mảng tối đa 20 khách (quầy bán, ô tìm nhanh);
 * - không có `search`: danh sách phân trang, mới tạo trước. Chỉ trường cơ bản, số
 *   điện thoại che bớt — hồ sơ sức khỏe và lịch sử mua vẫn phải mở từng khách.
 */
customersRouter.get("/customers", requirePermission("customer.read"), async (req, res) => {
  if (req.query["search"] === undefined) {
    const page = parsePageQuery(req.query, {
      sortable: ["createdAt", "fullName", "totalSpent", "lastPurchaseAt"],
      defaultSort: "createdAt",
    });
    const { q, segment } = parseOrThrow(listCustomersSchema, req.query);
    const { items, total } = await service.list(page, { q: q || undefined, segment });
    sendData(res, pageResult(items, total, page));
    return;
  }
  const { search } = parseOrThrow(searchCustomersSchema, req.query);
  sendData(res, await service.search(search));
});

/** GET /api/v1/customers/summary: số liệu đầu trang (tổng, khách mới, đã mua 30 ngày, số khách mỗi nhóm). */
customersRouter.get("/customers/summary", requirePermission("customer.read"), async (_req, res) => {
  sendData(res, await customerSummary());
});

/**
 * GET /api/v1/customers/export: xuất CSV theo bộ lọc đang xem. Có số điện
 * thoại đầy đủ để gọi chăm sóc khách, nên cần quyền customer.sensitive và
 * ghi audit mỗi lần xuất.
 */
customersRouter.get(
  "/customers/export",
  requirePermission("customer.sensitive"),
  async (req, res) => {
    const { q, segment } = parseOrThrow(listCustomersSchema, req.query);
    const csv = await exportCustomersCsv(
      req.auth!,
      { q: q || undefined, segment },
      res.locals.requestId as string | undefined,
    );
    res
      .set(
        "Content-Disposition",
        `attachment; filename="khach-hang-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .type("text/csv; charset=utf-8")
      .send(csv);
  },
);

customersRouter.get("/customers/:id", requirePermission("customer.read"), async (req, res) => {
  sendData(res, await service.getDetail(String(req.params.id)));
});

customersRouter.post("/customers", requirePermission("customer.manage"), async (req, res) => {
  const input = parseOrThrow(createCustomerSchema, req.body);
  const id = await withMappedErrors(() => service.create(input));
  sendData(res, await service.getDetail(id), 201);
});

customersRouter.patch("/customers/:id", requirePermission("customer.manage"), async (req, res) => {
  const input = parseOrThrow(patchCustomerSchema, req.body);
  const id = String(req.params.id);
  await withMappedErrors(() => service.update(id, input));
  sendData(res, await service.getDetail(id));
});

customersRouter.get(
  "/customers/:id/health-profile",
  requirePermission("customer.sensitive"),
  async (req, res) => {
    sendData(res, await service.getHealthProfile(String(req.params.id), req.auth!));
  },
);

customersRouter.patch(
  "/customers/:id/health-profile",
  requirePermission("customer.sensitive"),
  async (req, res) => {
    const input = parseOrThrow(patchHealthProfileSchema, req.body);
    const id = String(req.params.id);
    // ingredientId hợp lệ về định dạng nhưng không tồn tại thì Prisma ném
    // P2003 (khóa ngoại) — dịch sang 422 thay vì để rơi xuống 500 chung.
    // Toàn bộ nằm trong transaction ở service nên lỗi giữa chừng tự rollback,
    // không để sót consent, hồ sơ hay dị ứng dở dang.
    await withMappedErrors(() => service.updateHealthProfile(id, req.auth!, input));
    sendData(res, await service.getHealthProfile(id, req.auth!));
  },
);

customersRouter.get(
  "/customers/:id/invoices",
  requirePermission("customer.sensitive"),
  async (req, res) => {
    sendData(res, await service.getInvoiceHistory(String(req.params.id), req.auth!));
  },
);

/**
 * GET /api/v1/customers/{id}/loyalty: số dư điểm và sổ điểm gần đây. Quầy
 * bán phải xem được để mời khách đổi điểm nên chỉ cần `customer.read`.
 */
customersRouter.get(
  "/customers/:id/loyalty",
  requirePermission("customer.read"),
  async (req, res) => {
    sendData(res, await loyalty.getCustomerLoyalty(String(req.params.id)));
  },
);

/**
 * POST /api/v1/customers/{id}/loyalty/adjust: cộng hoặc trừ điểm bằng tay.
 * Luôn phải ghi lý do, ghi audit và không được làm số dư âm.
 */
customersRouter.post(
  "/customers/:id/loyalty/adjust",
  requireStore,
  requirePermission("loyalty.manage"),
  async (req, res) => {
    const input = parseOrThrow(adjustPointsSchema, req.body);
    sendData(
      res,
      await loyalty.adjust(req.auth!.storeId!, String(req.params.id), req.auth!, input),
    );
  },
);

customersRouter.post(
  "/customers/:id/anonymize",
  requirePermission("customer.sensitive"),
  async (req, res) => {
    const input = parseOrThrow(anonymizeCustomerSchema, req.body);
    const id = String(req.params.id);
    await withMappedErrors(() => service.anonymize(id, req.auth!, input.reason));
    sendData(res, await service.getDetail(id));
  },
);
