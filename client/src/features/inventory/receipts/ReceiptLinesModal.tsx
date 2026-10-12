import { Modal, Table, Tag } from "antd";
import { formatVnd, type GoodsReceiptDetail, type GoodsReceiptLine } from "../../../api/types.js";
import { formatDate, formatNumber } from "../../../ui/format.js";

export function ReceiptLinesModal({
  open,
  receipt,
  onClose,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail;
  onClose: () => void;
}) {
  const BATCH_STATUS: Record<string, { text: string; color: string }> = {
    AVAILABLE: { text: "Bán được", color: "green" },
    QUARANTINED: { text: "Biệt trữ", color: "orange" },
    RECALLED: { text: "Thu hồi", color: "red" },
  };
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1040}
      title={`Hàng hóa trong phiếu ${receipt.code}`}
    >
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={receipt.lines}
        scroll={{ x: 960, y: 460 }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6}>
                <strong>Tổng cộng {receipt.lines.length} mặt hàng</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <strong>{formatVnd(receipt.totalCost)}</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} />
            </Table.Summary.Row>
          </Table.Summary>
        )}
        columns={[
          {
            title: "Sản phẩm",
            key: "product",
            width: 230,
            render: (_: unknown, line: GoodsReceiptLine) => (
              <div className="cell-main">
                <strong>{line.productName}</strong>
                <span>{line.productCode}</span>
              </div>
            ),
          },
          { title: "Số lô", dataIndex: "batchNumber", width: 120 },
          {
            title: "NSX",
            key: "mfg",
            width: 100,
            render: (_: unknown, line: GoodsReceiptLine) => formatDate(line.manufactureDate),
          },
          {
            title: "HSD",
            key: "exp",
            width: 100,
            render: (_: unknown, line: GoodsReceiptLine) => formatDate(line.expiryDate),
          },
          {
            title: "Số lượng",
            key: "qty",
            width: 110,
            align: "right",
            render: (_: unknown, line: GoodsReceiptLine) =>
              `${formatNumber(line.quantity)} ${line.unitName}`,
          },
          {
            title: "Giá nhập",
            key: "cost",
            width: 110,
            align: "right",
            render: (_: unknown, line: GoodsReceiptLine) => formatVnd(line.unitCost),
          },
          {
            title: "Thành tiền",
            key: "lineCost",
            width: 120,
            align: "right",
            render: (_: unknown, line: GoodsReceiptLine) => (
              <strong>{formatVnd(line.lineCost)}</strong>
            ),
          },
          {
            title: "Lô trong kho",
            key: "batch",
            width: 130,
            render: (_: unknown, line: GoodsReceiptLine) =>
              line.batchStatus ? (
                <Tag color={BATCH_STATUS[line.batchStatus]?.color}>
                  {BATCH_STATUS[line.batchStatus]?.text}
                </Tag>
              ) : (
                <span className="text-secondary">Chưa nhập kho</span>
              ),
          },
        ]}
      />
    </Modal>
  );
}
