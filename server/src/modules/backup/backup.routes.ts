import { createReadStream } from "node:fs";
import { Router, type RequestHandler } from "express";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { authenticate } from "../../middlewares/authenticate.js";
import * as service from "./backup.service.js";

/**
 * Trang Quản trị → Sao lưu (Phase 7, D30): xem, sao lưu ngay, tải về. Bản sao
 * lưu chứa toàn bộ dữ liệu nên chỉ người quản lý cài đặt **toàn chuỗi** dùng
 * được, và mỗi lần tải đều ghi nhật ký. Không có API phục hồi.
 */
export const backupRouter = Router();

const requireChainSettings: RequestHandler = (req, _res, next) => {
  if (!req.auth?.chainPermissions.has("settings.manage"))
    throw new AppError(403, "FORBIDDEN", "Chỉ quản lý toàn chuỗi mới dùng được chức năng sao lưu");
  next();
};

backupRouter.use("/backups", authenticate, requireChainSettings);

backupRouter.get("/backups", async (_req, res) => {
  sendData(res, await service.backupStatus());
});

backupRouter.post("/backups", async (req, res) => {
  const result = await service.createBackup("manual", req.auth!.userId);
  await service.auditBackup(
    "BACKUP_CREATE",
    req.auth!.userId,
    result.name,
    res.locals["requestId"] as string | undefined,
  );
  sendData(res, result, 201);
});

backupRouter.get("/backups/:name/download", async (req, res) => {
  const name = String(req.params.name);
  const file = await service.resolveBackup(name);
  await service.auditBackup(
    "BACKUP_DOWNLOAD",
    req.auth!.userId,
    name,
    res.locals["requestId"] as string | undefined,
  );
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  createReadStream(file).pipe(res);
});
