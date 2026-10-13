-- Dược sĩ xem khách đã mua lô bị thu hồi tại cửa hàng mình và ghi đã liên hệ
-- (GPP: dược sĩ phụ trách chuyên môn chịu trách nhiệm thu hồi). Tạo và đóng
-- đợt thu hồi vẫn chỉ vai trò có recall.manage.
INSERT INTO "permissions" ("code", "description")
VALUES ('recall.contact', 'Xem khách đã mua lô bị thu hồi tại cửa hàng mình, ghi đã liên hệ')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'recall.contact' FROM "roles" WHERE "code" = 'pharmacist'
ON CONFLICT DO NOTHING;
