import { Tag } from "antd";
import type { GoodsReceiptDetail } from "../../../api/types.js";
import { STATUS } from "./receipt-status.js";

export function StatusTag({ status }: { status: GoodsReceiptDetail["status"] }) {
  const item = STATUS[status];
  return <Tag color={item.color}>{item.text}</Tag>;
}
