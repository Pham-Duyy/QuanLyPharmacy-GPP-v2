-- Quyền mới cho danh mục Cài đặt (contract §4.1). Chỉ thêm dữ liệu, không đổi cấu trúc bảng.
-- CSDL đã seed trước đó cũng nhận được quyền này mà không phải chạy lại seed.
INSERT INTO "permissions" ("code", "description")
VALUES ('settings.manage', 'Sửa cài đặt cửa hàng, gồm mẫu in hóa đơn')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'settings.manage' FROM "roles" WHERE "code" = 'admin'
ON CONFLICT DO NOTHING;
