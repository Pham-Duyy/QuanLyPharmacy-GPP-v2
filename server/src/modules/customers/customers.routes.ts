import { Router } from "express";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import {
  createCustomerSchema,
  patchCustomerSchema,
  patchHealthProfileSchema,
  searchCustomersSchema,
} from "./customers.schema.js";
import * as service from "./customers.service.js";

export const customersRouter = Router();

// Khách hàng dùng chung toàn chuỗi, không cần X-Store-Id (contract §2.8).
// Giới hạn theo tiền tố "/customers": nhiều router được app.ts gắn chung
// vào "/api/v1", .use() không kèm đường dẫn sẽ chạy cho MỌI request đi
// qua router này, kể cả của router khác đăng ký sau (đã gặp lỗi này ba
// lần ở các router khác, rút kinh nghiệm ngay từ đầu).
customersRouter.use("/customers", authenticate, storeContext);

customersRouter.get("/customers", requirePermission("customer.read"), async (req, res) => {
  const { search } = parseOrThrow(searchCustomersSchema, req.query);
  sendData(res, await service.search(search));
});

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
