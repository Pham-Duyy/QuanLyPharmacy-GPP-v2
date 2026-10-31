-- Phase 6, bước 6.3: lịch sử hội thoại kiểu Claude. Tiêu đề lấy từ câu hỏi đầu (không gọi AI),
-- người dùng đổi được; danh sách xếp theo lần hỏi gần nhất của từng người.
ALTER TABLE "ai_agent_conversations" ADD COLUMN "title" TEXT;

UPDATE "ai_agent_conversations" c
SET "title" = left(regexp_replace(l."question", '\s+', ' ', 'g'), 80)
FROM (
  SELECT DISTINCT ON ("conversation_id") "conversation_id", "question"
  FROM "ai_agent_logs"
  WHERE "conversation_id" IS NOT NULL
  ORDER BY "conversation_id", "occurred_at"
) l
WHERE l."conversation_id" = c."id";

CREATE INDEX "ai_agent_conversations_user_idx" ON "ai_agent_conversations" ("user_id", "updated_at" DESC);

-- Hội thoại dài hơn (tối đa 20 câu thay vì 10).
ALTER TABLE "ai_agent_conversations" DROP CONSTRAINT "ai_agent_conversations_turns_check";
ALTER TABLE "ai_agent_conversations"
  ADD CONSTRAINT "ai_agent_conversations_turns_check" CHECK ("turns" BETWEEN 0 AND 20);
