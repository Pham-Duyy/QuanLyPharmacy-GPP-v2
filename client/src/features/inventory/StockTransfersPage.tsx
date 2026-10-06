import {
  CarOutlined,
  CheckCircleOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  PrinterOutlined,
  RollbackOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tag,
} from "antd";
import { useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { printDocument, printUrl } from "../printing/printing.js";

type Status = "DRAFT" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
type Direction = "OUT" | "IN";
type StoreRef = { id: string; code: string; name: string; address?: string | null };

type Transferable = {
  batchId: string;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  quantityOnHand: number;
  units: Array<{ id: string; name: string; conversionToBase: number }>;
};

type TransferListItem = {
  id: string;
  code: string;
  status: Status;
  fromStore: StoreRef;
  toStore: StoreRef;
  totalValue: number | null;
  createdAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
  createdByName: string;
  lineCount: number;
};

type TransferLine = {
  id: string;
  lineNo: number;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  unitName: string;
  conversionToBase: number;
  baseUnitName: string;
  quantity: number;
  baseQuantity: number;
  unitCost: number | null;
  receivedBaseQuantity: number | null;
  shortageBaseQuantity: number | null;
  passed: boolean | null;
  rejectReason: string | null;
};

type TransferDetail = Omit<TransferListItem, "lineCount"> & {
  direction: Direction;
  note: string | null;
  shippedByName: string | null;
  receivedByName: string | null;
  receiveNote: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  lines: TransferLine[];
};

type ReceiveRow = { received: number; passed: boolean; rejectReason: string };

const STATUS: Record<Status, { label: string; color?: string }> = {
  DRAFT: { label: "Nháp", color: "gold" },
  IN_TRANSIT: { label: "Đang chuyển", color: "blue" },
  RECEIVED: { label: "Đã nhận", color: "green" },
  CANCELLED: { label: "Đã hủy" },
};

const statusTag = (status: Status) => (
  <Tag variant="filled" color={STATUS[status].color}>
    {STATUS[status].label}
  </Tag>
);

/** Đơn vị mặc định: đơn vị lớn nhất mà tồn còn đủ ít nhất một đơn vị. */
function defaultUnit(row: Transferable) {
  const fits = row.units.filter((unit) => unit.conversionToBase <= row.quantityOnHand);
  return fits.at(-1) ?? row.units[0]!;
}

/** "500 viên (5 Hộp)": số nhỏ nhất kèm quy đổi khi chia hết. */
function baseText(
  quantity: number,
  line: Pick<TransferLine, "baseUnitName" | "unitName" | "conversionToBase">,
) {
  const base = `${formatNumber(quantity)} ${line.baseUnitName}`;
  if (line.conversionToBase <= 1 || quantity % line.conversionToBase !== 0) return base;
  return `${base} (${formatNumber(quantity / line.conversionToBase)} ${line.unitName})`;
}

/** Hàng hóa → Chuyển hàng giữa các cửa hàng (contract §10.9). */
export function StockTransfersPage() {
  const { can, storeId } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const canCreate = can("stock.transfer.create");
  const canReceive = can("stock.transfer.receive");

  const [direction, setDirection] = useState<Direction>("OUT");
  const [statusFilter, setStatusFilter] = useState<Status | "ALL">("ALL");
  const [creating, setCreating] = useState(false);
  const [toStoreId, setToStoreId] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 300);
  const [picked, setPicked] = useState<Record<string, { unitId: string; quantity: number }>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<TransferDetail | null>(null);
  const [receiveRows, setReceiveRows] = useState<Record<string, ReceiveRow>>({});
  const [discrepancy, setDiscrepancy] = useState(false);
  const [cancelling, setCancelling] = useState<TransferDetail | null>(null);
  const [createForm] = Form.useForm<{ note?: string }>();
  const [receiveForm] = Form.useForm<{ note?: string }>();
  const [cancelForm] = Form.useForm<{ reason: string }>();
  // Cùng nội dung thì giữ nguyên khóa: bấm lại sau lỗi mạng không tạo phiếu thứ hai.
  const createAttempt = useRef<{ signature: string; key: string } | null>(null);

  const list = useQuery({
    queryKey: ["stock-transfers", storeId, direction, statusFilter],
    queryFn: async () =>
      (
        await http.get<Envelope<TransferListItem[]>>("/stock-transfers", {
          params: { direction, status: statusFilter === "ALL" ? undefined : statusFilter },
        })
      ).data.data,
  });

  const incoming = useQuery({
    queryKey: ["stock-transfers-incoming", storeId],
    queryFn: async () =>
      (await http.get<Envelope<{ inTransit: number }>>("/stock-transfers/incoming-count")).data.data
        .inTransit,
  });

  const detail = useQuery({
    queryKey: ["stock-transfer", storeId, openId],
    enabled: Boolean(openId),
    queryFn: async () =>
      (await http.get<Envelope<TransferDetail>>(`/stock-transfers/${openId}`)).data.data,
  });

  const destinations = useQuery({
    queryKey: ["stock-transfer-destinations", storeId],
    enabled: canCreate,
    queryFn: async () =>
      (await http.get<Envelope<StoreRef[]>>("/stock-transfers/destinations")).data.data,
  });

  const transferable = useQuery({
    queryKey: ["stock-transfer-batches", storeId, debouncedSearch],
    enabled: creating,
    queryFn: async () =>
      (
        await http.get<Envelope<Transferable[]>>("/stock-transfers/transferable", {
          params: { search: debouncedSearch || undefined },
        })
      ).data.data,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
    await queryClient.invalidateQueries({ queryKey: ["stock-transfer"] });
    await queryClient.invalidateQueries({ queryKey: ["stock-transfers-incoming"] });
    await queryClient.invalidateQueries({ queryKey: ["batches"] });
  };

  const create = useMutation({
    mutationFn: async (values: { note?: string }) => {
      const body = {
        toStoreId,
        note: values.note || null,
        lines: Object.entries(picked).map(([batchId, line]) => ({
          batchId,
          unitId: line.unitId,
          quantity: line.quantity,
        })),
      };
      const signature = JSON.stringify(body);
      if (createAttempt.current?.signature !== signature) {
        createAttempt.current = { signature, key: crypto.randomUUID() };
      }
      return http.post<Envelope<TransferDetail>>("/stock-transfers", body, {
        headers: { "Idempotency-Key": createAttempt.current.key },
      });
    },
    onSuccess: async (response) => {
      createAttempt.current = null;
      void message.success(
        `Đã lập phiếu ${response.data.data.code}. Tồn kho chưa trừ cho tới khi xác nhận xuất.`,
      );
      setCreating(false);
      setPicked({});
      setDirection("OUT");
      setOpenId(response.data.data.id);
      await refresh();
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không lập được phiếu chuyển"), 8),
  });

  const ship = useMutation({
    mutationFn: async (id: string) =>
      http.post(
        `/stock-transfers/${id}/ship`,
        {},
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã xuất kho. Hàng đang trên đường, chờ cửa hàng nhận kiểm nhập.");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận xuất được"), 8),
  });

  const receive = useMutation({
    mutationFn: async (values: { note?: string }) =>
      http.post(
        `/stock-transfers/${receiving!.id}/receive`,
        {
          note: values.note || null,
          lines: receiving!.lines.map((line) => {
            const row = receiveRows[line.id]!;
            return {
              lineId: line.id,
              receivedBaseQuantity: row.received,
              passed: row.passed,
              rejectReason: row.passed ? null : row.rejectReason || null,
            };
          }),
        },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã nhận hàng, tồn kho cửa hàng đã cộng");
      setReceiving(null);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ghi nhận được"), 8),
  });

  const cancel = useMutation({
    mutationFn: async (values: { reason: string }) =>
      http.post(
        `/stock-transfers/${cancelling!.id}/cancel`,
        { reason: values.reason },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success(
        cancelling?.status === "IN_TRANSIT"
          ? "Đã thu hồi phiếu, hàng đã về lại kho"
          : "Đã hủy phiếu chuyển",
      );
      setCancelling(null);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu")),
  });

  const pickedCount = Object.keys(picked).length;
  const shortageInReceive = useMemo(
    () =>
      receiving
        ? receiving.lines.some(
            (line) => (receiveRows[line.id]?.received ?? line.baseQuantity) < line.baseQuantity,
          )
        : false,
    [receiving, receiveRows],
  );

  function openReceive(transfer: TransferDetail) {
    setReceiveRows(
      Object.fromEntries(
        transfer.lines.map((line) => [
          line.id,
          { received: line.baseQuantity, passed: true, rejectReason: "" },
        ]),
      ),
    );
    setDiscrepancy(false);
    setReceiving(transfer);
  }

  function confirmShip(transfer: TransferDetail) {
    modal.confirm({
      title: `Xác nhận xuất ${transfer.code}?`,
      content: `Tồn kho các lô trên phiếu bị trừ ngay. Hàng chỉ vào tồn ${transfer.toStore.code} khi bên đó nhận và kiểm nhập.`,
      okText: "Xuất kho",
      cancelText: "Quay lại",
      onOk: () => ship.mutateAsync(transfer.id),
    });
  }

  const noOtherStore = destinations.isSuccess && destinations.data.length === 0;
  const data = detail.data;
  const isOut = data?.direction === "OUT";

  return (
    <div>
      <PageHeader
        icon={<CarOutlined />}
        title="Chuyển hàng giữa cửa hàng"
        extra={
          canCreate ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={noOtherStore}
              onClick={() => {
                setCreating(true);
                setPicked({});
                setSearch("");
                setToStoreId(undefined);
              }}
            >
              Lập phiếu chuyển
            </Button>
          ) : null
        }
      />

      {noOtherStore ? (
        <Alert
          type="info"
          showIcon
          className="count-banner"
          title="Chuỗi chỉ có một cửa hàng đang hoạt động"
          description="Mở thêm cửa hàng ở Quản trị → Cửa hàng thì mới chuyển hàng được."
        />
      ) : null}
      {list.isError ? (
        <Alert
          type="error"
          showIcon
          title="Không đọc được danh sách phiếu chuyển"
          description={getErrorMessage(list.error)}
        />
      ) : null}

      <Card>
        <div className="count-toolbar">
          <Segmented
            value={direction}
            onChange={(value) => {
              setDirection(value as Direction);
              setStatusFilter("ALL");
            }}
            options={[
              { value: "OUT", label: "Chuyển đi", icon: <ExportOutlined /> },
              {
                value: "IN",
                label: (
                  <Badge count={incoming.data ?? 0} size="small" offset={[10, -2]}>
                    <span>Nhận về</span>
                  </Badge>
                ),
                icon: <ImportOutlined />,
              },
            ]}
          />
          <Segmented
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as Status | "ALL")}
            options={[
              { value: "ALL", label: "Tất cả" },
              ...(direction === "OUT" ? [{ value: "DRAFT", label: "Nháp" }] : []),
              { value: "IN_TRANSIT", label: "Đang chuyển" },
              { value: "RECEIVED", label: "Đã nhận" },
              { value: "CANCELLED", label: "Đã hủy" },
            ]}
          />
        </div>

        {list.isLoading ? (
          <Skeleton active />
        ) : (
          <Table
            rowKey="id"
            size="small"
            dataSource={list.data ?? []}
            scroll={{ x: 820 }}
            pagination={(list.data?.length ?? 0) > 20 ? { pageSize: 20, size: "small" } : false}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            columns={[
              {
                title: "Phiếu chuyển",
                dataIndex: "code",
                render: (code: string, row: TransferListItem) => (
                  <div className="cell-main">
                    <span className="cell-title">{code}</span>
                    <span className="cell-sub">
                      {formatDateTime(row.createdAt)} · {row.createdByName} ·{" "}
                      {formatNumber(row.lineCount)} dòng
                    </span>
                  </div>
                ),
              },
              {
                title: direction === "OUT" ? "Chuyển đến" : "Chuyển từ",
                key: "store",
                render: (_: unknown, row: TransferListItem) => {
                  const store = direction === "OUT" ? row.toStore : row.fromStore;
                  return `${store.code} · ${store.name}`;
                },
              },
              {
                title: "Xuất / nhận",
                key: "dates",
                width: 200,
                render: (_: unknown, row: TransferListItem) => (
                  <div className="cell-main">
                    <span className="cell-sub">
                      Xuất: {row.shippedAt ? formatDateTime(row.shippedAt) : "—"}
                    </span>
                    <span className="cell-sub">
                      Nhận: {row.receivedAt ? formatDateTime(row.receivedAt) : "—"}
                    </span>
                  </div>
                ),
              },
              ...(can("stock.cost.read")
                ? [
                    {
                      title: "Giá vốn",
                      dataIndex: "totalValue",
                      width: 130,
                      align: "right" as const,
                      render: (value: number | null) => (value === null ? "—" : formatVnd(value)),
                    },
                  ]
                : []),
              {
                title: "Trạng thái",
                dataIndex: "status",
                width: 120,
                render: (status: Status) => statusTag(status),
              },
            ]}
            locale={{
              emptyText: (
                <Empty
                  description={
                    direction === "OUT"
                      ? "Chưa có phiếu chuyển đi"
                      : "Chưa có hàng chuyển đến cửa hàng này"
                  }
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title="Lập phiếu chuyển hàng"
        open={creating}
        onCancel={() => setCreating(false)}
        width={920}
        okText={
          pickedCount > 0 ? `Lập phiếu nháp · ${formatNumber(pickedCount)} lô` : "Lập phiếu nháp"
        }
        cancelText="Hủy"
        okButtonProps={{ disabled: pickedCount === 0 || !toStoreId }}
        confirmLoading={create.isPending}
        onOk={() => createForm.submit()}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={(values) => create.mutate(values)}>
          <div className="count-toolbar">
            <Select
              placeholder="Chọn cửa hàng nhận"
              style={{ minWidth: 280 }}
              loading={destinations.isLoading}
              value={toStoreId}
              onChange={setToStoreId}
              options={(destinations.data ?? []).map((store) => ({
                value: store.id,
                label: `${store.code} · ${store.name}`,
              }))}
            />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Tìm tên hoặc mã thuốc"
              className="count-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Table
            rowKey="batchId"
            size="small"
            className="count-banner"
            loading={transferable.isFetching}
            dataSource={transferable.data ?? []}
            pagination={
              (transferable.data?.length ?? 0) > 8 ? { pageSize: 8, size: "small" } : false
            }
            scroll={{ x: 640 }}
            columns={[
              {
                title: "Sản phẩm / lô",
                dataIndex: "productName",
                render: (_: string, row: Transferable) => (
                  <div className="cell-main">
                    <span className="cell-title">{row.productName}</span>
                    <span className="cell-sub">
                      {row.productCode} · Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)}
                    </span>
                  </div>
                ),
              },
              {
                title: "Tồn",
                dataIndex: "quantityOnHand",
                width: 90,
                align: "right",
                render: (value: number) => formatNumber(value),
              },
              {
                title: "Chuyển",
                dataIndex: "batchId",
                width: 260,
                render: (batchId: string, row: Transferable) => {
                  const current = picked[batchId];
                  const unitId = current?.unitId ?? defaultUnit(row).id;
                  const conversion =
                    row.units.find((unit) => unit.id === unitId)?.conversionToBase ?? 1;
                  const maxQuantity = Math.floor(row.quantityOnHand / conversion);
                  const setLine = (nextUnitId: string, quantity: number) =>
                    setPicked((state) => {
                      const next = { ...state };
                      if (quantity > 0) next[batchId] = { unitId: nextUnitId, quantity };
                      else delete next[batchId];
                      return next;
                    });
                  return (
                    <div className="count-entry">
                      <InputNumber
                        min={0}
                        max={maxQuantity}
                        className="count-input"
                        aria-label={`Số lượng chuyển lô ${row.batchNumber}`}
                        value={current?.quantity ?? 0}
                        onChange={(value) =>
                          setLine(unitId, Math.min(Number(value ?? 0), maxQuantity))
                        }
                      />
                      <Select
                        className="count-unit"
                        value={unitId}
                        options={row.units.map((unit) => ({
                          value: unit.id,
                          label: unit.name,
                          disabled: unit.conversionToBase > row.quantityOnHand,
                        }))}
                        onChange={(value) => {
                          const nextConversion =
                            row.units.find((unit) => unit.id === value)?.conversionToBase ?? 1;
                          setLine(
                            value,
                            Math.min(
                              current?.quantity ?? 0,
                              Math.floor(row.quantityOnHand / nextConversion),
                            ),
                          );
                        }}
                      />
                      <span className="cell-sub">tối đa {formatNumber(maxQuantity)}</span>
                    </div>
                  );
                },
              },
            ]}
            locale={{ emptyText: <Empty description="Không có lô nào chuyển được" /> }}
          />
          <Form.Item name="note" label="Ghi chú">
            <Input.TextArea
              rows={2}
              maxLength={500}
              placeholder="Ví dụ: dồn hàng cận hạn sang cửa hàng bán chạy hơn"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={data ? `Phiếu chuyển ${data.code}` : "Phiếu chuyển hàng"}
        open={Boolean(openId)}
        onCancel={() => setOpenId(null)}
        width={880}
        destroyOnHidden
        footer={
          data ? (
            <div
              className="expiry-actions"
              style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
            >
              <Button
                icon={<PrinterOutlined />}
                onClick={() => void printDocument(printUrl.stockTransfer(data.id), message)}
              >
                In phiếu
              </Button>
              {isOut && canCreate && data.status === "DRAFT" ? (
                <Button danger icon={<StopOutlined />} onClick={() => setCancelling(data)}>
                  Hủy phiếu
                </Button>
              ) : null}
              {isOut && canCreate && data.status === "IN_TRANSIT" ? (
                <Button danger icon={<RollbackOutlined />} onClick={() => setCancelling(data)}>
                  Thu hồi phiếu
                </Button>
              ) : null}
              <Button onClick={() => setOpenId(null)}>Đóng</Button>
              {isOut && canCreate && data.status === "DRAFT" ? (
                <Button
                  type="primary"
                  icon={<ExportOutlined />}
                  loading={ship.isPending}
                  onClick={() => confirmShip(data)}
                >
                  Xác nhận xuất
                </Button>
              ) : null}
              {!isOut && canReceive && data.status === "IN_TRANSIT" ? (
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  onClick={() => openReceive(data)}
                >
                  Nhận hàng
                </Button>
              ) : null}
            </div>
          ) : (
            <Button onClick={() => setOpenId(null)}>Đóng</Button>
          )
        }
      >
        {detail.isLoading ? <Skeleton active /> : null}
        {detail.isError ? (
          <Alert
            type="error"
            showIcon
            title="Không đọc được phiếu"
            description={getErrorMessage(detail.error)}
          />
        ) : null}
        {data ? (
          <>
            <Alert
              className="count-banner"
              type={
                data.status === "RECEIVED"
                  ? "success"
                  : data.status === "CANCELLED"
                    ? "warning"
                    : "info"
              }
              showIcon
              title={
                <span>
                  {statusTag(data.status)} {data.fromStore.code} · {data.fromStore.name} →{" "}
                  {data.toStore.code} · {data.toStore.name}
                </span>
              }
              description={
                <span>
                  Lập bởi {data.createdByName} lúc {formatDateTime(data.createdAt)}
                  {data.shippedAt
                    ? ` · xuất bởi ${data.shippedByName ?? "—"} lúc ${formatDateTime(data.shippedAt)}`
                    : ""}
                  {data.receivedAt
                    ? ` · nhận bởi ${data.receivedByName ?? "—"} lúc ${formatDateTime(data.receivedAt)}`
                    : ""}
                  {data.note ? (
                    <>
                      <br />
                      Ghi chú: {data.note}
                    </>
                  ) : null}
                  {data.receiveNote ? (
                    <>
                      <br />
                      Khi nhận: {data.receiveNote}
                    </>
                  ) : null}
                  {data.cancelReason ? (
                    <>
                      <br />
                      Hủy bởi {data.cancelledByName ?? "—"}: {data.cancelReason}
                    </>
                  ) : null}
                  {data.status === "DRAFT" ? (
                    <>
                      <br />
                      Tồn kho chưa bị trừ; chỉ trừ khi xác nhận xuất.
                    </>
                  ) : null}
                </span>
              }
            />
            <Table
              rowKey="id"
              size="small"
              dataSource={data.lines}
              pagination={false}
              scroll={{ x: 700 }}
              columns={[
                {
                  title: "Sản phẩm / lô",
                  dataIndex: "productName",
                  render: (_: string, row: TransferLine) => (
                    <div className="cell-main">
                      <span className="cell-title">{row.productName}</span>
                      <span className="cell-sub">
                        {row.productCode} · Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)}
                      </span>
                    </div>
                  ),
                },
                {
                  title: "Gửi",
                  dataIndex: "quantity",
                  width: 150,
                  align: "right",
                  render: (value: number, row: TransferLine) =>
                    `${formatNumber(value)} ${row.unitName}`,
                },
                {
                  title: "Thực nhận",
                  dataIndex: "receivedBaseQuantity",
                  width: 210,
                  align: "right",
                  render: (value: number | null, row: TransferLine) =>
                    value === null ? (
                      "—"
                    ) : (
                      <div className="cell-main" style={{ alignItems: "flex-end" }}>
                        <span className="cell-title">{baseText(value, row)}</span>
                        {row.shortageBaseQuantity ? (
                          <span className="cell-sub">
                            <Tag color="orange">Thiếu {formatNumber(row.shortageBaseQuantity)}</Tag>
                          </span>
                        ) : null}
                        {row.passed === false ? (
                          <span className="cell-sub">
                            <Tag color="red">Không đạt — biệt trữ</Tag> {row.rejectReason}
                          </span>
                        ) : null}
                      </div>
                    ),
                },
                ...(data.totalValue !== null
                  ? [
                      {
                        title: "Giá vốn",
                        dataIndex: "unitCost",
                        width: 120,
                        align: "right" as const,
                        render: (value: number | null) =>
                          value === null ? "Chưa có" : `${formatVnd(value)}/đv`,
                      },
                    ]
                  : []),
              ]}
            />
          </>
        ) : null}
      </Modal>

      <Modal
        title={receiving ? `Nhận hàng ${receiving.code}` : ""}
        open={Boolean(receiving)}
        onCancel={() => setReceiving(null)}
        width={discrepancy ? 880 : 640}
        okText={discrepancy ? "Xác nhận đã nhận" : "Nhận đủ"}
        cancelText="Quay lại"
        confirmLoading={receive.isPending}
        onOk={() => receiveForm.submit()}
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            {discrepancy ? null : <Button onClick={() => setDiscrepancy(true)}>Có sai lệch</Button>}
            <CancelBtn />
            <OkBtn />
          </>
        )}
        destroyOnHidden
      >
        {receiving ? (
          <Form
            form={receiveForm}
            layout="vertical"
            onFinish={(values) => {
              const missing = receiving.lines.find((line) => {
                const row = receiveRows[line.id];
                return row && !row.passed && !row.rejectReason.trim();
              });
              if (missing) {
                void message.error(`Lô ${missing.batchNumber}: hàng không đạt phải ghi lý do`);
                return;
              }
              receive.mutate(values);
            }}
          >
            {discrepancy ? (
              <p className="section-note" style={{ marginTop: 0 }}>
                Ghi số thực nhận (đơn vị nhỏ nhất). Phần thiếu tính là hao hụt; hàng không đạt vào
                biệt trữ.
              </p>
            ) : (
              <p className="section-note" style={{ marginTop: 0 }}>
                Đếm đủ và hàng đạt thì bấm <b>Nhận đủ</b>. Thiếu hoặc hỏng thì bấm{" "}
                <b>Có sai lệch</b>.
              </p>
            )}
            {discrepancy ? (
              <Table
                rowKey="id"
                size="small"
                dataSource={receiving.lines}
                pagination={false}
                scroll={{ x: 720 }}
                columns={[
                  {
                    title: "Sản phẩm / lô",
                    dataIndex: "productName",
                    render: (_: string, row: TransferLine) => (
                      <div className="cell-main">
                        <span className="cell-title">{row.productName}</span>
                        <span className="cell-sub">
                          Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)} · gửi{" "}
                          {baseText(row.baseQuantity, row)}
                        </span>
                      </div>
                    ),
                  },
                  {
                    title: "Thực nhận",
                    dataIndex: "id",
                    width: 170,
                    render: (id: string, row: TransferLine) => (
                      <div className="count-entry">
                        <InputNumber
                          min={0}
                          max={row.baseQuantity}
                          className="count-input"
                          aria-label={`Thực nhận lô ${row.batchNumber}`}
                          value={receiveRows[id]?.received ?? row.baseQuantity}
                          onChange={(value) =>
                            setReceiveRows((state) => ({
                              ...state,
                              [id]: {
                                ...state[id]!,
                                received: Math.min(
                                  Math.max(Number(value ?? 0), 0),
                                  row.baseQuantity,
                                ),
                              },
                            }))
                          }
                        />
                        <span className="cell-sub">{row.baseUnitName}</span>
                      </div>
                    ),
                  },
                  {
                    title: "Kiểm nhập",
                    key: "passed",
                    width: 260,
                    render: (_: unknown, row: TransferLine) => {
                      const current = receiveRows[row.id];
                      return (
                        <div className="cell-main">
                          <Checkbox
                            checked={current?.passed ?? true}
                            onChange={(event) =>
                              setReceiveRows((state) => ({
                                ...state,
                                [row.id]: { ...state[row.id]!, passed: event.target.checked },
                              }))
                            }
                          >
                            Đạt
                          </Checkbox>
                          {current && !current.passed ? (
                            <Input
                              size="small"
                              maxLength={300}
                              status={current.rejectReason.trim() ? undefined : "error"}
                              placeholder="Lý do không đạt (bắt buộc)"
                              value={current.rejectReason}
                              onChange={(event) =>
                                setReceiveRows((state) => ({
                                  ...state,
                                  [row.id]: { ...state[row.id]!, rejectReason: event.target.value },
                                }))
                              }
                            />
                          ) : null}
                        </div>
                      );
                    },
                  },
                ]}
              />
            ) : (
              <Table
                rowKey="id"
                size="small"
                dataSource={receiving.lines}
                pagination={false}
                columns={[
                  {
                    title: "Sản phẩm / lô",
                    dataIndex: "productName",
                    render: (_: string, row: TransferLine) => (
                      <div className="cell-main">
                        <span className="cell-title">{row.productName}</span>
                        <span className="cell-sub">
                          Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)}
                        </span>
                      </div>
                    ),
                  },
                  {
                    title: "Số lượng",
                    dataIndex: "quantity",
                    width: 130,
                    align: "right",
                    render: (value: number, row: TransferLine) =>
                      `${formatNumber(value)} ${row.unitName}`,
                  },
                ]}
              />
            )}
            {discrepancy ? (
              <Form.Item
                name="note"
                label={
                  shortageInReceive ? "Lý do hao hụt (bắt buộc khi nhận thiếu)" : "Ghi chú khi nhận"
                }
                style={{ marginTop: 12 }}
                rules={
                  shortageInReceive
                    ? [
                        {
                          required: true,
                          whitespace: true,
                          message: "Nhận thiếu phải ghi lý do hao hụt",
                        },
                      ]
                    : []
                }
              >
                <Input.TextArea
                  rows={2}
                  maxLength={500}
                  placeholder="Ví dụ: vỡ 1 chai khi vận chuyển"
                />
              </Form.Item>
            ) : null}
          </Form>
        ) : null}
      </Modal>

      <Modal
        title={
          cancelling
            ? cancelling.status === "IN_TRANSIT"
              ? `Thu hồi phiếu ${cancelling.code}?`
              : `Hủy phiếu ${cancelling.code}?`
            : ""
        }
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        okText={cancelling?.status === "IN_TRANSIT" ? "Thu hồi phiếu" : "Hủy phiếu"}
        okButtonProps={{ danger: true }}
        cancelText="Quay lại"
        confirmLoading={cancel.isPending}
        onOk={() => cancelForm.submit()}
        destroyOnHidden
      >
        <Form form={cancelForm} layout="vertical" onFinish={(values) => cancel.mutate(values)}>
          <p>
            {cancelling?.status === "IN_TRANSIT"
              ? `Hàng chưa tới ${cancelling.toStore.code}: thu hồi thì số lượng trên phiếu cộng lại đúng các lô cũ của cửa hàng này. Chỉ làm khi hàng thật đã quay về.`
              : "Phiếu còn nháp nên chưa trừ tồn kho. Hủy xong phiếu vẫn nằm trong danh sách để tra lại."}
          </p>
          <Form.Item
            name="reason"
            label="Lý do"
            rules={[{ required: true, whitespace: true, message: "Phải ghi lý do" }]}
          >
            <Input.TextArea
              rows={2}
              maxLength={500}
              placeholder="Ví dụ: xe giao hàng không đi được"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
