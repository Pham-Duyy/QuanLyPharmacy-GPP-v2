-- Phần mềm không dùng AI (quyết định 11/10/2026, contract §20): gỡ bảng nhật ký
-- AI và quyền ai.use, khai báo sẵn từ migration đầu nhưng chưa có mã nào dùng.
-- Bảng ai_logs chưa từng có dòng nào.

-- Quyền: gỡ khỏi vai trò trước, rồi xóa mã quyền.
DELETE FROM "role_permissions" WHERE "permission_code" = 'ai.use';
DELETE FROM "permissions" WHERE "code" = 'ai.use';

-- Bảng nhật ký AI (chỉ mục và khóa ngoại đi theo bảng).
DROP TABLE "ai_logs";
