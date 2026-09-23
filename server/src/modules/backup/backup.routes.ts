import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { restoreCommands } from "./backup.runner.js";
import * as service from "./backup.service.js";

export const backupRouter = Router();
backupRouter.use("/backups", authenticate, requirePermission("backup.manage"));

/** GET /api/v1/backups: tình trạng bảo vệ dữ liệu và lịch sử các lượt sao lưu. */
backupRouter.get("/backups", async (_req, res) => {
  const [status, items] = await Promise.all([service.getStatus(), service.listBackups()]);
  sendData(res, { status, items });
});

/** POST /api/v1/backups: sao lưu ngay, dùng trước khi làm việc có rủi ro. */
backupRouter.post("/backups", async (req, res) => {
  const backup = await service.runBackup({
    trigger: "MANUAL",
    actorId: req.auth!.userId,
    requestId: (res.locals.requestId as string | undefined) ?? null,
  });
  sendData(res, { backup, restoreCommands: restoreCommands(backup.folderName) }, 201);
});

/** PUT /api/v1/backups/settings: lịch chạy, số bản giữ lại, ngưỡng cảnh báo. */
backupRouter.put("/backups/settings", async (req, res) => {
  const input = parseOrThrow(service.backupSettingsSchema, req.body);
  await service.saveSettings(input, req.auth!.userId, (res.locals.requestId as string | undefined) ?? null);
  sendData(res, await service.getStatus());
});

/**
 * GET /api/v1/backups/{id}/download: tải tệp dump về máy khác hoặc USB.
 * Tệp chứa toàn bộ dữ liệu nhà thuốc nên ghi nhật ký mỗi lần tải.
 */
backupRouter.get("/backups/:id/download", async (req, res) => {
  const target = await service.resolveDownload(String(req.params.id));
  await prisma.auditLog.create({
    data: {
      storeId: null,
      actorId: req.auth!.userId,
      action: "BACKUP_DOWNLOAD",
      resourceType: "backup",
      resourceId: String(req.params.id),
      requestId: (res.locals.requestId as string | undefined) ?? null,
      after: { fileName: target.fileName },
    },
  });
  res.download(target.filePath, target.fileName);
});
