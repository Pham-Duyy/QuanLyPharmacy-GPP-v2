import {
  ArrowUpOutlined,
  CheckCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  MenuOutlined,
  MoreOutlined,
  PlusOutlined,
  RedoOutlined,
  RobotOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Collapse,
  Drawer,
  Dropdown,
  Grid,
  Input,
  Modal,
  Select,
  Skeleton,
  Tag,
  Tooltip,
} from "antd";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { useSearchParams } from "react-router";
import remarkGfm from "remark-gfm";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "../auth/auth-context.js";
import {
  biApi,
  canSeeInventory,
  resetDateText,
  suggestedQuestions,
  toolCallLabel,
  usdText,
  verificationText,
} from "../bi/bi-api.js";
import { AnswerCharts } from "./AnswerCharts.js";
import {
  askStream,
  AskError,
  assistantApi,
  groupConversations,
  progressText,
  type AskProgress,
  type AssistantTurn,
  type ConversationInfo,
} from "./assistant-api.js";

type Pending = { question: string; steps: string[]; error: string | null };

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 14) return "Chào buổi trưa";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

/**
 * Trợ lý AI (Phase 6, bước 6.4): giao diện hội thoại kiểu Claude. Cột trái là lịch sử hội
 * thoại; khung giữa là trò chuyện, có tiến trình tra cứu khi AI đang làm việc, dấu đối chiếu
 * số và biểu đồ dựng từ kết quả tool. Hội thoại đang mở nằm trên URL (`?c=`) để tải lại vẫn giữ.
 */
export function AssistantPage() {
  const { me } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const [params, setParams] = useSearchParams();
  const activeId = params.get("c");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ["bi", "agent-status"], queryFn: biApi.agentStatus });
  const access = useQuery({ queryKey: ["bi", "access"], queryFn: biApi.access });
  const conversations = useQuery({
    queryKey: ["assistant", "conversations"],
    queryFn: assistantApi.conversations,
  });
  const detail = useQuery({
    queryKey: ["assistant", "conversation", activeId],
    queryFn: () => assistantApi.conversation(activeId!),
    enabled: activeId !== null,
    retry: false,
  });

  const storeOptions = useMemo(() => {
    const data = access.data;
    if (!data) return [];
    return [
      ...(data.allStores ? [{ value: "ALL", label: "Toàn chuỗi" }] : []),
      ...data.stores.map((store) => ({
        value: store.code,
        label: `${store.code} · ${store.name}`,
      })),
    ];
  }, [access.data]);
  const store = params.get("store") ?? storeOptions[0]?.value ?? "ALL";
  const setParam = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const turns: AssistantTurn[] = activeId ? (detail.data?.messages ?? []) : [];
  const conversation = detail.data;
  const full = conversation ? conversation.turns >= conversation.maxTurns : false;
  const busy = pending !== null && pending.error === null;
  const budget = status.data?.budget;
  const blockedReason = !status.data
    ? null
    : !status.data.enabled
      ? "Máy chủ chưa có ANTHROPIC_API_KEY: trợ lý AI chưa dùng được."
      : !status.data.turnedOn
        ? "Chủ nhà thuốc đang tắt trợ lý AI."
        : budget?.exceeded
          ? `Đã dùng hết ngân sách AI tháng này ($${budget.spentUsd.toFixed(2)} / $${budget.monthlyUsd.toFixed(2)}). Mở lại từ ${resetDateText(budget.resetsAt)}.`
          : null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, pending?.steps.length, pending?.error]);

  // Hội thoại đã xóa hoặc hết hạn (mở từ đường dẫn cũ): quay về màn hình mới.
  useEffect(() => {
    if (detail.isError && activeId) setParam("c", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.isError, activeId]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy || blockedReason) return;
    setDraft("");
    setPending({ question, steps: [], error: null });
    try {
      const result = await askStream(
        { question, store, ...(activeId && !full ? { conversationId: activeId } : {}) },
        (event: AskProgress) => {
          if (event.type === "tool_done") return;
          setPending((current) =>
            current ? { ...current, steps: [...current.steps, progressText(event)] } : current,
          );
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["assistant", "conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["bi", "agent-status"] }),
        queryClient.invalidateQueries({
          queryKey: ["assistant", "conversation", result.conversationId],
        }),
      ]);
      if (result.conversationId !== activeId) setParam("c", result.conversationId);
      setPending(null);
    } catch (error) {
      const text =
        error instanceof AskError
          ? error.message
          : getErrorMessage(error, "Không gửi được câu hỏi");
      setPending((current) => (current ? { ...current, error: text } : current));
      void queryClient.invalidateQueries({ queryKey: ["bi", "agent-status"] });
    }
  };

  const startNew = () => {
    setPending(null);
    setParam("c", null);
    setHistoryOpen(false);
  };
  const open = (id: string) => {
    setPending(null);
    setParam("c", id);
    setHistoryOpen(false);
  };

  const history = (
    <HistoryPanel
      items={conversations.data ?? []}
      loading={conversations.isLoading}
      activeId={activeId}
      onNew={startNew}
      onOpen={open}
      onRemoved={(id) => {
        if (id === activeId) startNew();
        void queryClient.invalidateQueries({ queryKey: ["assistant", "conversations"] });
        void message.success("Đã xóa cuộc trò chuyện");
      }}
      budget={
        budget ? (
          <Tooltip title={`${budget.questions} câu hỏi trong tháng, toàn chuỗi`}>
            <span>
              Tháng này ${budget.spentUsd.toFixed(2)} / ${budget.monthlyUsd.toFixed(0)}
            </span>
          </Tooltip>
        ) : null
      }
    />
  );

  const empty = !activeId && !pending;
  const inventoryAllowed = canSeeInventory(access.data, store);

  return (
    <div className="assistant">
      {screens.lg ? (
        <aside className="assistant-side">{history}</aside>
      ) : (
        <Drawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          placement="left"
          size="default"
          title="Cuộc trò chuyện"
          styles={{ body: { padding: 0 } }}
        >
          {history}
        </Drawer>
      )}

      <section className="assistant-main">
        <header className="assistant-top">
          {screens.lg ? null : (
            <Button
              type="text"
              icon={<MenuOutlined />}
              aria-label="Lịch sử trò chuyện"
              onClick={() => setHistoryOpen(true)}
            />
          )}
          <span className="assistant-title">
            {conversation?.title ?? (pending ? pending.question : "Trợ lý AI")}
          </span>
          {screens.lg ? null : (
            <Button
              type="text"
              icon={<PlusOutlined />}
              aria-label="Trò chuyện mới"
              onClick={startNew}
            />
          )}
        </header>

        <div className={`assistant-thread ${empty ? "is-empty" : ""}`}>
          {empty ? (
            <div className="assistant-welcome">
              <span className="assistant-mark">
                <RobotOutlined />
              </span>
              <h1>
                {greeting()}, {me?.user.fullName}
              </h1>
              <p>Hỏi về doanh thu, tồn kho, hạn dùng, dự báo của nhà thuốc.</p>
            </div>
          ) : (
            <div className="assistant-turns">
              {activeId && detail.isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
              {turns.map((turn) => (
                <TurnView
                  key={turn.logId}
                  turn={turn}
                  onRetry={full || busy ? undefined : () => void send(turn.question)}
                />
              ))}
              {pending ? <PendingView pending={pending} /> : null}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <footer className="assistant-composer-wrap">
          {blockedReason ? (
            <Alert type="info" showIcon title={blockedReason} className="assistant-notice" />
          ) : full && !pending ? (
            <Alert
              type="info"
              showIcon
              className="assistant-notice"
              title={`Cuộc trò chuyện đã đủ ${conversation?.maxTurns ?? 20} câu.`}
              action={
                <Button size="small" type="primary" onClick={startNew}>
                  Trò chuyện mới
                </Button>
              }
            />
          ) : null}
          {empty ? (
            <div className="assistant-suggestions">
              {suggestedQuestions(store, inventoryAllowed).map((text) => (
                <button
                  key={text}
                  type="button"
                  disabled={Boolean(blockedReason) || busy}
                  onClick={() => void send(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}
          <div className="assistant-composer">
            <Input.TextArea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPressEnter={(event) => {
                if (event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void send(draft);
              }}
              variant="borderless"
              autoSize={{ minRows: 1, maxRows: 8 }}
              maxLength={status.data?.limits.questionChars ?? 1000}
              placeholder={
                full ? "Bắt đầu trò chuyện mới để hỏi tiếp" : "Hỏi về doanh thu, tồn kho, hạn dùng…"
              }
              disabled={Boolean(blockedReason) || full}
              aria-label="Câu hỏi cho trợ lý AI"
            />
            <div className="assistant-composer-bar">
              <Select
                size="small"
                variant="borderless"
                value={store}
                options={storeOptions}
                onChange={(value) => setParam("store", value)}
                disabled={storeOptions.length <= 1}
                popupMatchSelectWidth={false}
                aria-label="Phạm vi số liệu"
              />
              <span className="assistant-hint">
                {status.data ? `Còn ${status.data.limits.remainingThisHour} câu/giờ` : null}
              </span>
              <Button
                type="primary"
                shape="circle"
                icon={busy ? <LoadingOutlined /> : <ArrowUpOutlined />}
                disabled={!draft.trim() || busy || Boolean(blockedReason) || full}
                onClick={() => void send(draft)}
                aria-label="Gửi"
              />
            </div>
          </div>
          <p className="assistant-foot">
            Trợ lý chỉ đọc số liệu. Mọi con số được đối chiếu tự động với nguồn trước khi hiện.
          </p>
        </footer>
      </section>
    </div>
  );
}

function HistoryPanel({
  items,
  loading,
  activeId,
  onNew,
  onOpen,
  onRemoved,
  budget,
}: {
  items: ConversationInfo[];
  loading: boolean;
  activeId: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRemoved: (id: string) => void;
  budget: ReactNode;
}) {
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<ConversationInfo | null>(null);
  const [title, setTitle] = useState("");

  const rename = async () => {
    if (!renaming || !title.trim()) return;
    try {
      await assistantApi.rename(renaming.id, title.trim());
      setRenaming(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["assistant", "conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["assistant", "conversation", renaming.id] }),
      ]);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không đổi được tên"));
    }
  };

  return (
    <div className="assistant-history">
      <Button block icon={<PlusOutlined />} onClick={onNew} className="assistant-new">
        Trò chuyện mới
      </Button>
      <nav className="assistant-history-list" aria-label="Lịch sử trò chuyện">
        {loading ? <Skeleton active title={false} paragraph={{ rows: 5 }} /> : null}
        {!loading && items.length === 0 ? (
          <p className="assistant-history-empty">Chưa có cuộc trò chuyện nào</p>
        ) : null}
        {groupConversations(items).map((group) => (
          <div key={group.label} className="assistant-history-group">
            <h3>{group.label}</h3>
            {group.items.map((item) => (
              <div
                key={item.id}
                className={`assistant-history-item ${item.id === activeId ? "is-active" : ""}`}
              >
                <button type="button" onClick={() => onOpen(item.id)} title={item.title}>
                  {item.title}
                </button>
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "rename", icon: <EditOutlined />, label: "Đổi tên" },
                      { key: "delete", icon: <DeleteOutlined />, label: "Xóa", danger: true },
                    ],
                    onClick: ({ key }) => {
                      if (key === "rename") {
                        setTitle(item.title);
                        setRenaming(item);
                        return;
                      }
                      modal.confirm({
                        title: "Xóa cuộc trò chuyện này?",
                        content: "Không khôi phục được. Nhật ký chi phí vẫn được giữ.",
                        okText: "Xóa",
                        okButtonProps: { danger: true },
                        cancelText: "Hủy",
                        onOk: async () => {
                          await assistantApi.remove(item.id);
                          onRemoved(item.id);
                        },
                      });
                    },
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<MoreOutlined />}
                    aria-label={`Tùy chọn cho ${item.title}`}
                  />
                </Dropdown>
              </div>
            ))}
          </div>
        ))}
      </nav>
      <div className="assistant-budget">{budget}</div>
      <Modal
        open={renaming !== null}
        title="Đổi tên cuộc trò chuyện"
        okText="Lưu"
        cancelText="Hủy"
        onOk={() => void rename()}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={title}
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
          onPressEnter={() => void rename()}
        />
      </Modal>
    </div>
  );
}

function TurnView({ turn, onRetry }: { turn: AssistantTurn; onRetry?: (() => void) | undefined }) {
  const { message } = App.useApp();
  const check = verificationText({
    status: turn.status === "error" ? "unavailable" : turn.status,
    verification: turn.verification,
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.answer ?? "");
      void message.success("Đã sao chép");
    } catch {
      void message.error("Không sao chép được");
    }
  };
  return (
    <article className="assistant-turn">
      <div className="assistant-question">{turn.question}</div>
      <div className="assistant-answer">
        {turn.answer ? (
          <div className="assistant-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{turn.answer}</Markdown>
          </div>
        ) : (
          <Alert
            type={turn.status === "blocked" ? "warning" : "info"}
            showIcon
            title={turn.notice}
            description={turn.detail ?? undefined}
          />
        )}
        <AnswerCharts charts={turn.charts} />
        {turn.toolCalls.length > 0 ? (
          <Collapse
            size="small"
            ghost
            className="assistant-sources"
            items={[
              {
                key: "sources",
                label: `Số liệu gốc · ${turn.toolCalls.length} lần tra cứu`,
                children: (
                  <ul>
                    {turn.toolCalls.map((call, index) => (
                      <li key={index}>
                        <Tag color={call.ok ? "blue" : "red"}>{call.ok ? "Đã tra" : "Lỗi"}</Tag>
                        {toolCallLabel(call)}
                        {call.error ? (
                          <span className="assistant-error"> ({call.error})</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
        ) : null}
        <div className="assistant-meta">
          <span className={`assistant-check is-${check.tone}`}>
            {check.tone === "success" ? (
              <CheckCircleFilled />
            ) : check.tone === "error" ? (
              <WarningFilled />
            ) : null}
            {check.text}
          </span>
          <span>
            {(turn.durationMs / 1000).toFixed(1).replace(".", ",")} giây · {usdText(turn.costUsd)}
          </span>
          <span className="assistant-actions">
            {turn.answer ? (
              <Tooltip title="Sao chép">
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copy()}
                />
              </Tooltip>
            ) : null}
            {onRetry ? (
              <Tooltip title="Hỏi lại">
                <Button type="text" size="small" icon={<RedoOutlined />} onClick={onRetry} />
              </Tooltip>
            ) : null}
          </span>
        </div>
      </div>
    </article>
  );
}

function PendingView({ pending }: { pending: Pending }) {
  const current = pending.steps.at(-1);
  return (
    <article className="assistant-turn">
      <div className="assistant-question">{pending.question}</div>
      <div className="assistant-answer">
        {pending.error ? (
          <Alert type="error" showIcon title={pending.error} />
        ) : (
          <div className="assistant-progress" aria-live="polite">
            <span className="assistant-progress-now">
              <LoadingOutlined /> {current ?? "Đang gửi câu hỏi"}…
            </span>
            {pending.steps.length > 1 ? (
              <ul>
                {pending.steps.slice(0, -1).map((step, index) => (
                  <li key={index}>
                    <CheckCircleFilled /> {step}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
