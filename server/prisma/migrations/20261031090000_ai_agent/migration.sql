-- AI Agent của Bảng điều hành (Pharmacy Intelligent Analytics, Phase 4 bước 4.4;
-- api-contract §20.2). Bảng riêng, không dùng lại ai_logs đã gỡ ở
-- 20261011150000_remove_ai: nhật ký từng câu hỏi (tool đã gọi, token, chi phí,
-- kết quả đối chiếu số) và hội thoại chỉ-thêm, hết hạn sau 24 giờ.

-- CreateTable
CREATE TABLE "ai_agent_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "turns" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_agent_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "answer" TEXT,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "verification" JSONB,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6),
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "ai_agent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_agent_conversations_expires_idx" ON "ai_agent_conversations"("expires_at");

-- CreateIndex
CREATE INDEX "ai_agent_logs_user_idx" ON "ai_agent_logs"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "ai_agent_logs_occurred_idx" ON "ai_agent_logs"("occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "ai_agent_conversations" ADD CONSTRAINT "ai_agent_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_logs" ADD CONSTRAINT "ai_agent_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_logs" ADD CONSTRAINT "ai_agent_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_agent_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ai_agent_conversations"
  ADD CONSTRAINT "ai_agent_conversations_turns_check" CHECK ("turns" BETWEEN 0 AND 10);
ALTER TABLE "ai_agent_logs"
  ADD CONSTRAINT "ai_agent_logs_status_check" CHECK ("status" IN (
    'answered', 'blocked', 'round_limit', 'timeout', 'refused', 'truncated', 'unavailable', 'error'));
