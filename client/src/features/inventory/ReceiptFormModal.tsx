import {
  ArrowRightOutlined,
  BarcodeOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  FileExcelOutlined,
  FileTextOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  SearchOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, DatePicker, Divider, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Table, Tag, Tooltip, Typography } from "antd";
import type { RefSelectProps } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type GoodsReceiptDetail,
  type GoodsReceiptLine,
  type Paged,
  type ProductDetail,
  type ProductListItem,
  type SupplierListItem,
} from "../../api/types.js";
import { daysUntil, formatNumber, vnDateKey } from "../../ui/format.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { downloadTemplate, sendImport, type ImportPreview, type ReceiptLine } from "../excel/excel-api.js";

type DraftLine = {
  key: string;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  /** Đơn vị lấy từ dòng đã lưu, dùng tạm tới khi tải xong chi tiết sản phẩm. */
  fallbackUnit: { id: string; name: string; conversionToBase: number };
  quantity: number;
  unitCost: number;
  batchNumber: string;
  manufactureDate: string;
  expiryDate: string;
  /** Dòng tách thêm cho cùng sản phẩm nhưng khác lô. */
  extraBatch: boolean;
};

type Issue = { level: "error" | "warning"; text: string };

export type ReceiptSavedOptions = { inspect: boolean };

/**
 * Dòng hàng đổ sẵn vào phiếu nháp (từ Đề xuất đặt hàng). Số lô và hạn dùng
 * cố ý để trống: lúc gọi hàng chưa biết, người kiểm nhập điền khi hàng về.
 */
export type ReceiptPrefill = {
  supplierId: string;
  lines: Array<{ productId: string; unitName: string; quantity: number; unitCost: number }>;
};

const DATE_FORMAT = "DD/MM/YYYY";
const NEAR_EXPIRY_DAYS = 90;
/** Khớp MIN_SHELF_LIFE_DAYS ở backend: HSD cách NSX ít hơn mức này là nhập nhầm. */
const MIN_SHELF_LIFE_DAYS = 30;
/** Hầu hết thuốc có tuổi thọ 12–60 tháng; ngoài khoảng này chỉ nhắc đối chiếu lại bao bì. */
const SHORT_SHELF_LIFE_DAYS = 180;
const LONG_SHELF_LIFE_DAYS = 5 * 365 + 1;

function shelfLifeDays(line: { manufactureDate: string; expiryDate: string }): number | null {
  return line.manufactureDate && line.expiryDate ? dayjs(line.expiryDate).diff(dayjs(line.manufactureDate), "day") : null;
}

function toDateKey(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

/** Nhận ngày dạng dd/mm/yyyy hoặc yyyy-mm-dd từ file CSV. */
function parseCsvDate(value: string): string {
  const text = value.trim();
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (vn) return `${vn[3]}-${vn[2]!.padStart(2, "0")}-${vn[1]!.padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function toDraftLine(line: GoodsReceiptLine, index: number, lines: GoodsReceiptLine[]): DraftLine {
  return {
    key: line.id,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    unitId: line.unitId,
    fallbackUnit: { id: line.unitId, name: line.unitName, conversionToBase: line.conversionToBase },
    quantity: line.quantity,
    unitCost: line.unitCost,
    batchNumber: line.batchNumber,
    manufactureDate: toDateKey(line.manufactureDate),
    expiryDate: toDateKey(line.expiryDate),
    extraBatch: lines.slice(0, index).some((previous) => previous.productId === line.productId),
  };
}

/** Kiểm tra từng dòng như người nhập hàng tự soát trước khi lưu. */
function lineIssues(line: DraftLine, duplicate: boolean): Issue[] {
  const issues: Issue[] = [];
  const today = vnDateKey();
  if (duplicate) issues.push({ level: "error", text: "Trùng sản phẩm, đơn vị và số lô với dòng khác" });
  if (!line.batchNumber.trim()) issues.push({ level: "error", text: "Thiếu số lô" });
  if (line.quantity <= 0) issues.push({ level: "error", text: "Số lượng phải lớn hơn 0" });
  if (!line.expiryDate) issues.push({ level: "error", text: "Thiếu hạn dùng" });
  else if (line.expiryDate <= today) issues.push({ level: "error", text: "Hạn dùng đã qua" });
  else if (daysUntil(line.expiryDate) <= NEAR_EXPIRY_DAYS) issues.push({ level: "warning", text: `Hạn dùng chỉ còn ${daysUntil(line.expiryDate)} ngày` });
  if (line.manufactureDate && line.manufactureDate > today) issues.push({ level: "error", text: "Ngày sản xuất ở tương lai" });
  const shelfLife = shelfLifeDays(line);
  if (shelfLife !== null && shelfLife < MIN_SHELF_LIFE_DAYS) {
    issues.push({ level: "error", text: shelfLife <= 0 ? "Ngày sản xuất phải trước hạn dùng" : `Hạn dùng chỉ cách ngày sản xuất ${shelfLife} ngày — gần như chắc chắn nhập nhầm` });
  } else if (shelfLife !== null && shelfLife < SHORT_SHELF_LIFE_DAYS) {
    issues.push({ level: "warning", text: `Tuổi thọ chỉ khoảng ${Math.round(shelfLife / 30)} tháng — đối chiếu lại NSX/HSD trên bao bì` });
  } else if (shelfLife !== null && shelfLife > LONG_SHELF_LIFE_DAYS) {
    issues.push({ level: "warning", text: `Tuổi thọ hơn 5 năm (${(shelfLife / 365).toFixed(1)} năm) — đối chiếu lại NSX/HSD` });
  }
  if (line.unitCost === 0) issues.push({ level: "warning", text: "Đơn giá bằng 0 (hàng tặng?)" });
  return issues;
}

export function ReceiptFormModal({
  open,
  receipt,
  prefill = null,
  onClose,
  onSaved,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail | null;
  prefill?: ReceiptPrefill | null;
  onClose: () => void;
  onSaved: (id: string, options: ReceiptSavedOptions) => Promise<unknown> | unknown;
}) {
  const { message, modal } = App.useApp();
  const { can, me, storeId } = useAuth();
  const searchRef = useRef<RefSelectProps>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [supplierId, setSupplierId] = useState<string>();
  const [receivedAt, setReceivedAt] = useState(vnDateKey());
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState("");
  const [note, setNote] = useState("");
  const [discountAmount, setDiscountAmount] = useState(0);
  const [vatAmount, setVatAmount] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loadingPrefill, setLoadingPrefill] = useState(false);
  const createAttempt = useRef({ signature: "", key: "" });
  const productTerm = useDebounced(productSearch.trim(), 250);
  const store = me?.stores.find((item) => item.id === storeId);

  const suppliers = useQuery({
    queryKey: ["receipt-suppliers"],
    enabled: open,
    queryFn: async () => (await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", { params: { page: 1, limit: 100 } })).data.data.items,
  });
  const products = useQuery({
    queryKey: ["receipt-products", productTerm],
    enabled: open && productTerm.length > 0,
    queryFn: async () => (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: productTerm, page: 1, limit: 15 } })).data.data.items,
  });

  // Chi tiết từng sản phẩm trong phiếu: đủ đơn vị quy đổi, số đăng ký, hãng, điều kiện bảo quản.
  const productIds = useMemo(() => [...new Set(lines.map((line) => line.productId))], [lines]);
  const productDetails = useQueries({
    queries: productIds.map((id) => ({
      queryKey: ["product", id],
      enabled: open,
      queryFn: async () => (await http.get<Envelope<ProductDetail>>(`/products/${id}`)).data.data,
      staleTime: 5 * 60_000,
    })),
  });
  const productById = new Map(productDetails.flatMap((query) => (query.data ? [[query.data.id, query.data] as const] : [])));

  useEffect(() => {
    if (!open) return;
    setSupplierId(receipt?.supplier?.id);
    setReceivedAt(toDateKey(receipt?.receivedAt) || vnDateKey());
    setSupplierInvoiceNumber(receipt?.supplierInvoiceNumber ?? "");
    setSupplierInvoiceDate(toDateKey(receipt?.supplierInvoiceDate));
    setNote(receipt?.note ?? "");
    setDiscountAmount(receipt?.discountAmount ?? 0);
    setVatAmount(receipt?.vatAmount ?? 0);
    setLines((receipt?.lines ?? []).map(toDraftLine));
    setProductSearch("");
  }, [open, receipt]);

  // Mở từ Đề xuất đặt hàng: đổ sẵn nhà cung cấp và dòng hàng đã chọn.
  useEffect(() => {
    if (!open || receipt || !prefill || prefill.lines.length === 0) return;
    let cancelled = false;
    setLoadingPrefill(true);
    setSupplierId(prefill.supplierId);
    void Promise.all(prefill.lines.map(async (item) => ({ item, line: await productToLine(item.productId, item.unitName) })))
      .then((loaded) => {
        if (cancelled) return;
        const ready = loaded
          .filter((entry): entry is { item: ReceiptPrefill["lines"][number]; line: DraftLine } => entry.line !== null)
          .map(({ item, line }) => ({ ...line, quantity: item.quantity, unitCost: item.unitCost }));
        setLines(ready.map((line, index, all) => ({ ...line, extraBatch: all.slice(0, index).some((previous) => previous.productId === line.productId) })));
        if (ready.length < prefill.lines.length) {
          void message.warning("Có mặt hàng chưa có đơn vị tính nên không đưa vào phiếu được");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) void message.error(getErrorMessage(error, "Không đổ được dòng hàng từ đề xuất"));
      })
      .finally(() => {
        if (!cancelled) setLoadingPrefill(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ đổ một lần khi mở phiếu
  }, [open, receipt, prefill]);

  const supplier = suppliers.data?.find((item) => item.id === supplierId) ?? null;
  const goodsAmount = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
  const totalAmount = goodsAmount - discountAmount + vatAmount;
  const productCount = productIds.length;

  const duplicateKeys = useMemo(() => {
    const keyOf = (line: DraftLine) => `${line.productId}|${line.unitId}|${line.batchNumber.trim().toUpperCase()}`;
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(keyOf(line), (counts.get(keyOf(line)) ?? 0) + 1);
    return new Set(lines.filter((line) => line.batchNumber.trim() && (counts.get(keyOf(line)) ?? 0) > 1).map((line) => line.key));
  }, [lines]);
  const issuesByLine = new Map(lines.map((line) => [line.key, lineIssues(line, duplicateKeys.has(line.key))]));
  const errorLines = lines.filter((line) => issuesByLine.get(line.key)?.some((issue) => issue.level === "error")).length;
  const warningLines = lines.filter((line) => issuesByLine.get(line.key)?.some((issue) => issue.level === "warning")).length;
  const completeLines = lines.filter((line) => line.batchNumber.trim() && line.expiryDate).length;

  const today = vnDateKey();
  const invoiceGapDays = supplierInvoiceDate ? Math.abs(dayjs(supplierInvoiceDate).diff(dayjs(receivedAt), "day")) : 0;
  const discountTooHigh = discountAmount > goodsAmount;

  const checks: Array<{ label: string; state: "ok" | "error" | "warning" }> = [
    { label: supplier ? "Đã chọn nhà cung cấp" : "Chưa chọn nhà cung cấp", state: supplier ? "ok" : "error" },
    { label: lines.length === 0 ? "Chưa có dòng hàng" : `${completeLines}/${lines.length} dòng đủ số lô và hạn dùng`, state: lines.length > 0 && completeLines === lines.length ? "ok" : "error" },
    ...(errorLines > 0 ? [{ label: `${errorLines} dòng còn lỗi — di chuột vào biểu tượng đỏ để xem`, state: "error" as const }] : []),
    ...(warningLines > 0 ? [{ label: `${warningLines} dòng cần lưu ý (cận hạn, tuổi thọ bất thường, đơn giá 0)`, state: "warning" as const }] : []),
    ...(discountTooHigh ? [{ label: "Chiết khấu lớn hơn tổng tiền hàng", state: "error" as const }] : []),
    ...(receivedAt > today || supplierInvoiceDate > today ? [{ label: "Ngày nhận hàng / ngày hóa đơn ở tương lai", state: "error" as const }] : []),
    ...(invoiceGapDays > 30 ? [{ label: `Ngày hóa đơn và ngày nhận lệch ${invoiceGapDays} ngày — kiểm tra lại`, state: "warning" as const }] : []),
    ...(supplier && !supplier.licenseNumber ? [{ label: "Nhà cung cấp chưa lưu số giấy phép kinh doanh dược", state: "warning" as const }] : []),
  ];
  const blocked = checks.some((check) => check.state === "error");

  async function productToLine(productId: string, preferredUnitName?: string): Promise<DraftLine | null> {
    const product = (await http.get<Envelope<ProductDetail>>(`/products/${productId}`)).data.data;
    const activeUnits = product.units.filter((unit) => unit.isActive !== false);
    // Nhà thuốc nhập theo quy cách đóng gói (hộp, chai…) nên chọn sẵn đơn vị lớn nhất còn dùng.
    const unit =
      (preferredUnitName ? activeUnits.find((item) => item.name.toLowerCase() === preferredUnitName.trim().toLowerCase()) : undefined) ??
      [...activeUnits].sort((a, b) => b.conversionToBase - a.conversionToBase)[0] ??
      product.units[0];
    if (!unit) return null;
    return {
      key: crypto.randomUUID(),
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      unitId: unit.id,
      fallbackUnit: { id: unit.id, name: unit.name, conversionToBase: unit.conversionToBase },
      quantity: 1,
      unitCost: 0,
      batchNumber: "",
      manufactureDate: "",
      expiryDate: "",
      extraBatch: false,
    };
  }

  async function addProduct(productId: string): Promise<void> {
    const line = await productToLine(productId);
    if (!line) {
      void message.error("Sản phẩm chưa có đơn vị tính");
      return;
    }
    setLines((current) => [...current, { ...line, extraBatch: current.some((item) => item.productId === productId) }]);
    setProductSearch("");
  }

  async function addFromSearchEnter(): Promise<void> {
    const value = productSearch.trim();
    if (!value) return;
    const found = (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: value, page: 1, limit: 2 } })).data.data.items;
    if (found.length === 1) await addProduct(found[0]!.id);
    else if (found.length === 0) void message.warning(`Không tìm thấy sản phẩm “${value}”`);
  }

  function appendLines(added: DraftLine[]): void {
    setLines((current) =>
      [...current, ...added].map((line, index, all) => ({ ...line, extraBatch: all.slice(0, index).some((previous) => previous.productId === line.productId) })),
    );
  }

  /**
   * Tệp .xlsx: máy chủ đọc và kiểm tra (khớp mã, đơn vị, NSX/HSD) rồi trả
   * dòng hợp lệ để đổ vào phiếu nháp; dòng lỗi liệt kê cho người dùng sửa.
   */
  async function importXlsx(file: File): Promise<void> {
    setImporting(true);
    try {
      const preview = await sendImport<ImportPreview & { lines: ReceiptLine[] }>("receipt-lines", file, "preview");
      if (preview.missingColumns.length > 0) {
        void message.error(`Tệp thiếu cột: ${preview.missingColumns.join(", ")} — tải tệp mẫu để xem đúng tên cột`, 6);
        return;
      }
      appendLines(
        preview.lines.map((line) => ({
          key: crypto.randomUUID(),
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          unitId: line.unitId,
          fallbackUnit: { id: line.unitId, name: line.unitName, conversionToBase: line.conversionToBase },
          quantity: line.quantity,
          unitCost: line.unitCost,
          batchNumber: line.batchNumber.toUpperCase(),
          manufactureDate: line.manufactureDate ?? "",
          expiryDate: line.expiryDate,
          extraBatch: false,
        })),
      );
      if (preview.lines.length > 0) void message.success(`Đã thêm ${preview.lines.length} dòng từ tệp Excel`);
      if (preview.issueCount > 0) {
        modal.warning({
          title: `${preview.issueCount} lỗi trong tệp — các dòng này chưa được thêm`,
          width: 620,
          content: (
            <ul className="receipt-import-issues">
              {preview.issues.slice(0, 15).map((issue) => (
                <li key={`${issue.row}-${issue.column ?? ""}-${issue.message}`}>
                  <b>Dòng {issue.row}</b>
                  {issue.column ? ` · ${issue.column}` : ""}: {issue.message}
                </li>
              ))}
              {preview.issueCount > 15 ? <li>… và {preview.issueCount - 15} lỗi khác</li> : null}
            </ul>
          ),
        });
      } else if (preview.totalRows === 0) {
        void message.warning("Tệp không có dòng dữ liệu nào");
      }
    } catch (error) {
      void message.error(getErrorMessage(error, "Không đọc được tệp Excel"));
    } finally {
      setImporting(false);
    }
  }

  /** Nhập nhiều dòng từ file CSV (Excel lưu dạng CSV UTF-8), khớp sản phẩm theo mã. */
  async function importCsv(file: File): Promise<void> {
    setImporting(true);
    try {
      const rows = (await file.text())
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .map((row) => row.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"|"$/g, "")))
        .filter((cells) => cells.some(Boolean));
      const dataRows = rows[0]?.[0]?.toLowerCase().includes("ma") ? rows.slice(1) : rows;
      const added: DraftLine[] = [];
      const failed: string[] = [];
      for (const [index, cells] of dataRows.entries()) {
        const [code = "", unitName = "", quantity = "", unitCost = "", batchNumber = "", manufactureDate = "", expiryDate = ""] = cells;
        const found = (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: code, page: 1, limit: 20 } })).data.data.items;
        const product = found.find((item) => item.code.toLowerCase() === code.toLowerCase());
        const line = product ? await productToLine(product.id, unitName) : null;
        if (!line) {
          failed.push(`dòng ${index + 1} (${code || "trống"})`);
          continue;
        }
        added.push({
          ...line,
          quantity: Math.max(0, Number(quantity.replace(/\D/g, "")) || 0),
          unitCost: Number(unitCost.replace(/\D/g, "")) || 0,
          batchNumber: batchNumber.toUpperCase(),
          manufactureDate: parseCsvDate(manufactureDate),
          expiryDate: parseCsvDate(expiryDate),
        });
      }
      appendLines(added);
      if (added.length > 0) void message.success(`Đã thêm ${added.length} dòng từ file`);
      if (failed.length > 0) void message.warning(`Không khớp mã sản phẩm ở ${failed.join(", ")}`, 6);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không đọc được file"));
    } finally {
      setImporting(false);
    }
  }

  async function template(): Promise<void> {
    try {
      await downloadTemplate("receipt-lines");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không tải được tệp mẫu");
    }
  }

  function changeLine(key: string, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  /** Cùng một sản phẩm về nhiều lô khác nhau: thêm dòng giữ nguyên sản phẩm, đơn vị, giá. */
  function addBatch(line: DraftLine): void {
    setLines((current) => {
      const lastIndex = current.map((item) => item.productId).lastIndexOf(line.productId);
      const copy: DraftLine = { ...line, key: crypto.randomUUID(), quantity: 1, batchNumber: "", manufactureDate: "", expiryDate: "", extraBatch: true };
      return [...current.slice(0, lastIndex + 1), copy, ...current.slice(lastIndex + 1)];
    });
  }

  function removeLine(key: string): void {
    setLines((current) =>
      current
        .filter((item) => item.key !== key)
        .map((line, index, all) => ({ ...line, extraBatch: all.slice(0, index).some((previous) => previous.productId === line.productId) })),
    );
  }

  const save = useMutation({
    mutationFn: async (options: ReceiptSavedOptions) => {
      const body = {
        supplierId,
        receivedAt,
        supplierInvoiceNumber: supplierInvoiceNumber.trim() || null,
        supplierInvoiceDate: supplierInvoiceDate || null,
        note: note.trim() || null,
        discountAmount,
        vatAmount,
        lines: lines.map((line) => ({
          productId: line.productId,
          unitId: line.unitId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          batchNumber: line.batchNumber.trim(),
          manufactureDate: line.manufactureDate || null,
          expiryDate: line.expiryDate,
        })),
      };
      if (receipt) {
        const response = await http.patch<Envelope<GoodsReceiptDetail>>(`/goods-receipts/${receipt.id}`, { ...body, version: receipt.version });
        return { id: response.data.data.id, options };
      }
      const signature = JSON.stringify(body);
      if (createAttempt.current.signature !== signature) createAttempt.current = { signature, key: crypto.randomUUID() };
      const response = await http.post<Envelope<GoodsReceiptDetail>>("/goods-receipts", body, { headers: { "Idempotency-Key": createAttempt.current.key } });
      return { id: response.data.data.id, options };
    },
    onSuccess: async ({ id, options }) => {
      void message.success(options.inspect ? "Đã lưu nháp — tiếp tục kiểm nhận hàng" : receipt ? "Đã lưu phiếu nháp" : "Đã tạo phiếu nháp");
      await onSaved(id, options);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được phiếu nhập")),
  });

  const summaryText = `${productCount} mặt hàng • ${lines.length} dòng lô`;

  return (
    <Modal
      open={open}
      width="min(1280px, 96vw)"
      style={{ top: 20 }}
      onCancel={onClose}
      destroyOnHidden
      className="receipt-form-modal"
      title={
        <div className="receipt-form-title">
          <div>
            <span>{receipt ? `Sửa phiếu nhập ${receipt.code}` : "Tạo phiếu nhập hàng"}</span>
            <Tag color="blue">Bản nháp</Tag>
          </div>
          <small>Nhập chứng từ và hàng hóa từ nhà cung cấp</small>
        </div>
      }
      footer={
        <div className="receipt-form-footer">
          <span className="text-secondary">
            {summaryText} &nbsp;·&nbsp; <span className="required-mark">*</span> Thông tin bắt buộc
          </span>
          <Button onClick={onClose}>Đóng</Button>
          <Button disabled={blocked} loading={save.isPending && !save.variables?.inspect} onClick={() => save.mutate({ inspect: false })}>
            Lưu nháp
          </Button>
          {can("goods_receipt.confirm") ? (
            <Button type="primary" disabled={blocked} loading={save.isPending && save.variables?.inspect} onClick={() => save.mutate({ inspect: true })}>
              Lưu nháp &amp; kiểm nhận <ArrowRightOutlined />
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="receipt-form">
        <Alert type="info" showIcon title="Lưu nháp chưa cộng tồn kho. Kiểm nhận từng dòng trước khi xác nhận nhập kho." />

        <section className="form-section">
          <h4>
            <FileTextOutlined /> Thông tin chứng từ
          </h4>
          <div className="receipt-form-grid">
            <div className="field">
              <span>
                Nhà cung cấp <span className="required-mark">*</span>
              </span>
              <div className="supplier-picker">
                <Select
                  showSearch
                  prefix={<SearchOutlined />}
                  optionFilterProp="label"
                  placeholder="Tìm nhà cung cấp"
                  loading={suppliers.isLoading}
                  value={supplierId}
                  onChange={setSupplierId}
                  notFoundContent={suppliers.isLoading ? "Đang tải…" : "Không có nhà cung cấp phù hợp"}
                  options={(suppliers.data ?? []).filter((item) => item.isActive || item.id === supplierId).map((item) => ({ value: item.id, label: item.name }))}
                  popupRender={(menu) =>
                    can("catalog.manage") ? (
                      <>
                        {menu}
                        <Divider style={{ margin: "4px 0" }} />
                        <Button type="text" block icon={<PlusOutlined />} className="select-footer-btn" onClick={() => setAddingSupplier(true)}>
                          Thêm nhà cung cấp mới
                        </Button>
                      </>
                    ) : (
                      menu
                    )
                  }
                />
                {can("catalog.manage") ? (
                  <Tooltip title="Thêm nhà cung cấp mới">
                    <Button icon={<PlusOutlined />} onClick={() => setAddingSupplier(true)} aria-label="Thêm nhà cung cấp mới" />
                  </Tooltip>
                ) : null}
              </div>
              {supplier ? (
                <span className="field-hint">
                  MST {supplier.taxCode ?? "—"} · GPKD {supplier.licenseNumber ?? "—"} · ĐT {supplier.phone ?? "—"}
                </span>
              ) : null}
            </div>
            <label className="field">
              <span>Số hóa đơn</span>
              <Input placeholder="Theo hóa đơn NCC" value={supplierInvoiceNumber} onChange={(event) => setSupplierInvoiceNumber(event.target.value)} maxLength={50} />
            </label>
            <label className="field">
              <span>Ngày hóa đơn</span>
              <DatePicker
                format={DATE_FORMAT}
                placeholder="dd/mm/yyyy"
                value={supplierInvoiceDate ? dayjs(supplierInvoiceDate) : null}
                disabledDate={(date) => date.isAfter(dayjs(), "day")}
                onChange={(value) => setSupplierInvoiceDate(value ? value.format("YYYY-MM-DD") : "")}
              />
            </label>
            <label className="field">
              <span>
                Ngày nhận hàng <span className="required-mark">*</span>
              </span>
              <DatePicker
                format={DATE_FORMAT}
                allowClear={false}
                value={receivedAt ? dayjs(receivedAt) : null}
                disabledDate={(date) => date.isAfter(dayjs(), "day")}
                onChange={(value) => value && setReceivedAt(value.format("YYYY-MM-DD"))}
              />
            </label>
            <label className="field">
              <span>
                Kho nhận <span className="required-mark">*</span>
              </span>
              <Tooltip title="Hàng nhập vào kho của cửa hàng đang chọn ở thanh trên cùng">
                <Select disabled value={storeId ?? undefined} options={store ? [{ value: store.id, label: `${store.name}` }] : []} />
              </Tooltip>
            </label>
            <label className="field receipt-note-field">
              <span>Ghi chú</span>
              <Input placeholder="Nhập ghi chú cho phiếu…" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
            </label>
          </div>
          <p className="field-hint">Ngày hóa đơn theo chứng từ; ngày nhận hàng theo thực tế hàng về.</p>
        </section>

        <section className="form-section">
          <div className="form-section-head">
            <h4>
              <InboxOutlined /> Hàng hóa nhập
            </h4>
            <span className="text-secondary">{summaryText}</span>
          </div>
          <div className="receipt-search-row">
            <AutoComplete
              ref={searchRef}
              className="receipt-product-search"
              value={productSearch}
              onChange={setProductSearch}
              onSelect={(id) => void addProduct(String(id))}
              options={(products.data ?? []).map((product) => ({
                value: product.id,
                label: (
                  <div className="product-option">
                    <strong>{product.name}</strong>
                    <span>{[product.code, product.dosageForm, product.strengthText, product.stock ? `tồn ${formatNumber(product.stock.sellable)}` : null].filter(Boolean).join(" · ")}</span>
                  </div>
                ),
              }))}
              notFoundContent={productTerm && !products.isFetching ? "Không tìm thấy — thêm sản phẩm mới ở trang Thuốc & sản phẩm" : null}
            >
              <Input
                prefix={<SearchOutlined />}
                suffix={<BarcodeOutlined />}
                placeholder="Quét mã vạch, tìm tên thuốc, mã hoặc hoạt chất…"
                onPressEnter={(event) => {
                  if ((products.data?.length ?? 0) <= 1) {
                    event.preventDefault();
                    void addFromSearchEnter();
                  }
                }}
              />
            </AutoComplete>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void (/\.csv$/i.test(file.name) ? importCsv(file) : importXlsx(file));
                event.target.value = "";
              }}
            />
            <Dropdown
              menu={{
                items: [
                  { key: "pick", label: "Chọn tệp Excel (.xlsx hoặc .csv)" },
                  { key: "template", label: "Tải tệp mẫu Excel" },
                ],
                onClick: ({ key }) => (key === "pick" ? fileRef.current?.click() : void template()),
              }}
            >
              <Button icon={<FileExcelOutlined />} loading={importing}>
                Nhập Excel <DownOutlined />
              </Button>
            </Dropdown>
          </div>

          <Table
            rowKey="key"
            size="small"
            className="receipt-lines"
            loading={loadingPrefill}
            pagination={false}
            dataSource={lines}
            scroll={{ x: 1100 }}
            rowClassName={(line) => (issuesByLine.get(line.key)?.some((issue) => issue.level === "error") ? "line-has-error" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có hàng — quét mã vạch hoặc tìm sản phẩm ở ô phía trên" /> }}
            columns={[
              { title: "#", key: "index", width: 40, render: (_: unknown, __: DraftLine, index: number) => index + 1 },
              {
                title: "Sản phẩm",
                key: "product",
                width: 250,
                render: (_: unknown, line: DraftLine) => {
                  const product = productById.get(line.productId);
                  const issues = issuesByLine.get(line.key) ?? [];
                  const hasError = issues.some((issue) => issue.level === "error");
                  const units = product?.units ?? [line.fallbackUnit];
                  const current = units.find((unit) => unit.id === line.unitId) ?? line.fallbackUnit;
                  const base = units.find((unit) => unit.conversionToBase === 1);
                  const info = [
                    product?.registrationNumber ? `SĐK: ${product.registrationNumber}` : product?.productType === "DRUG" ? "Chưa có số đăng ký" : null,
                    [product?.manufacturer, product?.countryOfOrigin].filter(Boolean).join(" · ") || null,
                    product?.storageCondition ? `Bảo quản: ${product.storageCondition}` : null,
                  ].filter(Boolean);
                  return (
                    <div className="line-product">
                      <div className="line-product-name">
                        <Tooltip title={info.length ? info.map((text) => <div key={text}>{text}</div>) : line.productCode}>
                          <strong>{line.productName}</strong>
                        </Tooltip>
                        {line.extraBatch ? <Tag className="extra-batch-tag">Lô bổ sung</Tag> : null}
                        {issues.length > 0 ? (
                          <Tooltip title={issues.map((issue) => <div key={issue.text}>{issue.text}</div>)}>
                            {hasError ? <ExclamationCircleFilled className="text-danger" /> : <WarningFilled className="text-warning" />}
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="line-product-meta">
                        <span>{current.conversionToBase > 1 ? `1 ${current.name.toLowerCase()} = ${formatNumber(current.conversionToBase)} ${(base?.name ?? "đơn vị lẻ").toLowerCase()}` : line.productCode}</span>
                        <Button type="link" size="small" onClick={() => addBatch(line)}>
                          + Thêm lô
                        </Button>
                      </div>
                    </div>
                  );
                },
              },
              {
                title: "Đơn vị",
                key: "unit",
                width: 96,
                render: (_: unknown, line: DraftLine) => {
                  const units = productById.get(line.productId)?.units.filter((unit) => unit.isActive !== false || unit.id === line.unitId) ?? [line.fallbackUnit];
                  return <Select style={{ width: "100%" }} value={line.unitId} onChange={(unitId) => changeLine(line.key, { unitId })} options={units.map((unit) => ({ value: unit.id, label: unit.name }))} popupMatchSelectWidth={false} />;
                },
              },
              {
                title: (
                  <span>
                    SL nhập <span className="required-mark">*</span>
                  </span>
                ),
                key: "qty",
                width: 96,
                render: (_: unknown, line: DraftLine) => (
                  <InputNumber<number> style={{ width: "100%" }} min={1} precision={0} value={line.quantity} status={line.quantity > 0 ? undefined : "error"} onChange={(value) => changeLine(line.key, { quantity: value ?? 0 })} />
                ),
              },
              {
                title: "Đơn giá nhập",
                key: "cost",
                width: 120,
                render: (_: unknown, line: DraftLine) => (
                  <InputNumber<number>
                    style={{ width: "100%" }}
                    min={0}
                    precision={0}
                    value={line.unitCost}
                    formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
                    parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                    onChange={(value) => changeLine(line.key, { unitCost: value ?? 0 })}
                  />
                ),
              },
              {
                title: (
                  <span>
                    Số lô <span className="required-mark">*</span>
                  </span>
                ),
                key: "batch",
                width: 126,
                render: (_: unknown, line: DraftLine) => (
                  <Input
                    value={line.batchNumber}
                    placeholder="Theo bao bì"
                    status={line.batchNumber.trim() && !duplicateKeys.has(line.key) ? undefined : "error"}
                    onChange={(event) => changeLine(line.key, { batchNumber: event.target.value.toUpperCase() })}
                    maxLength={50}
                  />
                ),
              },
              {
                title: "Ngày SX",
                key: "mfg",
                width: 136,
                render: (_: unknown, line: DraftLine) => (
                  <DatePicker
                    format={DATE_FORMAT}
                    placeholder="dd/mm/yyyy"
                    status={line.manufactureDate && (line.manufactureDate > today || (shelfLifeDays(line) ?? MIN_SHELF_LIFE_DAYS) < MIN_SHELF_LIFE_DAYS) ? "error" : undefined}
                    value={line.manufactureDate ? dayjs(line.manufactureDate) : null}
                    disabledDate={(date) => date.isAfter(dayjs(), "day") || (Boolean(line.expiryDate) && date.isAfter(dayjs(line.expiryDate).subtract(MIN_SHELF_LIFE_DAYS, "day"), "day"))}
                    onChange={(value) => changeLine(line.key, { manufactureDate: value ? value.format("YYYY-MM-DD") : "" })}
                  />
                ),
              },
              {
                title: (
                  <span>
                    Hạn dùng <span className="required-mark">*</span>
                  </span>
                ),
                key: "exp",
                width: 136,
                render: (_: unknown, line: DraftLine) => {
                  const invalid = !line.expiryDate || line.expiryDate <= today || (shelfLifeDays(line) ?? MIN_SHELF_LIFE_DAYS) < MIN_SHELF_LIFE_DAYS;
                  const near = !invalid && daysUntil(line.expiryDate) <= NEAR_EXPIRY_DAYS;
                  return (
                    <DatePicker
                      format={DATE_FORMAT}
                      placeholder="dd/mm/yyyy"
                      status={invalid ? "error" : near ? "warning" : undefined}
                      value={line.expiryDate ? dayjs(line.expiryDate) : null}
                      disabledDate={(date) => !date.isAfter(dayjs(), "day") || (Boolean(line.manufactureDate) && date.isBefore(dayjs(line.manufactureDate).add(MIN_SHELF_LIFE_DAYS, "day"), "day"))}
                      onChange={(value) => changeLine(line.key, { expiryDate: value ? value.format("YYYY-MM-DD") : "" })}
                    />
                  );
                },
              },
              { title: "Thành tiền", key: "total", width: 110, align: "right", render: (_: unknown, line: DraftLine) => <strong>{formatNumber(line.quantity * line.unitCost)}</strong> },
              {
                title: "",
                key: "remove",
                width: 44,
                align: "center",
                render: (_: unknown, line: DraftLine) => (
                  <Tooltip title="Xóa dòng">
                    <Button type="text" danger icon={<DeleteOutlined />} aria-label="Xóa dòng" onClick={() => removeLine(line.key)} />
                  </Tooltip>
                ),
              },
            ]}
          />
          <div className="receipt-add-row">
            <Button icon={<PlusOutlined />} onClick={() => searchRef.current?.focus()}>
              Thêm sản phẩm
            </Button>
            <span className="field-hint">Mỗi số lô / hạn dùng là một dòng riêng.</span>
          </div>
        </section>

        <div className="receipt-bottom">
          <div className="receipt-checks">
            <h4>
              {blocked ? <ExclamationCircleFilled className="text-danger" /> : <CheckCircleFilled className="text-success" />} Kiểm tra trước khi lưu
            </h4>
            <ul className="check-list">
              {checks.map((check) => (
                <li key={check.label} className={check.state === "ok" ? "done" : check.state === "warning" ? "warn" : "fail"}>
                  {check.state === "ok" ? <CheckCircleFilled /> : check.state === "warning" ? <WarningFilled /> : <ExclamationCircleFilled />}
                  <span>{check.label}</span>
                </li>
              ))}
              <li className="info">
                <InfoCircleOutlined />
                <span>Kiểm nhận thực tế (bao bì, cảm quan) thực hiện sau khi lưu nháp.</span>
              </li>
            </ul>
          </div>
          <div className="receipt-totals">
            <div>
              <strong>Tổng tiền hàng</strong>
              <strong>{formatVnd(goodsAmount)}</strong>
            </div>
            <div>
              <span>Chiết khấu phiếu</span>
              <InputNumber<number>
                min={0}
                precision={0}
                value={discountAmount}
                status={discountTooHigh ? "error" : undefined}
                suffix="₫"
                formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
                parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                onChange={(value) => setDiscountAmount(value ?? 0)}
              />
            </div>
            <div>
              <span>Thuế theo hóa đơn</span>
              <InputNumber<number>
                min={0}
                precision={0}
                value={vatAmount}
                suffix="₫"
                formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
                parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                onChange={(value) => setVatAmount(value ?? 0)}
              />
            </div>
            <div className="receipt-grand-total">
              <strong>Tổng giá trị phiếu</strong>
              <strong>{formatVnd(totalAmount)}</strong>
            </div>
            <Typography.Text type="secondary" className="field-hint">
              Chiết khấu và thuế được phân bổ vào giá vốn từng lô theo tỷ lệ thành tiền.
            </Typography.Text>
          </div>
        </div>
      </div>

      <QuickSupplierModal
        open={addingSupplier}
        onClose={() => setAddingSupplier(false)}
        onCreated={(created) => {
          setAddingSupplier(false);
          setSupplierId(created.id);
        }}
      />
    </Modal>
  );
}

type SupplierForm = { name: string; phone?: string; taxCode?: string; licenseNumber?: string; address?: string };

/** Thêm nhanh nhà cung cấp ngay trong phiếu nhập, không phải rời màn hình. */
function QuickSupplierModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (supplier: SupplierListItem) => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SupplierForm>();

  const create = useMutation({
    mutationFn: async (values: SupplierForm) =>
      (
        await http.post<Envelope<SupplierListItem>>("/suppliers", {
          name: values.name.trim(),
          phone: values.phone?.trim() || null,
          taxCode: values.taxCode?.trim() || null,
          licenseNumber: values.licenseNumber?.trim() || null,
          address: values.address?.trim() || null,
        })
      ).data.data,
    onSuccess: async (created) => {
      void message.success(`Đã thêm nhà cung cấp ${created.name}`);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["receipt-suppliers"] }), queryClient.invalidateQueries({ queryKey: ["suppliers-page"] })]);
      form.resetFields();
      onCreated(created);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thêm được nhà cung cấp")),
  });

  return (
    <Modal
      open={open}
      title="Thêm nhà cung cấp"
      okText="Thêm và chọn"
      cancelText="Hủy"
      width={560}
      confirmLoading={create.isPending}
      onOk={() => void form.validateFields().then((values) => create.mutate(values))}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">Nhà thuốc chỉ được mua hàng từ cơ sở kinh doanh dược hợp pháp — nên ghi đủ mã số thuế và số giấy phép.</Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="Tên nhà cung cấp" rules={[{ required: true, whitespace: true, message: "Nhập tên nhà cung cấp" }]}>
          <Input placeholder="Ví dụ: Công ty CP Dược phẩm Traphaco" autoFocus />
        </Form.Item>
        <div className="form-grid">
          <Form.Item name="taxCode" label="Mã số thuế">
            <Input placeholder="10 hoặc 13 số" maxLength={20} />
          </Form.Item>
          <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh dược">
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="phone" label="Số điện thoại">
            <Input inputMode="tel" maxLength={20} />
          </Form.Item>
        </div>
        <Form.Item name="address" label="Địa chỉ">
          <Input placeholder="Số nhà, đường, phường/xã, tỉnh/thành phố" maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
