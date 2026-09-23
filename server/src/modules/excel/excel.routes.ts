import { Router, type Response } from "express";
import multer from "multer";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { businessDateNow } from "../../lib/settings.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { storeContext } from "../../middlewares/store-context.js";
import type { AuthContext } from "../auth/auth.context.js";
import {
  controlledLedgerExport,
  customersExport,
  stockCountExport,
  goodsReceiptsExport,
  inventoryExport,
  invoicesExport,
  productsExport,
  rxSalesExport,
  suppliersExport,
  type ExportDefinition,
} from "./exports.js";
import type { ImportContext, ImportDefinition } from "./import-kit.js";
import { customersImport, suppliersImport } from "./import-partners.js";
import { productsImport } from "./import-products.js";
import { stockCountImport } from "./import-stock-count.js";
import { openingBalanceImport, receiptLinesImport } from "./import-stock.js";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, buildWorkbook, readSheet } from "./workbook.js";

export const excelRouter = Router();
excelRouter.use("/excel", authenticate, storeContext);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mỗi loại có kiểu dòng riêng
const IMPORTS: ImportDefinition<any>[] = [productsImport, suppliersImport, customersImport, openingBalanceImport, stockCountImport, receiptLinesImport];
const EXPORTS: ExportDefinition[] = [productsExport, suppliersExport, customersExport, inventoryExport, stockCountExport, invoicesExport, goodsReceiptsExport, rxSalesExport, controlledLedgerExport];

const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const PREVIEW_SAMPLE = 100;
const PREVIEW_ISSUES = 300;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });

const allowed = (auth: AuthContext, permissions: string[]) => permissions.some((permission) => auth.can(permission));

function findImport(auth: AuthContext, type: string) {
  const definition = IMPORTS.find((item) => item.type === type);
  if (!definition) throw AppError.notFound("Không có loại nhập Excel này");
  if (!allowed(auth, definition.permission)) throw new AppError(403, "FORBIDDEN", "Bạn không có quyền nhập dữ liệu này");
  if (definition.needsStore && !auth.storeId) throw new AppError(400, "STORE_REQUIRED", "Chọn cửa hàng trước khi nhập dữ liệu này");
  return definition;
}

function sendXlsx(res: Response, buffer: Buffer, fileName: string) {
  res
    .set("Content-Disposition", `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .set("Cache-Control", "no-store")
    .type(XLSX_TYPE)
    .send(buffer);
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function parseDay(value: unknown, label: string): Date | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw AppError.validation(`${label} phải có dạng YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDay(date) !== value) throw AppError.validation(`${label} không phải ngày hợp lệ`);
  return date;
}

/**
 * GET /api/v1/excel/catalog: các loại nhập/xuất người dùng được dùng ở cửa
 * hàng đang chọn — trang "Nhập / xuất Excel" chỉ hiện đúng những mục này.
 */
excelRouter.get("/excel/catalog", (req, res) => {
  const auth = req.auth!;
  sendData(res, {
    imports: IMPORTS.filter((item) => !item.previewOnly && allowed(auth, item.permission)).map((item) => ({
      type: item.type,
      title: item.title,
      needsStore: item.needsStore,
      guide: item.guide,
    })),
    exports: EXPORTS.filter((item) => allowed(auth, item.permission)).map((item) => ({
      type: item.type,
      title: item.title,
      needsStore: item.needsStore,
      dated: item.dated,
      audited: item.audited ?? false,
    })),
  });
});

/** GET /api/v1/excel/templates/{type}: tệp mẫu có dòng ví dụ và sheet hướng dẫn. */
excelRouter.get("/excel/templates/:type", async (req, res) => {
  const definition = IMPORTS.find((item) => item.type === req.params.type);
  if (!definition) throw AppError.notFound("Không có mẫu nhập Excel này");
  if (!allowed(req.auth!, definition.permission)) throw new AppError(403, "FORBIDDEN", "Bạn không có quyền nhập dữ liệu này");
  const buffer = await buildWorkbook([{ name: definition.title.slice(0, 31), columns: definition.columns, rows: definition.example }], {
    title: `Mẫu nhập ${definition.title}`,
    lines: [
      ...definition.guide,
      `Cột có dấu * là bắt buộc. Tối đa ${MAX_IMPORT_ROWS.toLocaleString("vi-VN")} dòng, ${MAX_IMPORT_BYTES / 1024 / 1024} MB mỗi tệp.`,
      "Xóa dòng ví dụ trước khi nhập. Giữ nguyên tiêu đề cột; thứ tự cột có thể thay đổi.",
      "Ngày ghi theo dạng dd/mm/yyyy hoặc định dạng ngày của Excel.",
    ],
    columns: definition.columns,
  });
  sendXlsx(res, buffer, `mau-nhap-${definition.type}.xlsx`);
});

/**
 * POST /api/v1/excel/imports/{type}?mode=preview|commit (multipart, field
 * "file"): preview đọc và kiểm tra toàn bộ tệp, không ghi gì; commit đọc
 * lại chính tệp đó, còn một lỗi là từ chối cả tệp (không ghi nửa chừng),
 * hợp lệ thì ghi trong một giao dịch và lưu nhật ký.
 */
excelRouter.post("/excel/imports/:type", upload.single("file"), async (req, res) => {
  const auth = req.auth!;
  const definition = findImport(auth, String(req.params.type));
  const mode = req.query["mode"] === "commit" ? "commit" : "preview";
  if (mode === "commit" && (definition.previewOnly || !definition.commit)) {
    throw new AppError(400, "BAD_REQUEST", "Loại dữ liệu này chỉ đọc để đổ vào biểu mẫu, không ghi trực tiếp");
  }
  if (!req.file) throw new AppError(400, "BAD_REQUEST", "Chưa chọn tệp Excel (.xlsx)");

  const { rows, missingColumns } = await readSheet(req.file.buffer, definition.columns);
  const ctx: ImportContext = { auth, storeId: auth.storeId, requestId: (res.locals.requestId as string | undefined) ?? null };
  const plan = missingColumns.length > 0 ? { rows: [], issues: [], notes: [] } : await definition.plan(rows, ctx);
  const summary = {
    type: definition.type,
    fileName: req.file.originalname,
    totalRows: rows.length,
    validRows: plan.rows.length,
    creates: plan.rows.filter((row) => row.action === "create").length,
    updates: plan.rows.filter((row) => row.action === "update").length,
    missingColumns,
    issueCount: plan.issues.length,
    issues: plan.issues.slice(0, PREVIEW_ISSUES),
    notes: plan.notes,
  };

  if (mode === "preview") {
    sendData(res, {
      ...summary,
      sample: plan.rows.slice(0, PREVIEW_SAMPLE).map(({ row, action, label }) => ({ row, action, label })),
      // Dòng phiếu nhập: trả đủ dữ liệu đã khớp để giao diện đổ vào form nháp.
      ...(definition.previewOnly ? { lines: plan.rows.map(({ row, data }) => ({ row, ...data })) } : {}),
    });
    return;
  }

  if (missingColumns.length > 0) {
    throw AppError.validation(`Tệp thiếu cột: ${missingColumns.join(", ")}`, [summary]);
  }
  if (plan.issues.length > 0) {
    throw AppError.validation(`Tệp còn ${plan.issues.length} lỗi — sửa hết rồi nhập lại, chưa có dòng nào được ghi`, [summary]);
  }
  if (plan.rows.length === 0) throw AppError.validation("Tệp không có dòng dữ liệu nào");

  const result = await definition.commit!(plan, ctx);
  await prisma.auditLog.create({
    data: {
      storeId: auth.storeId ?? null,
      actorId: auth.userId,
      action: "EXCEL_IMPORT",
      resourceType: definition.type,
      resourceId: result.documentId ?? null,
      requestId: ctx.requestId,
      after: { fileName: req.file.originalname, rows: plan.rows.length, created: result.created, updated: result.updated },
    },
  });
  sendData(res, { ...summary, ...result });
});

/** GET /api/v1/excel/exports/{type}?from=YYYY-MM-DD&to=YYYY-MM-DD */
excelRouter.get("/excel/exports/:type", async (req, res) => {
  const auth = req.auth!;
  const definition = EXPORTS.find((item) => item.type === req.params.type);
  if (!definition) throw AppError.notFound("Không có loại xuất Excel này");
  if (!allowed(auth, definition.permission)) throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xuất dữ liệu này");
  if (definition.needsStore && !auth.storeId) throw new AppError(400, "STORE_REQUIRED", "Chọn cửa hàng trước khi xuất dữ liệu này");

  const today = businessDateNow();
  const to = parseDay(req.query["to"], "Đến ngày") ?? today;
  const from = parseDay(req.query["from"], "Từ ngày") ?? new Date(to.getTime() - 29 * DAY_MS);
  if (from.getTime() > to.getTime()) throw AppError.validation("Từ ngày phải trước hoặc bằng đến ngày");
  if (definition.dated && (to.getTime() - from.getTime()) / DAY_MS >= MAX_RANGE_DAYS) {
    throw AppError.validation(`Chỉ xuất tối đa ${MAX_RANGE_DAYS} ngày mỗi lần`);
  }

  const sheets = await definition.build({ auth, storeId: auth.storeId, from, to });
  const store = auth.storeId ? await prisma.store.findUnique({ where: { id: auth.storeId }, select: { name: true } }) : null;
  const period = definition.dated ? ` từ ${isoDay(from).split("-").reverse().join("/")} đến ${isoDay(to).split("-").reverse().join("/")}` : "";
  const buffer = await buildWorkbook(sheets, {
    title: `${definition.title}${period}`,
    lines: [
      store ? `Cửa hàng: ${store.name}` : "Phạm vi: toàn chuỗi",
      `Xuất lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
      `Số dòng: ${sheets.map((sheet) => `${sheet.name} ${sheet.rows.length}`).join(" · ")}`,
    ],
  });

  if (definition.audited) {
    await prisma.auditLog.create({
      data: {
        storeId: auth.storeId ?? null,
        actorId: auth.userId,
        action: "EXCEL_EXPORT",
        resourceType: definition.type,
        requestId: (res.locals.requestId as string | undefined) ?? null,
        after: { rows: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) },
      },
    });
  }
  const suffix = definition.dated ? `-${isoDay(from)}-den-${isoDay(to)}` : `-${isoDay(today)}`;
  sendXlsx(res, buffer, `${definition.type}${suffix}.xlsx`);
});
