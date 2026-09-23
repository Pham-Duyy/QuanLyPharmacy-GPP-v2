-- Sao lưu dữ liệu: lịch sử từng lần chạy (kể cả thất bại) và quyền mới.
CREATE TABLE "backups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(6),
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "trigger" TEXT NOT NULL,
  "actor_id" UUID,
  "folder_name" TEXT NOT NULL,
  "database_bytes" BIGINT,
  "storage_bytes" BIGINT,
  "storage_files" INTEGER,
  "error_text" TEXT,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "backups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backups_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "backups_folder_name_key" ON "backups" ("folder_name");
CREATE INDEX "backups_started_at_idx" ON "backups" ("started_at" DESC);

-- Quyền mới (contract §4.1): chỉ chủ nhà thuốc, quản lý mới xem, chạy và tải bản sao lưu.
INSERT INTO "permissions" ("code", "description")
VALUES ('backup.manage', 'Xem, chạy và tải bản sao lưu dữ liệu')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'backup.manage' FROM "roles" WHERE "code" = 'admin'
ON CONFLICT DO NOTHING;
