import { App } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../../api/http.js";
import type { Envelope, Paged, ProductListItem } from "../../../api/types.js";
import {
  downloadTemplate,
  sendImport,
  type ImportPreview,
  type ReceiptLine,
} from "../../excel/excel-api.js";
import { parseCsvDate, type DraftLine } from "./receipt-draft.js";

/**
 * Thêm dòng hàng vào phiếu nháp từ tệp: .xlsx gửi máy chủ đọc và kiểm tra,
 * .csv đọc ngay trên máy rồi khớp sản phẩm theo mã.
 */
export function useReceiptImport({
  productToLine,
  appendLines,
}: {
  productToLine: (productId: string, preferredUnitName?: string) => Promise<DraftLine | null>;
  appendLines: (added: DraftLine[]) => void;
}) {
  const { message, modal } = App.useApp();
  const [importing, setImporting] = useState(false);

  /**
   * Tệp .xlsx: máy chủ đọc và kiểm tra (khớp mã, đơn vị, NSX/HSD) rồi trả
   * dòng hợp lệ để đổ vào phiếu nháp; dòng lỗi liệt kê cho người dùng sửa.
   */
  async function importXlsx(file: File): Promise<void> {
    setImporting(true);
    try {
      const preview = await sendImport<ImportPreview & { lines: ReceiptLine[] }>(
        "receipt-lines",
        file,
        "preview",
      );
      if (preview.missingColumns.length > 0) {
        void message.error(
          `Tệp thiếu cột: ${preview.missingColumns.join(", ")} — tải tệp mẫu để xem đúng tên cột`,
          6,
        );
        return;
      }
      appendLines(
        preview.lines.map((line) => ({
          key: crypto.randomUUID(),
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          unitId: line.unitId,
          fallbackUnit: {
            id: line.unitId,
            name: line.unitName,
            conversionToBase: line.conversionToBase,
          },
          quantity: line.quantity,
          unitCost: line.unitCost,
          batchNumber: line.batchNumber.toUpperCase(),
          manufactureDate: line.manufactureDate ?? "",
          expiryDate: line.expiryDate,
          extraBatch: false,
        })),
      );
      if (preview.lines.length > 0)
        void message.success(`Đã thêm ${preview.lines.length} dòng từ tệp Excel`);
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
        const [
          code = "",
          unitName = "",
          quantity = "",
          unitCost = "",
          batchNumber = "",
          manufactureDate = "",
          expiryDate = "",
        ] = cells;
        const found = (
          await http.get<Envelope<Paged<ProductListItem>>>("/products", {
            params: { search: code, page: 1, limit: 20 },
          })
        ).data.data.items;
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
      if (failed.length > 0)
        void message.warning(`Không khớp mã sản phẩm ở ${failed.join(", ")}`, 6);
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

  function importFile(file: File): void {
    void (/\.csv$/i.test(file.name) ? importCsv(file) : importXlsx(file));
  }

  return { importing, importFile, template };
}
