import {
  PlusOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { Alert, Button, Card, Collapse, Input, Space, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import {
  biApi,
  suggestedQuestions,
  toolCallLabel,
  usdText,
  verificationText,
  type AgentReply,
} from "./bi-api.js";

/**
 * Hỏi trợ lý AI trên Bảng điều hành (Phase 4, bước 4.5). Mỗi câu trả lời hiện kèm
 * nguồn số (các tool đã gọi) và kết quả đối chiếu số; câu bị chặn hiện câu cố định
 * của server. Chỉ gọi AI khi người dùng bấm Gửi.
 */

type Turn = { question: string; reply: AgentReply | null; error: string | null };

const TONE_COLORS = { success: "green", warning: "orange", error: "red", default: "default" };

/** Lỗi buộc phải bắt đầu hội thoại mới. */
const RESTART_CODES = new Set(["CONVERSATION_EXPIRED", "CONVERSATION_FULL", "NOT_FOUND"]);

function errorCode(error: unknown): string | null {
  if (!(error instanceof AxiosError)) return null;
  return (error.response?.data as { error?: { code?: string } } | undefined)?.error?.code ?? null;
}

export function AgentPanel({
  store,
  inventoryAllowed,
}: {
  store: string;
  inventoryAllowed: boolean;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["bi", "agent-status"], queryFn: biApi.agentStatus });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (text: string) =>
      biApi.ask({ question: text, store, ...(conversationId ? { conversationId } : {}) }),
    onMutate: (text) => {
      setTurns((list) => [...list, { question: text, reply: null, error: null }]);
      setQuestion("");
    },
    onSuccess: (reply) => {
      setConversationId(reply.conversationId);
      setTurns((list) =>
        list.map((turn, index) => (index === list.length - 1 ? { ...turn, reply } : turn)),
      );
      void queryClient.invalidateQueries({ queryKey: ["bi", "agent-status"] });
    },
    onError: (error) => {
      if (RESTART_CODES.has(errorCode(error) ?? "")) setConversationId(null);
      setTurns((list) =>
        list.map((turn, index) =>
          index === list.length - 1 ? { ...turn, error: getErrorMessage(error) } : turn,
        ),
      );
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  const limits = status.data?.limits;
  const last = [...turns].reverse().find((turn) => turn.reply)?.reply;
  const remaining = last?.remainingThisHour ?? limits?.remainingThisHour;
  const full = last
    ? last.conversation.turns >= last.conversation.maxTurns && conversationId !== null
    : false;

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate(trimmed);
  };
  const restart = () => {
    setTurns([]);
    setConversationId(null);
    ask.reset();
  };

  if (status.isError) {
    return (
      <Alert
        type="error"
        showIcon
        title="Không lấy được trạng thái trợ lý AI"
        description={getErrorMessage(status.error)}
      />
    );
  }
  if (status.data && !status.data.enabled) {
    return (
      <Alert
        type="info"
        showIcon
        title="Trợ lý AI chưa bật"
        description="Cần ANTHROPIC_API_KEY trong server/.env. Các số liệu khác không cần AI."
      />
    );
  }
  if (status.data && !status.data.turnedOn) {
    return (
      <Alert
        type="info"
        showIcon
        title="Chủ nhà thuốc đang tắt trợ lý AI"
        description="Bật lại trong Quản trị → Phân tích & AI."
      />
    );
  }
  if (status.data?.budget.exceeded) {
    const { spentUsd, monthlyUsd, resetsAt } = status.data.budget;
    return (
      <Alert
        type="warning"
        showIcon
        title={`Đã dùng hết ngân sách AI tháng này ($${spentUsd.toFixed(2)} / $${monthlyUsd.toFixed(2)})`}
        description={`Trợ lý mở lại từ ${new Date(resetsAt).toLocaleDateString("vi-VN")}, hoặc nhờ chủ nhà thuốc tăng ngân sách.`}
      />
    );
  }

  return (
    <Card
      className="bi-panel"
      title={
        <span className="bi-panel-title">
          <RobotOutlined /> Trợ lý AI
        </span>
      }
      extra={
        <Space wrap>
          {last ? (
            <Typography.Text type="secondary">
              {last.conversation.turns}/{last.conversation.maxTurns} câu
            </Typography.Text>
          ) : null}
          {remaining !== undefined ? (
            <Typography.Text type="secondary">còn {remaining} lượt/giờ</Typography.Text>
          ) : null}
          <Button
            icon={<PlusOutlined />}
            onClick={restart}
            disabled={turns.length === 0 || ask.isPending}
          >
            Hội thoại mới
          </Button>
        </Space>
      }
    >
      <p className="bi-agent-intro">
        <SafetyCertificateOutlined /> Chỉ đọc số liệu · mọi con số được đối chiếu tự động · phạm vi{" "}
        {store === "ALL" ? "toàn chuỗi" : store}
      </p>

      {turns.length === 0 ? (
        <div className="bi-agent-suggestions">
          {suggestedQuestions(store, inventoryAllowed).map((text) => (
            <Button key={text} onClick={() => send(text)} disabled={!status.data}>
              {text}
            </Button>
          ))}
        </div>
      ) : (
        <div className="bi-agent-turns">
          {turns.map((turn, index) => (
            <TurnView
              key={index}
              turn={turn}
              pending={ask.isPending && index === turns.length - 1}
            />
          ))}
          <div ref={endRef} />
        </div>
      )}

      {full ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          title="Đã đủ 10 câu. Bấm Hội thoại mới để hỏi tiếp."
        />
      ) : (
        <div className="bi-agent-input">
          <Input.TextArea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onPressEnter={(event) => {
              if (event.shiftKey) return;
              event.preventDefault();
              send(question);
            }}
            maxLength={limits?.questionChars ?? 1000}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder="Hỏi về doanh thu, tồn kho, hạn dùng…"
            disabled={ask.isPending}
            aria-label="Câu hỏi cho trợ lý AI"
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={ask.isPending}
            disabled={!question.trim() || remaining === 0}
            onClick={() => send(question)}
          >
            Gửi
          </Button>
        </div>
      )}
    </Card>
  );
}

function TurnView({ turn, pending }: { turn: Turn; pending: boolean }) {
  const reply = turn.reply;
  return (
    <div className="bi-agent-turn">
      <div className="bi-agent-question">{turn.question}</div>
      {turn.error ? <Alert type="error" showIcon title={turn.error} /> : null}
      {pending ? <Typography.Text type="secondary">Đang tra số liệu…</Typography.Text> : null}
      {reply ? <ReplyView reply={reply} /> : null}
    </div>
  );
}

function ReplyView({ reply }: { reply: AgentReply }) {
  const check = verificationText(reply);
  return (
    <div className="bi-agent-reply">
      {reply.answer ? (
        <div className="bi-agent-answer">{reply.answer}</div>
      ) : (
        <Alert
          type={reply.status === "blocked" ? "warning" : "info"}
          showIcon
          title={reply.notice}
          description={reply.detail ?? undefined}
        />
      )}
      <Space wrap size={[6, 6]}>
        <Tag color={TONE_COLORS[check.tone]}>{check.text}</Tag>
        <Typography.Text type="secondary" className="bi-agent-meta">
          {(reply.durationMs / 1000).toFixed(1).replace(".", ",")} giây · {usdText(reply.costUsd)}
        </Typography.Text>
      </Space>
      {reply.toolCalls.length > 0 ? (
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: "sources",
              label: `Nguồn số (${reply.toolCalls.length})`,
              children: (
                <ul className="bi-agent-sources">
                  {reply.toolCalls.map((call, index) => (
                    <li key={index}>
                      <Tag color={call.ok ? "blue" : "red"}>{call.ok ? "Đã tra" : "Lỗi"}</Tag>
                      {toolCallLabel(call)}
                      {call.error ? (
                        <Typography.Text type="danger"> ({call.error})</Typography.Text>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}
