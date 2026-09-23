import { ArrowLeftOutlined, CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, SaveOutlined, SearchOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Input, InputNumber, Progress, Segmented, Select, Skeleton, Table, Tag, Tooltip, Typography } from "antd";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage } from "../../../api/http.js";
import { formatDate, formatDateTime, formatNumber } from "../../../ui/format.js";
import { formatVnd } from "../../../api/types.js";
import { useAuth } from "../../auth/AuthProvider.js";
import { cancelCount, closeCount, getCount, saveCounts, type CountEntry, type CountLine } from "./stock-count-api.js";

type Filter = "ALL" | "PENDING" | "COUNTED" | "DIFF";

type Draft = { unitId: string; quantity: number | null };

export function CountingBoard({ countId, onBack }: { countId: string; onBack: () => void }) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [shelf, setShelf] = useState<string | undefined>();
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const detail = useQuery({ queryKey: ["stock-count", countId], queryFn: () => getCount(countId) });
  const lines = useMemo(() => detail.data?.lines ?? [], [detail.data]);
  const count = detail.data?.count;
  const summary = detail.data?.summary;
  const canCount = can("stock.adjust.create") && count?.status === "COUNTING";

  const save = useMutation({
    mutationFn: (entries: CountEntry[]) => saveCounts(countId, entries),
    onSuccess: async (data, entries) => {
      setDrafts((current) => {
        const next = { ...current };
        for (const entry of entries) delete next[entry.lineId];
        return next;
      });
      queryClient.setQueryData(["stock-count", countId], { count: data.count, lines: data.lines, summary: data.summary });
      await queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được số đếm")),
  });

  const finish = useMutation({
    mutationFn: () => closeCount(countId),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
      queryClient.setQueryData(["stock-count", countId], { count: data.count, lines: data.lines, summary: data.summary });
      modal.success({
        title: "Đã chốt đợt kiểm kê",
        content: data.adjustmentId ? (
          <span>
            Có {formatNumber(data.differenceLines)} dòng lệch. Hệ thống đã lập phiếu điều chỉnh <b>{data.count.adjustment?.code}</b> ở trạng thái nháp. Tồn kho chỉ thay đổi sau khi người khác duyệt phiếu này.
          </span>
        ) : (
          <span>Số đếm khớp hoàn toàn với tồn hệ thống, không cần điều chỉnh gì.</span>
        ),
        okText: data.adjustmentId ? "Tới phiếu điều chỉnh" : "Đóng",
        onOk: () => {
          if (data.adjustmentId) void navigate("/dieu-chinh-ton");
        },
      });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không chốt được đợt kiểm kê")),
  });

  const abandon = useMutation({
    mutationFn: (reason: string) => cancelCount(countId, reason),
    onSuccess: async () => {
      void message.success("Đã hủy đợt kiểm kê, tồn kho giữ nguyên");
      await queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
      await queryClient.invalidateQueries({ queryKey: ["stock-count", countId] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được đợt kiểm kê")),
  });

  const shelves = useMemo(() => [...new Set(lines.map((line) => line.shelfLocation).filter((value): value is string => Boolean(value)))].sort(), [lines]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return lines.filter((line) => {
      if (shelf && line.shelfLocation !== shelf) return false;
      if (filter === "PENDING" && line.countedBaseQuantity !== null) return false;
      if (filter === "COUNTED" && line.countedBaseQuantity === null) return false;
      if (filter === "DIFF" && !line.differenceBaseQuantity) return false;
      if (!term) return true;
      return [line.productName, line.productCode, line.batchNumber].some((value) => value.toLowerCase().includes(term));
    });
  }, [lines, search, filter, shelf]);

  function setDraft(line: CountLine, patch: Partial<Draft>): void {
    setDrafts((current) => ({
      ...current,
      [line.id]: {
        unitId: patch.unitId ?? current[line.id]?.unitId ?? line.countedUnitId ?? line.units.find((unit) => unit.conversionToBase === 1)?.id ?? line.units[0]!.id,
        quantity: patch.quantity === undefined ? (current[line.id]?.quantity ?? line.countedQuantity) : patch.quantity,
      },
    }));
  }

  function entryOf(lineId: string): CountEntry | null {
    const draft = drafts[lineId];
    if (!draft || draft.quantity === null || draft.quantity === undefined) return null;
    return { lineId, unitId: draft.unitId, quantity: draft.quantity };
  }

  /** Enter: lưu ngay dòng đang nhập rồi nhảy xuống ô kế tiếp, đếm cho nhanh. */
  function commitRow(line: CountLine): void {
    const entry = entryOf(line.id);
    if (entry) save.mutate([entry]);
    const index = visible.findIndex((item) => item.id === line.id);
    const next = visible[index + 1];
    if (next) inputs.current.get(next.id)?.focus();
  }

  const dirtyEntries = Object.keys(drafts)
    .map((lineId) => entryOf(lineId))
    .filter((entry): entry is CountEntry => entry !== null);

  function confirmClose(): void {
    if (!summary) return;
    modal.confirm({
      title: "Chốt đợt kiểm kê?",
      width: 560,
      content: (
        <div>
          <p>
            Đã đếm {formatNumber(summary.countedLines)}/{formatNumber(summary.totalLines)} dòng, trong đó <b>{formatNumber(summary.differenceLines)} dòng lệch</b>.
          </p>
          {summary.pendingLines > 0 ? (
            <Alert
              type="warning"
              showIcon
              title={`Còn ${formatNumber(summary.pendingLines)} dòng chưa đếm`}
              description="Dòng chưa đếm không bị coi là hết hàng — hệ thống bỏ qua, tồn của chúng giữ nguyên."
            />
          ) : null}
          <p style={{ marginTop: 10 }}>Hệ thống sẽ lập phiếu điều chỉnh tồn ở trạng thái nháp. Tồn kho chỉ đổi sau khi người khác duyệt phiếu.</p>
        </div>
      ),
      okText: "Chốt kiểm kê",
      cancelText: "Đếm tiếp",
      onOk: () => finish.mutateAsync().then(() => undefined),
    });
  }

  function confirmCancel(): void {
    let reason = "";
    modal.confirm({
      title: "Hủy đợt kiểm kê?",
      content: (
        <div>
          <p>Toàn bộ số đã đếm trong đợt này sẽ không được dùng. Tồn kho giữ nguyên.</p>
          <Input placeholder="Lý do hủy (tùy chọn)" onChange={(event) => (reason = event.target.value)} />
        </div>
      ),
      okText: "Hủy đợt",
      okButtonProps: { danger: true },
      cancelText: "Quay lại",
      onOk: () => abandon.mutateAsync(reason).then(() => undefined),
    });
  }

  if (detail.isLoading) return <Skeleton active />;
  if (!count || !summary) return <Alert type="error" showIcon title="Không đọc được đợt kiểm kê" />;

  const progress = summary.totalLines === 0 ? 0 : Math.round((summary.countedLines / summary.totalLines) * 100);

  const columns = [
    {
      title: "Sản phẩm / lô",
      dataIndex: "productName",
      render: (_: string, line: CountLine) => (
        <div className="cell-main">
          <span className="cell-title">{line.productName}</span>
          <span className="cell-sub">
            {line.productCode} · Lô {line.batchNumber} · HSD {formatDate(line.expiryDate)}
            {line.shelfLocation ? ` · ${line.shelfLocation}` : ""}
          </span>
        </div>
      ),
    },
    {
      title: "Tồn hệ thống",
      dataIndex: "systemBaseQuantityNow",
      width: 120,
      align: "right" as const,
      render: (value: number, line: CountLine) => (
        <Tooltip title={line.countedAt ? `Lúc đếm: ${formatNumber(line.systemBaseQuantityAtCount)} ${line.baseUnitName}` : undefined}>
          <span>
            {formatNumber(value)} <span className="cell-sub">{line.baseUnitName}</span>
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Đếm thực tế",
      dataIndex: "countedQuantity",
      width: 230,
      render: (_: number | null, line: CountLine) => {
        const draft = drafts[line.id];
        const unitId = draft?.unitId ?? line.countedUnitId ?? line.units.find((unit) => unit.conversionToBase === 1)?.id;
        const quantity = draft ? draft.quantity : line.countedQuantity;
        return (
          <div className="count-entry">
            <InputNumber
              min={0}
              value={quantity}
              disabled={!canCount}
              placeholder="Số đếm"
              className="count-input"
              ref={(instance) => {
                const element = (instance as unknown as { input?: HTMLInputElement } | null)?.input;
                if (element) inputs.current.set(line.id, element);
                else inputs.current.delete(line.id);
              }}
              onChange={(value) => setDraft(line, { quantity: value === null ? null : Number(value) })}
              onPressEnter={() => commitRow(line)}
            />
            <Select
              value={unitId}
              disabled={!canCount}
              className="count-unit"
              options={line.units.map((unit) => ({ value: unit.id, label: unit.name }))}
              onChange={(value) => setDraft(line, { unitId: value })}
            />
            {line.countedBaseQuantity !== null && canCount ? (
              <Tooltip title="Xóa số đã đếm">
                <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => save.mutate([{ lineId: line.id, clear: true }])} />
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      title: "Chênh lệch",
      dataIndex: "differenceBaseQuantity",
      width: 150,
      align: "right" as const,
      render: (value: number | null, line: CountLine) => {
        if (line.countedBaseQuantity === null) return <span className="cell-sub">Chưa đếm</span>;
        if (!value) {
          return (
            <Tag variant="filled" color="green">
              Khớp
            </Tag>
          );
        }
        return (
          <div className="cell-main" style={{ alignItems: "flex-end" }}>
            <span className={value > 0 ? "count-diff-plus" : "count-diff-minus"}>
              {value > 0 ? "+" : ""}
              {formatNumber(value)} {line.baseUnitName}
            </span>
            {line.differenceValue !== null ? <span className="cell-sub">{formatVnd(line.differenceValue)}</span> : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="count-board">
      <div className="count-head">
        <div>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>
            Danh sách đợt kiểm kê
          </Button>
          <h2>
            {count.code}
            {count.status === "COUNTING" ? (
              <Tag variant="filled" color="blue">
                Đang đếm
              </Tag>
            ) : count.status === "CLOSED" ? (
              <Tag variant="filled" color="green">
                Đã chốt
              </Tag>
            ) : (
              <Tag variant="filled">Đã hủy</Tag>
            )}
          </h2>
          <p>
            {count.scopeType === "ALL" ? "Toàn bộ kho" : count.scopeType === "CATEGORY" ? `Nhóm hàng: ${count.scopeLabel}` : `Kệ: ${count.scopeLabel}`} · Mở lúc {formatDateTime(count.startedAt)} bởi {count.createdByName}
            {count.closedAt ? ` · Chốt lúc ${formatDateTime(count.closedAt)}` : ""}
          </p>
        </div>
        {canCount ? (
          <div className="count-actions">
            <Button danger icon={<CloseCircleOutlined />} onClick={confirmCancel} loading={abandon.isPending}>
              Hủy đợt
            </Button>
            <Button icon={<SaveOutlined />} disabled={dirtyEntries.length === 0} loading={save.isPending} onClick={() => save.mutate(dirtyEntries)}>
              Lưu {dirtyEntries.length > 0 ? `${dirtyEntries.length} dòng` : "số đếm"}
            </Button>
            <Button type="primary" icon={<CheckCircleOutlined />} onClick={confirmClose} loading={finish.isPending} disabled={summary.countedLines === 0}>
              Chốt kiểm kê
            </Button>
          </div>
        ) : null}
      </div>

      {count.adjustment ? (
        <Alert
          className="count-banner"
          type="info"
          showIcon
          title={`Đã lập phiếu điều chỉnh ${count.adjustment.code} (${count.adjustment.status === "DRAFT" ? "chờ duyệt" : count.adjustment.status === "APPROVED" ? "đã duyệt" : "đã từ chối"})`}
          description="Tồn kho chỉ thay đổi sau khi phiếu được duyệt, người duyệt phải khác người lập."
          action={
            <Button size="small" onClick={() => void navigate("/dieu-chinh-ton")}>
              Mở phiếu
            </Button>
          }
        />
      ) : null}

      <div className="count-stats">
        <div className="count-stat">
          <span>Tiến độ</span>
          <Progress percent={progress} size="small" status={progress === 100 ? "success" : "active"} />
          <b>
            {formatNumber(summary.countedLines)}/{formatNumber(summary.totalLines)} dòng
          </b>
        </div>
        <div className="count-stat">
          <span>Chưa đếm</span>
          <b>{formatNumber(summary.pendingLines)}</b>
        </div>
        <div className="count-stat">
          <span>Thừa so với sổ</span>
          <b className="count-diff-plus">
            +{formatNumber(summary.surplusBaseQuantity)} <small>({formatNumber(summary.surplusLines)} dòng)</small>
          </b>
        </div>
        <div className="count-stat">
          <span>Thiếu so với sổ</span>
          <b className="count-diff-minus">
            −{formatNumber(summary.shortageBaseQuantity)} <small>({formatNumber(summary.shortageLines)} dòng)</small>
          </b>
        </div>
        {summary.differenceValue !== null ? (
          <div className="count-stat">
            <span>Giá trị chênh lệch</span>
            <b className={summary.differenceValue < 0 ? "count-diff-minus" : "count-diff-plus"}>{formatVnd(summary.differenceValue)}</b>
          </div>
        ) : null}
      </div>

      <div className="count-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Tìm tên thuốc, mã hoặc số lô"
          className="count-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Segmented
          value={filter}
          onChange={(value) => setFilter(value as Filter)}
          options={[
            { value: "ALL", label: `Tất cả (${formatNumber(summary.totalLines)})` },
            { value: "PENDING", label: `Chưa đếm (${formatNumber(summary.pendingLines)})` },
            { value: "COUNTED", label: `Đã đếm (${formatNumber(summary.countedLines)})` },
            { value: "DIFF", label: `Lệch (${formatNumber(summary.differenceLines)})` },
          ]}
        />
        {shelves.length > 0 ? (
          <Select allowClear placeholder="Mọi kệ" value={shelf} onChange={setShelf} className="count-shelf" options={shelves.map((value) => ({ value, label: value }))} />
        ) : null}
      </div>

      <Table
        rowKey="id"
        size="small"
        className="count-table"
        dataSource={visible}
        columns={columns}
        scroll={{ x: 720 }}
        pagination={visible.length > 50 ? { pageSize: 50, size: "small" } : false}
        rowClassName={(line) => (line.countedBaseQuantity === null ? "" : line.differenceBaseQuantity ? "count-row-diff" : "count-row-ok")}
        locale={{ emptyText: <Empty description="Không có dòng nào khớp bộ lọc" /> }}
      />

      {count.status === "COUNTING" ? (
        <Typography.Paragraph type="secondary" className="count-hint">
          Mẹo: gõ số rồi nhấn Enter để lưu dòng đó và nhảy xuống dòng kế tiếp. Vẫn bán hàng bình thường trong lúc kiểm kê — mỗi dòng so với tồn tại đúng lúc bạn đếm.
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}
