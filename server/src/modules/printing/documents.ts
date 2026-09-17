import { prisma } from "../../db/prisma.js";
import * as receipts from "../inventory/goods-receipts.service.js";
import * as adjustments from "../inventory/stock-adjustments.service.js";
import * as returns from "../sales/returns.service.js";
import type { DocumentType } from "../settings/document-print.schema.js";
import type { PrintDocument } from "./document-print.js";
import { money, num, printDate, printDateTime } from "./print-common.js";

const PAYMENT_LABEL: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  CARD: "Thẻ",
};

const ADJUST_REASON: Record<string, string> = {
  COUNT_DIFFERENCE: "Kiểm kê lệch",
  DAMAGED: "Hư hỏng",
  EXPIRED_DISPOSAL: "Hết hạn, xuất hủy",
  RECALL_DISPOSAL: "Thu hồi, xuất hủy",
  OTHER: "Khác",
};

type Amount = number | bigint;

// ---------------------------------------------------------------------------
// Phiếu nhập kho
// ---------------------------------------------------------------------------

export type ReceiptForPrint = {
  code: string;
  status: string;
  supplier: {
    name: string;
    phone?: string | null;
    address?: string | null;
    taxCode?: string | null;
  } | null;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: Date | string | null;
  receivedAt: Date | string;
  note: string | null;
  goodsAmount: Amount;
  discountAmount: Amount;
  vatAmount: Amount;
  totalCost: Amount;
  createdBy: { fullName: string } | null;
  confirmedAt: Date | string | null;
  confirmedBy: { fullName: string } | null;
  cancelReason: string | null;
  lines: Array<{
    productCode: string;
    productName: string;
    unitName: string;
    quantity: number;
    unitCost: Amount;
    lineCost: Amount;
    batchNumber: string;
    manufactureDate: Date | string | null;
    expiryDate: Date | string;
  }>;
};

export function goodsReceiptDocument(receipt: ReceiptForPrint): PrintDocument {
  const stamp =
    receipt.status === "DRAFT"
      ? "Bản nháp — chưa kiểm nhập, chưa ghi nhận vào kho"
      : receipt.status === "CANCELLED"
        ? `Phiếu đã hủy${receipt.cancelReason ? `: ${receipt.cancelReason}` : ""}`
        : null;
  const invoiceRef = receipt.supplierInvoiceNumber
    ? `${receipt.supplierInvoiceNumber}${receipt.supplierInvoiceDate ? ` ngày ${printDate(receipt.supplierInvoiceDate)}` : ""}`
    : null;

  return {
    code: receipt.code,
    date: receipt.receivedAt,
    stamp,
    info: [
      { label: "Ngày nhận hàng", value: printDateTime(receipt.receivedAt) },
      { label: "Nhà cung cấp", value: receipt.supplier?.name },
      { label: "Địa chỉ NCC", value: receipt.supplier?.address },
      { label: "Điện thoại NCC", value: receipt.supplier?.phone },
      { label: "MST NCC", value: receipt.supplier?.taxCode },
      { label: "Hóa đơn NCC", value: invoiceRef },
      { label: "Người lập", value: receipt.createdBy?.fullName },
      {
        label: "Kiểm nhập",
        value: receipt.confirmedBy
          ? `${receipt.confirmedBy.fullName}${receipt.confirmedAt ? ` lúc ${printDateTime(receipt.confirmedAt)}` : ""}`
          : null,
      },
    ],
    columns: [
      { label: "Tên thuốc", role: "name" },
      { label: "ĐVT", role: "detail", align: "center", nowrap: true },
      { label: "Số lô", role: "detail", nowrap: true },
      { label: "HSD", role: "detail", align: "center", nowrap: true },
      { label: "SL", role: "detail", align: "right" },
      { label: "Đơn giá", role: "detail", align: "right" },
      { label: "Thành tiền", role: "amount", align: "right" },
    ],
    rows: receipt.lines.map((line) => [
      `${line.productName} (${line.productCode})`,
      line.unitName,
      line.batchNumber,
      printDate(line.expiryDate),
      num(line.quantity),
      money(line.unitCost),
      money(line.lineCost),
    ]),
    totals: [
      { label: "Tiền hàng", value: money(receipt.goodsAmount) },
      ...(Number(receipt.discountAmount) > 0
        ? [{ label: "Chiết khấu", value: `-${money(receipt.discountAmount)}` }]
        : []),
      ...(Number(receipt.vatAmount) > 0
        ? [{ label: "Thuế GTGT", value: money(receipt.vatAmount) }]
        : []),
      { label: "TỔNG CỘNG", value: `${money(receipt.totalCost)} đ`, strong: true },
    ],
    amountInWords: receipt.totalCost,
    note: receipt.note,
    signatures: [
      { title: "Người lập phiếu", name: receipt.createdBy?.fullName },
      { title: "Người giao hàng" },
      { title: "Dược sĩ kiểm nhập", name: receipt.confirmedBy?.fullName },
      { title: "Người phụ trách" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Phiếu trả hàng
// ---------------------------------------------------------------------------

export type ReturnForPrint = {
  code: string;
  invoiceCode: string;
  customer: { fullName: string | null; phone: string | null } | null;
  reason: string | null;
  disposition: string;
  refundMethod: string | null;
  refundAmount: Amount;
  createdAt: Date | string;
  createdBy: { fullName: string } | null;
  lines: Array<{
    productName: string;
    unitName: string;
    quantity: number;
    refundAmount: Amount;
    batchNumber: string;
  }>;
};

export function returnDocument(item: ReturnForPrint): PrintDocument {
  const customer = item.customer?.fullName?.trim() || "Khách lẻ";
  return {
    code: item.code,
    date: item.createdAt,
    info: [
      { label: "Ngày trả", value: printDateTime(item.createdAt) },
      { label: "Hóa đơn gốc", value: item.invoiceCode },
      { label: "Khách hàng", value: customer },
      { label: "Điện thoại", value: item.customer?.phone },
      { label: "Lý do trả", value: item.reason },
      { label: "Xử lý hàng", value: item.disposition === "RESTOCK" ? "Nhập lại kho" : "Xuất hủy" },
      {
        label: "Hoàn tiền",
        value: item.refundMethod ? (PAYMENT_LABEL[item.refundMethod] ?? item.refundMethod) : null,
      },
      { label: "Nhân viên", value: item.createdBy?.fullName },
    ],
    columns: [
      { label: "Tên thuốc", role: "name" },
      { label: "Số lô", role: "detail" },
      { label: "SL trả", role: "detail", align: "right" },
      { label: "Tiền hoàn", role: "amount", align: "right" },
    ],
    rows: item.lines.map((line) => [
      line.productName,
      `Lô ${line.batchNumber}`,
      `${num(line.quantity)} ${line.unitName}`,
      money(line.refundAmount),
    ]),
    totals: [{ label: "TỔNG TIỀN HOÀN", value: `${money(item.refundAmount)} đ`, strong: true }],
    amountInWords: item.refundAmount,
    note: null,
    signatures: [
      { title: "Khách hàng", name: item.customer?.fullName },
      { title: "Nhân viên", name: item.createdBy?.fullName },
    ],
  };
}

// ---------------------------------------------------------------------------
// Phiếu điều chỉnh tồn kho
// ---------------------------------------------------------------------------

export type AdjustmentForPrint = {
  code: string;
  status: string;
  reason: string | null;
  createdAt: Date | string;
  createdBy: { fullName: string } | null;
  approvedBy: { fullName: string } | null;
  approvedAt: Date | string | null;
  rejectedReason: string | null;
  lines: Array<{
    productName: string;
    baseUnitName: string;
    batchNumber: string;
    unitName: string;
    reasonCode: string;
    countedQuantity: number | null;
    quantity: number | null;
    systemBaseQuantityAtCount: number | null;
    deltaBaseQuantity: number | null;
  }>;
};

const signed = (value: number) => (value > 0 ? `+${num(value)}` : num(value));

export function stockAdjustmentDocument(item: AdjustmentForPrint): PrintDocument {
  const stamp =
    item.status === "DRAFT"
      ? "Chờ duyệt — chưa thay đổi tồn kho"
      : item.status === "REJECTED"
        ? `Đã từ chối${item.rejectedReason ? `: ${item.rejectedReason}` : ""}`
        : item.status === "CANCELLED"
          ? "Phiếu đã hủy"
          : null;

  return {
    code: item.code,
    date: item.approvedAt ?? item.createdAt,
    stamp,
    info: [
      { label: "Ngày lập", value: printDateTime(item.createdAt) },
      { label: "Người lập", value: item.createdBy?.fullName },
      {
        label: "Người duyệt",
        value: item.approvedBy
          ? `${item.approvedBy.fullName}${item.approvedAt ? ` lúc ${printDateTime(item.approvedAt)}` : ""}`
          : null,
      },
      { label: "Lý do chung", value: item.reason },
    ],
    columns: [
      { label: "Tên thuốc", role: "name" },
      { label: "Số lô", role: "detail", nowrap: true },
      { label: "Lý do", role: "detail" },
      { label: "SL trên phiếu", role: "detail", align: "right" },
      { label: "Tồn sổ sách", role: "detail", align: "right" },
      { label: "Chênh lệch", role: "amount", align: "right" },
    ],
    rows: item.lines.map((line) => {
      const counted = line.reasonCode === "COUNT_DIFFERENCE";
      const onForm = counted ? line.countedQuantity : line.quantity;
      const delta = line.deltaBaseQuantity;
      return [
        line.productName,
        line.batchNumber,
        ADJUST_REASON[line.reasonCode] ?? line.reasonCode,
        onForm === null ? "" : `${counted ? "Thực tế " : "Xuất "}${num(onForm)} ${line.unitName}`,
        line.systemBaseQuantityAtCount === null
          ? ""
          : `${num(line.systemBaseQuantityAtCount)} ${line.baseUnitName}`,
        delta === null ? "Chờ duyệt" : `${signed(delta)} ${line.baseUnitName}`,
      ];
    }),
    totals: [{ label: "Số dòng điều chỉnh", value: num(item.lines.length) }],
    amountInWords: null,
    note: null,
    signatures: [
      { title: "Người lập phiếu", name: item.createdBy?.fullName },
      { title: "Thủ kho" },
      { title: "Người duyệt", name: item.approvedBy?.fullName },
    ],
  };
}

// ---------------------------------------------------------------------------
// Nạp dữ liệu thật
// ---------------------------------------------------------------------------

export async function loadGoodsReceiptDocument(
  storeId: string,
  id: string,
): Promise<PrintDocument> {
  return goodsReceiptDocument(await receipts.getDetail(storeId, id));
}

export async function loadReturnDocument(storeId: string, id: string): Promise<PrintDocument> {
  const detail = await returns.getDetail(storeId, id);
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: detail.invoice.id },
    select: { customer: { select: { fullName: true, phone: true } } },
  });
  return returnDocument({
    ...detail,
    invoiceCode: detail.invoice.code,
    customer: invoice.customer,
  });
}

export async function loadStockAdjustmentDocument(
  storeId: string,
  id: string,
): Promise<PrintDocument> {
  const detail = await adjustments.getDetail(storeId, id);
  const batches = await prisma.batch.findMany({
    where: { id: { in: detail.lines.map((line) => line.batchId) } },
    select: {
      id: true,
      product: {
        select: {
          name: true,
          units: { where: { conversionToBase: 1 }, select: { name: true }, take: 1 },
        },
      },
    },
  });
  const byId = new Map(batches.map((batch) => [batch.id, batch.product]));

  return stockAdjustmentDocument({
    ...detail,
    lines: detail.lines.map((line) => {
      const product = byId.get(line.batchId);
      return {
        ...line,
        productName: product?.name ?? "",
        baseUnitName: product?.units[0]?.name ?? "",
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// Dữ liệu mẫu cho xem trước ở Cài đặt (không đọc/ghi CSDL)
// ---------------------------------------------------------------------------

export function sampleDocument(type: DocumentType): PrintDocument {
  const now = new Date();
  const expiry = new Date(Date.UTC(now.getUTCFullYear() + 2, 5, 30));

  if (type === "goodsReceipt") {
    const lines = [
      {
        productCode: "TH0001",
        productName: "Paracetamol 500mg (Hapacol)",
        unitName: "Hộp",
        quantity: 20,
        unitCost: 28_000,
        batchNumber: "HP2409A",
      },
      {
        productCode: "TH0002",
        productName: "Amoxicillin + Acid Clavulanic 875mg/125mg (Augmentin) viên nén bao phim",
        unitName: "Hộp",
        quantity: 5,
        unitCost: 215_000,
        batchNumber: "AUG7781",
      },
      {
        productCode: "TH0003",
        productName: "Vitamin C 1000mg sủi",
        unitName: "Tuýp",
        quantity: 30,
        unitCost: 32_000,
        batchNumber: "VC0925",
      },
    ].map((line) => ({
      ...line,
      lineCost: line.quantity * line.unitCost,
      manufactureDate: null,
      expiryDate: expiry,
    }));
    const goodsAmount = lines.reduce((sum, line) => sum + line.lineCost, 0);
    return goodsReceiptDocument({
      code: "PN-NT01-260917-0001",
      status: "CONFIRMED",
      supplier: {
        name: "Công ty CP Dược phẩm Minh Tâm",
        address: "25 Nguyễn Trãi, Q.5, TP.HCM",
        phone: "02838123456",
        taxCode: "0301234567",
      },
      supplierInvoiceNumber: "0001234",
      supplierInvoiceDate: now,
      receivedAt: now,
      note: "Hàng giao đủ, bao bì nguyên vẹn.",
      goodsAmount,
      discountAmount: 50_000,
      vatAmount: 111_000,
      totalCost: goodsAmount - 50_000 + 111_000,
      createdBy: { fullName: "Lê Văn Kho" },
      confirmedAt: now,
      confirmedBy: { fullName: "Nguyễn Thị Dược" },
      cancelReason: null,
      lines,
    });
  }

  if (type === "return") {
    return returnDocument({
      code: "TH-NT01-260917-0001",
      invoiceCode: "HD-NT01-260917-0012",
      customer: { fullName: "Trần Văn An", phone: "0901234567" },
      reason: "Khách mua nhầm hàm lượng",
      disposition: "RESTOCK",
      refundMethod: "CASH",
      refundAmount: 75_000,
      createdAt: now,
      createdBy: { fullName: "Nguyễn Thị Dược" },
      lines: [
        {
          productName: "Vitamin C 1000mg sủi",
          unitName: "Tuýp",
          quantity: 1,
          refundAmount: 45_000,
          batchNumber: "VC0925",
        },
        {
          productName: "Paracetamol 500mg (Hapacol)",
          unitName: "Vỉ",
          quantity: 2,
          refundAmount: 30_000,
          batchNumber: "HP2409A",
        },
      ],
    });
  }

  return stockAdjustmentDocument({
    code: "DC-NT01-260917-0001",
    status: "APPROVED",
    reason: "Kiểm kê định kỳ cuối tháng",
    createdAt: now,
    createdBy: { fullName: "Lê Văn Kho" },
    approvedBy: { fullName: "Nguyễn Thị Dược" },
    approvedAt: now,
    rejectedReason: null,
    lines: [
      {
        productName: "Paracetamol 500mg (Hapacol)",
        baseUnitName: "Viên",
        batchNumber: "HP2409A",
        unitName: "Viên",
        reasonCode: "COUNT_DIFFERENCE",
        countedQuantity: 196,
        quantity: null,
        systemBaseQuantityAtCount: 200,
        deltaBaseQuantity: -4,
      },
      {
        productName: "Siro ho Prospan 100ml",
        baseUnitName: "Chai",
        batchNumber: "PR1123",
        unitName: "Chai",
        reasonCode: "DAMAGED",
        countedQuantity: null,
        quantity: 1,
        systemBaseQuantityAtCount: null,
        deltaBaseQuantity: -1,
      },
      {
        productName: "Oresol 245 hương cam",
        baseUnitName: "Gói",
        batchNumber: "OR0301",
        unitName: "Hộp",
        reasonCode: "EXPIRED_DISPOSAL",
        countedQuantity: null,
        quantity: 1,
        systemBaseQuantityAtCount: null,
        deltaBaseQuantity: -20,
      },
    ],
  });
}
