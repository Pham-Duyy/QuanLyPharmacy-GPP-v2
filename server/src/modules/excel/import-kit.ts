import type { AuthContext } from "../auth/auth.context.js";
import { CellError, type ColumnDef, type RawRow } from "./workbook.js";

export type ImportIssue = { row: number; column?: string; message: string };
export type ImportAction = "create" | "update";

export type PlannedRow<T> = { row: number; action: ImportAction; label: string; data: T };

export type ImportPlan<T> = {
  rows: PlannedRow<T>[];
  issues: ImportIssue[];
  /** Việc hệ thống sẽ tự làm thêm (tạo nhóm hàng mới, tạo hoạt chất mới…) để người dùng biết trước. */
  notes: string[];
};

export type ImportContext = {
  auth: AuthContext;
  storeId: string | null;
  requestId: string | null;
};

export type ImportResult = { created: number; updated: number; documentId?: string };

export type ImportDefinition<T> = {
  type: string;
  title: string;
  /** Có ít nhất một quyền là được dùng. */
  permission: string[];
  needsStore: boolean;
  /** Chỉ đọc và kiểm tra (vd. dòng phiếu nhập đổ vào form), không có bước ghi. */
  previewOnly?: boolean;
  columns: ColumnDef[];
  guide: string[];
  example: Array<Record<string, unknown>>;
  plan(rows: RawRow[], ctx: ImportContext): Promise<ImportPlan<T>>;
  commit?(plan: ImportPlan<T>, ctx: ImportContext): Promise<ImportResult>;
};

/**
 * Gom lỗi theo từng ô khi đọc một dòng: đọc hết các cột rồi mới báo, để
 * người dùng sửa một lượt thay vì sửa-nhập-sửa từng lỗi.
 */
export class RowReader {
  readonly issues: ImportIssue[] = [];

  constructor(
    readonly row: number,
    private readonly headers: Map<string, string>,
  ) {}

  read<V>(key: string, parse: () => V): V | null {
    try {
      return parse();
    } catch (error) {
      if (error instanceof CellError) {
        this.issues.push({ row: this.row, column: this.headers.get(key), message: error.message });
        return null;
      }
      throw error;
    }
  }

  fail(key: string | undefined, message: string): void {
    this.issues.push({ row: this.row, column: key ? this.headers.get(key) : undefined, message });
  }

  require<V>(key: string, value: V | null | undefined): value is V {
    if (value === null || value === undefined || value === "") {
      if (!this.issues.some((issue) => issue.column === this.headers.get(key))) {
        this.fail(key, "Bắt buộc nhập");
      }
      return false;
    }
    return true;
  }
}

export function headerMap(columns: ColumnDef[]): Map<string, string> {
  return new Map(columns.map((column) => [column.key, column.header]));
}

/** Khóa so sánh không dấu, không phân biệt hoa thường. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const COMMIT_TIMEOUT_MS = 120_000;
