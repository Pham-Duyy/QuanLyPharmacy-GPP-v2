-- Phase 6 (D25): quyền hỏi trợ lý AI tách khỏi quyền xem báo cáo, vì AI tính phí theo câu hỏi.
-- Chỉ vai trò admin (chủ nhà thuốc, quản lý) có sẵn; kiểm toán, dược sĩ, kho không có.
INSERT INTO "permissions" ("code", "description")
VALUES ('report.ai', 'Hỏi trợ lý AI phân tích số liệu (tính phí theo câu hỏi)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'report.ai' FROM "roles" WHERE "code" = 'admin'
ON CONFLICT DO NOTHING;
