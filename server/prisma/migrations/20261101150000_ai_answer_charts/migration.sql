-- Phase 6, bước 6.4: biểu đồ trong câu trả lời của trợ lý AI, dựng từ kết quả tool (đã lọc
-- quyền), lưu cùng nhật ký để mở lại hội thoại cũ vẫn thấy.
ALTER TABLE "ai_agent_logs" ADD COLUMN "charts" JSONB NOT NULL DEFAULT '[]';
