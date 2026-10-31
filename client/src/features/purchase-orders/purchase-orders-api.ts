import { http } from "../../api/http.js";
import type { Envelope, Paged } from "../../api/types.js";
import { downloadFile } from "../excel/excel-api.js";

/** Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32). */

export type PurchaseOrderStatus = "DRAFT" | "SENT" | "PARTIAL" | "RECEIVED" | "CANCELLED";

export const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: "Nháp",
  SENT: "Đã gửi",
  PARTIAL: "Nhận một phần",
  RECEIVED: "Đã nhận đủ",
  CANCELLED: "Đã hủy",
};

export const STATUS_COLOR: Record<PurchaseOrderStatus, string> = {
  DRAFT: "default",
  SENT: "processing",
  PARTIAL: "warning",
  RECEIVED: "success",
  CANCELLED: "error",
};

export type PurchaseOrderListItem = {
  id: string;
  code: string;
  status: PurchaseOrderStatus;
  supplierName: string;
  expectedDate: string | null;
  estimatedAmount: number;
  lineCount: number;
  createdAt: string;
  sentAt: string | null;
  sentVia: "EMAIL" | "MANUAL" | null;
};

export type PurchaseOrderLine = {
  id: string;
  lineNo: number;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  unitName: string;
  conversionToBase: number;
  baseUnitName: string;
  quantity: number;
  baseQuantity: number;
  unitPrice: number | null;
  lineAmount: number | null;
  receivedBaseQuantity: number;
  remainingBaseQuantity: number;
  remainingQuantity: number;
};

export type PurchaseOrderDetail = {
  id: string;
  code: string;
  status: PurchaseOrderStatus;
  store: { code: string; name: string; address: string | null; phone: string | null };
  supplier: {
    id: string;
    name: string;
    taxCode: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
  };
  expectedDate: string | null;
  note: string | null;
  estimatedAmount: number;
  createdAt: string;
  createdBy: { fullName: string } | null;
  sentAt: string | null;
  sentBy: { fullName: string } | null;
  sentVia: "EMAIL" | "MANUAL" | null;
  sentTo: string | null;
  cancelledAt: string | null;
  cancelledBy: { fullName: string } | null;
  cancelReason: string | null;
  version: number;
  lines: PurchaseOrderLine[];
  goodsReceipts: Array<{
    id: string;
    code: string;
    status: string;
    receivedAt: string;
    totalCost: number;
  }>;
  mailEnabled: boolean;
  mailFrom: string | null;
};

export type OrderLineInput = {
  productId: string;
  unitId: string;
  quantity: number;
  unitPrice: number | null;
};

export type OrderInput = {
  supplierId: string;
  expectedDate: string | null;
  note: string | null;
  lines: OrderLineInput[];
};

export const purchaseOrdersApi = {
  list: async (params: { status?: string; search?: string; page: number }) =>
    (
      await http.get<Envelope<Paged<PurchaseOrderListItem> & { mailEnabled: boolean }>>(
        "/purchase-orders",
        { params: { ...params, limit: 20 } },
      )
    ).data.data,
  detail: async (id: string) =>
    (await http.get<Envelope<PurchaseOrderDetail>>(`/purchase-orders/${id}`)).data.data,
  create: async (input: OrderInput) =>
    (await http.post<Envelope<PurchaseOrderDetail>>("/purchase-orders", input)).data.data,
  update: async (id: string, input: OrderInput & { version: number }) =>
    (await http.patch<Envelope<PurchaseOrderDetail>>(`/purchase-orders/${id}`, input)).data.data,
  send: async (
    id: string,
    body: { channel: "MANUAL" } | { channel: "EMAIL"; to: string; message: string | null },
  ) =>
    (await http.post<Envelope<PurchaseOrderDetail>>(`/purchase-orders/${id}/send`, body)).data.data,
  cancel: async (id: string, reason: string) =>
    (await http.post<Envelope<PurchaseOrderDetail>>(`/purchase-orders/${id}/cancel`, { reason }))
      .data.data,
  excel: (id: string, code: string) =>
    downloadFile(`/purchase-orders/${id}/excel`, {}, `don-dat-hang-${code}.xlsx`),
};

/** Dòng phiếu nhập điền sẵn từ đơn: chỉ số còn thiếu, theo đơn vị đặt. */
export function receiptLinesFromOrder(order: PurchaseOrderDetail) {
  return order.lines
    .filter((line) => line.remainingBaseQuantity > 0)
    .map((line) => ({
      productId: line.productId,
      unitName: line.unitName,
      quantity: line.remainingQuantity,
      unitCost: line.unitPrice ?? 0,
    }));
}

export function canReceive(status: PurchaseOrderStatus): boolean {
  return status === "SENT" || status === "PARTIAL";
}
