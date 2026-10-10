import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { activeClient } from "./erx-config.service.js";
import { ErxError, type DispensePayload, type DispensedItem } from "./erx-client.js";

/**
 * Báo "đã bán" lên Hệ thống đơn thuốc quốc gia (QĐ 808 mục IX).
 *
 * Giống liên thông CSDL Dược và hóa đơn điện tử: việc gửi KHÔNG nằm trong giao
 * dịch bán. Lượt quét định kỳ tìm hóa đơn bán theo đơn điện tử chưa có việc,
 * tạo việc, rồi gửi với thử lại giãn dần. Hệ thống quốc gia sập không làm chậm
 * hay chặn quầy bán, và không mất việc gửi khi máy chủ khởi động lại.
 */

const BACKOFF_MINUTES = [1, 5, 15, 60, 6 * 60, 24 * 60];
const nextAttempt = (attempts: number) =>
  new Date(Date.now() + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]! * 60_000);

/** Tạo việc cho hóa đơn bán theo đơn điện tử chưa có việc; đánh dấu hóa đơn đã gửi rồi mới hủy. */
export async function scanInvoices(
  storeId?: string,
): Promise<{ created: number; needsReview: number }> {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: "COMPLETED",
      prescription: { source: "NATIONAL" },
      dispenseJob: null,
      ...(storeId ? { storeId } : {}),
    },
    select: { id: true, storeId: true, prescriptionId: true },
    take: 500,
  });
  for (const invoice of invoices) {
    await prisma.ePrescriptionDispenseJob
      .create({
        data: {
          storeId: invoice.storeId,
          invoiceId: invoice.id,
          prescriptionId: invoice.prescriptionId!,
        },
      })
      .catch(() => undefined); // lượt quét khác vừa tạo: bỏ qua
  }

  // Đã báo bán rồi mới hủy hóa đơn: hệ thống quốc gia không có API rút lại,
  // phần mềm không tự đoán cách sửa — để dược sĩ xử lý trên cổng.
  const flagged = await prisma.ePrescriptionDispenseJob.updateMany({
    where: {
      status: "SENT",
      invoice: { status: { not: "COMPLETED" } },
      ...(storeId ? { storeId } : {}),
    },
    data: {
      status: "NEEDS_REVIEW",
      lastError:
        "Hóa đơn đã báo bán lên Hệ thống đơn thuốc quốc gia rồi bị hủy. Tài liệu kết nối không có API rút lại — điều chỉnh trên donthuocquocgia.vn.",
    },
  });
  return { created: invoices.length, needsReview: flagged.count };
}

/** ma_hoa_don tối đa 20 ký tự (mục IX.3): bỏ tiền tố "HD-" nếu mã dài hơn. */
export function invoiceRef(code: string): string {
  if (code.length <= 20) return code;
  return code.replace(/^HD-/, "").slice(-20);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Dựng dữ liệu báo bán từ hóa đơn và đơn thuốc đã lưu. `null` khi không còn gì để báo. */
export async function buildPayload(
  jobId: string,
): Promise<{ payload: DispensePayload } | { skip: string } | { error: string }> {
  const job = await prisma.ePrescriptionDispenseJob.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      store: {
        select: {
          name: true,
          phone: true,
          address: true,
          eprescriptionConfig: { select: { facilityCode: true } },
        },
      },
      invoice: {
        select: {
          code: true,
          status: true,
          lines: {
            where: { prescriptionItemId: { not: null } },
            select: {
              prescriptionItemId: true,
              baseQuantity: true,
              productName: true,
              usageInstruction: true,
            },
          },
        },
      },
      prescription: {
        select: {
          externalCode: true,
          nationalPayload: true,
          items: {
            select: {
              id: true,
              quantity: true,
              dosageInstruction: true,
              nationalDrugCode: true,
              nationalUnitName: true,
              nationalQuantity: true,
              productUnit: { select: { name: true, conversionToBase: true } },
            },
          },
        },
      },
    },
  });
  if (job.invoice.status !== "COMPLETED") return { skip: "Hóa đơn đã hủy trước khi báo bán" };
  const facilityCode = job.store.eprescriptionConfig?.facilityCode;
  if (!facilityCode)
    return {
      error:
        "Cửa hàng chưa khai mã định danh cơ sở cung ứng thuốc (Liên thông CSDL Dược → Đơn thuốc điện tử)",
    };

  // Biệt dược ghi trên đơn gốc, tra theo mã thuốc.
  const original = new Map<string, string>();
  const payloadItems =
    (
      job.prescription.nationalPayload as {
        thong_tin_don_thuoc?: Array<{ ma_thuoc?: string; biet_duoc?: string }>;
      } | null
    )?.thong_tin_don_thuoc ?? [];
  for (const row of payloadItems) if (row.ma_thuoc) original.set(row.ma_thuoc, row.biet_duoc ?? "");

  const items: DispensedItem[] = [];
  for (const item of job.prescription.items) {
    if (!item.nationalDrugCode) continue;
    const sold = job.invoice.lines.filter((line) => line.prescriptionItemId === item.id);
    const soldBase = sold.reduce((sum, line) => sum + line.baseQuantity, 0);
    if (soldBase === 0) continue;
    // Số lượng bán quy về đơn vị của dòng đơn (đã khớp theo tên đơn vị trên đơn).
    const conversion = item.productUnit?.conversionToBase ?? 1;
    items.push({
      ma_thuoc_da_ke_don: item.nationalDrugCode,
      ma_thuoc: item.nationalDrugCode,
      biet_duoc: (original.get(item.nationalDrugCode) ?? "").slice(0, 200),
      ten_thuoc: (sold[0]?.productName ?? "").slice(0, 200),
      don_vi_tinh: (item.nationalUnitName ?? item.productUnit?.name ?? "").slice(0, 200),
      so_luong: item.nationalQuantity === null ? item.quantity : Number(item.nationalQuantity),
      so_luong_ban: round2(soldBase / conversion),
      cach_dung: (
        sold.find((line) => line.usageInstruction)?.usageInstruction ??
        item.dosageInstruction ??
        ""
      ).slice(0, 200),
    });
  }
  if (items.length === 0) return { skip: "Hóa đơn không bán dòng nào của đơn điện tử" };

  return {
    payload: {
      ma_don_thuoc: job.prescription.externalCode!,
      thong_tin_thuoc: items,
      ma_dinh_danh_co_so_cung_ung_thuoc: facilityCode,
      ten_co_so_cung_ung_thuoc: job.store.name.slice(0, 2000),
      so_dien_thoai_co_so_cung_ung_thuoc: (job.store.phone ?? "").replace(/\D/g, "").slice(0, 12),
      dia_chi_co_so_cung_ung_thuoc: (job.store.address ?? "").slice(0, 2000),
      ma_hoa_don: invoiceRef(job.invoice.code),
    },
  };
}

/** Giữ chỗ trước khi gửi: hai lượt chạy song song không gửi trùng một việc. */
async function claim(jobId: string): Promise<boolean> {
  const moved = await prisma.ePrescriptionDispenseJob.updateMany({
    where: { id: jobId, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "SENDING" },
  });
  return moved.count === 1;
}

export type DrainResult = { sent: number; failed: number; rejected: number; skipped: number };

export async function drainQueue(limit = 25, storeId?: string): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, failed: 0, rejected: 0, skipped: 0 };
  const due = await prisma.ePrescriptionDispenseJob.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { lte: new Date() },
      ...(storeId ? { storeId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, attempts: true },
  });
  if (due.length === 0) return result;
  const client = await activeClient();

  for (const job of due) {
    if (!(await claim(job.id))) continue;
    const built = await buildPayload(job.id);
    if ("skip" in built) {
      await prisma.ePrescriptionDispenseJob.update({
        where: { id: job.id },
        data: { status: "CANCELLED", lastError: built.skip },
      });
      result.skipped++;
      continue;
    }
    if ("error" in built) {
      // Thiếu cấu hình: chờ lâu rồi thử lại, không dồn dập.
      await prisma.ePrescriptionDispenseJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          attempts: { increment: 1 },
          lastError: built.error,
          nextAttemptAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      result.failed++;
      continue;
    }
    try {
      await client.reportDispensed(built.payload);
      await prisma.ePrescriptionDispenseJob.update({
        where: { id: job.id },
        data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
      result.sent++;
    } catch (error) {
      const transient = error instanceof ErxError ? error.transient : true;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.ePrescriptionDispenseJob.update({
        where: { id: job.id },
        data: transient
          ? {
              status: "FAILED",
              attempts: { increment: 1 },
              lastError: message,
              nextAttemptAt: nextAttempt(job.attempts + 1),
            }
          : { status: "REJECTED", attempts: { increment: 1 }, lastError: message },
      });
      if (transient) result.failed++;
      else result.rejected++;
    }
  }
  return result;
}

/** Thử lại tay một việc bị từ chối hoặc lỗi (sau khi đã sửa dữ liệu, cấu hình). */
export async function retryJob(jobId: string, storeId: string, userId: string): Promise<void> {
  const moved = await prisma.ePrescriptionDispenseJob.updateMany({
    where: { id: jobId, storeId, status: { in: ["FAILED", "REJECTED"] } },
    data: { status: "PENDING", nextAttemptAt: new Date(), lastError: null },
  });
  if (moved.count === 0)
    throw AppError.invalidState("Chỉ thử lại được việc đang lỗi hoặc bị từ chối");
  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: userId,
      action: "EPRESCRIPTION_JOB_RETRY",
      resourceType: "eprescription_job",
      resourceId: jobId,
    },
  });
}

export async function listJobs(storeId: string, status?: string) {
  const rows = await prisma.ePrescriptionDispenseJob.findMany({
    where: { storeId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      invoice: { select: { code: true, soldAt: true } },
      prescription: { select: { code: true, externalCode: true, patientName: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    sentAt: row.sentAt,
    nextAttemptAt: row.nextAttemptAt,
    invoice: row.invoice,
    prescription: row.prescription,
  }));
}
