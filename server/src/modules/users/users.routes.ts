import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { createUserSchema, patchUserSchema, replaceRolesSchema } from "./users.schema.js";
import * as service from "./users.service.js";

export const usersRouter = Router();

// Người dùng và vai trò dùng chung toàn chuỗi, không thuộc phạm vi một cửa
// hàng cụ thể — không cần storeContext/requireStore (contract §21).
usersRouter.use(["/users", "/roles"], authenticate, requirePermission("user.manage"));

const listQuerySchema = z.object({ search: z.string().trim().max(200).optional() });

usersRouter.get("/users", async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  sendData(res, await service.list({ search: query.search }));
});

usersRouter.get("/users/:id", async (req, res) => {
  sendData(res, await service.getDetail(String(req.params.id)));
});

usersRouter.post("/users", async (req, res) => {
  const input = parseOrThrow(createUserSchema, req.body);
  const result = await service.create(input, req.auth!.userId);
  const detail = await service.getDetail(result.id);
  // Mật khẩu tạm chỉ xuất hiện đúng một lần trong response này, không lưu
  // lại ở đâu khác — người tạo phải chép/gửi ngay cho nhân sự.
  sendData(res, { ...detail, tempPassword: result.tempPassword }, 201);
});

usersRouter.patch("/users/:id", async (req, res) => {
  const input = parseOrThrow(patchUserSchema, req.body);
  const id = String(req.params.id);
  await service.update(id, input);
  sendData(res, await service.getDetail(id));
});

usersRouter.put("/users/:id/roles", async (req, res) => {
  const input = parseOrThrow(replaceRolesSchema, req.body);
  const id = String(req.params.id);
  await service.replaceRoles(id, req.auth!.userId, input);
  sendData(res, await service.getDetail(id));
});

usersRouter.post("/users/:id/deactivate", async (req, res) => {
  const id = String(req.params.id);
  await service.deactivate(id, req.auth!.userId);
  sendData(res, await service.getDetail(id));
});

usersRouter.post("/users/:id/activate", async (req, res) => {
  const id = String(req.params.id);
  await service.activate(id, req.auth!.userId);
  sendData(res, await service.getDetail(id));
});

usersRouter.post("/users/:id/reset-password", async (req, res) => {
  const id = String(req.params.id);
  const tempPassword = await service.resetPassword(id, req.auth!.userId);
  sendData(res, { id, tempPassword });
});

usersRouter.get("/roles", async (_req, res) => {
  sendData(res, await service.listRoles());
});
