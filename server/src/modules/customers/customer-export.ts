import { prisma } from "../../db/prisma.js";
import type { AuthContext } from "../auth/auth.context.js";
import { listCustomers, type Segment, type SegmentFilter } from "./customer-insights.js";

const MAX_EXPORT_ROWS = 10_000;

const SEGMENT_LABEL: Record<Segment, string> = {
  LOYAL: "Thân thiết",
  NEW: "Khách mới",
  DORMANT: "Lâu chưa quay lại",
  REGULAR: "Khách thường",
};

const GENDER_LABEL: Record<string, string> = { MALE: "Nam", FEMALE: "Nữ", OTHER: "Khác" };

/**
 * Ô CSV an toàn: bọc ngoặc kép, nhân đôi ngoặc kép bên trong, và chặn công
 * thức Excel (ô bắt đầu bằng = + - @ bị Excel chạy như công thức).
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const date = (value: Date | null) =>
  value ? value.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "";

/** Xuất danh sách khách theo bộ lọc; ghi audit vì có số điện thoại đầy đủ. */
export async function exportCustomersCsv(
  auth: AuthContext,
  filters: { q?: string; segment?: SegmentFilter },
  requestId?: string,
): Promise<string> {
  const { rows } = await listCustomers(
    { page: 1, limit: MAX_EXPORT_ROWS, skip: 0, sortBy: "createdAt", order: "desc" },
    filters,
  );
  const extra = await prisma.customer.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: { id: true, email: true, address: true },
  });
  const contact = new Map(extra.map((row) => [row.id, row]));

  const header = [
    "Mã KH",
    "Họ tên",
    "Số điện thoại",
    "Năm sinh",
    "Giới tính",
    "Email",
    "Địa chỉ",
    "Ngày tạo",
    "Tổng mua (đ)",
    "Số đơn",
    "Lần mua cuối",
    "Nhóm",
  ];
  const lines = rows.map((row) =>
    [
      cell(row.code),
      cell(row.full_name),
      cell(row.phone),
      cell(row.birth_year),
      cell(row.gender ? GENDER_LABEL[row.gender] : null),
      cell(contact.get(row.id)?.email),
      cell(contact.get(row.id)?.address),
      cell(date(row.created_at)),
      cell(Number(row.total_spent)),
      cell(row.order_count),
      cell(date(row.last_purchase_at)),
      cell(SEGMENT_LABEL[row.segment]),
    ].join(","),
  );

  await prisma.auditLog.create({
    data: {
      storeId: auth.storeId ?? null,
      actorId: auth.userId,
      action: "CUSTOMER_EXPORT",
      resourceType: "customer",
      requestId: requestId ?? null,
      after: { rows: rows.length, filters },
    },
  });

  // BOM để Excel mở đúng tiếng Việt.
  return `﻿${[header.map(cell).join(","), ...lines].join("\r\n")}`;
}
