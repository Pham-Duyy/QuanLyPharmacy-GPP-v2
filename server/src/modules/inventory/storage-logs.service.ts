import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { businessDateNow, getSetting } from "../../lib/settings.js";
import type { CreateStorageLogInput } from "./storage-logs.schema.js";

type ThresholdLike = {
  minTempC: unknown;
  maxTempC: unknown;
  maxHumidityPercent: unknown;
};

/** Vượt ngưỡng cấu hình của khu vực (contract §17, P16). */
function computeOutOfRange(
  temperatureC: number,
  humidityPercent: number | null,
  location: ThresholdLike,
): boolean {
  const min = location.minTempC !== null ? Number(location.minTempC) : null;
  const max = location.maxTempC !== null ? Number(location.maxTempC) : null;
  const maxHumidity =
    location.maxHumidityPercent !== null ? Number(location.maxHumidityPercent) : null;

  if (min !== null && temperatureC < min) return true;
  if (max !== null && temperatureC > max) return true;
  if (maxHumidity !== null && humidityPercent !== null && humidityPercent > maxHumidity)
    return true;
  return false;
}

type LogWithRelations = {
  id: bigint;
  recordedAt: Date;
  businessDate: Date;
  temperatureC: unknown;
  humidityPercent: unknown;
  outOfRange: boolean;
  note: string | null;
  correctsLogId: bigint | null;
  storageLocation: { id: string; code: string; name: string };
  recordedByUser: { id: string; fullName: string };
};

function toItem(log: LogWithRelations) {
  return {
    id: log.id.toString(),
    storageLocation: log.storageLocation,
    recordedAt: log.recordedAt,
    businessDate: log.businessDate,
    temperatureC: Number(log.temperatureC),
    humidityPercent: log.humidityPercent !== null ? Number(log.humidityPercent) : null,
    outOfRange: log.outOfRange,
    note: log.note,
    recordedBy: log.recordedByUser,
    correctsLogId: log.correctsLogId !== null ? log.correctsLogId.toString() : null,
  };
}

const include = {
  storageLocation: { select: { id: true, code: true, name: true } },
  recordedByUser: { select: { id: true, fullName: true } },
} as const;

/**
 * Ghi một lần đo (contract §17). Bản ghi không sửa/xóa; ghi nhầm thì tạo
 * bản ghi mới trỏ `correctsLogId` về bản cũ, cả hai vẫn còn nguyên trong sổ.
 */
export async function createLog(storeId: string, userId: string, input: CreateStorageLogInput) {
  const location = await prisma.storageLocation.findFirst({
    where: { storeId, code: input.location, isActive: true },
  });
  if (!location) throw AppError.notFound("Không tìm thấy khu vực bảo quản");

  const log = await prisma.storageLog.create({
    data: {
      storeId,
      storageLocationId: location.id,
      recordedAt: input.recordedAt,
      businessDate: businessDateNow(input.recordedAt),
      temperatureC: input.temperatureC,
      humidityPercent: input.humidityPercent ?? null,
      outOfRange: computeOutOfRange(input.temperatureC, input.humidityPercent ?? null, location),
      note: input.note ?? null,
      recordedBy: userId,
      correctsLogId: input.correctsLogId ? BigInt(input.correctsLogId) : null,
    },
    include,
  });

  return toItem(log);
}

export type ListQuery = {
  location?: string;
  from?: Date;
  to?: Date;
  outOfRange?: boolean;
};

export async function list(storeId: string, query: ListQuery) {
  const logs = await prisma.storageLog.findMany({
    where: {
      storeId,
      ...(query.location ? { storageLocation: { code: query.location } } : {}),
      ...(query.from || query.to ? { recordedAt: { gte: query.from, lte: query.to } } : {}),
      ...(query.outOfRange !== undefined ? { outOfRange: query.outOfRange } : {}),
    },
    orderBy: { recordedAt: "desc" },
    take: 500,
    include,
  });
  return logs.map(toItem);
}

/** Bảng theo ngày trong tháng, đánh dấu ngày thiếu lần đo hoặc có lần vượt ngưỡng. */
export async function getSummary(storeId: string, month: string) {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  if (!year || !monthNum || monthNum < 1 || monthNum > 12) {
    throw new AppError(422, "VALIDATION_ERROR", "month không hợp lệ, dùng định dạng YYYY-MM");
  }

  const start = new Date(Date.UTC(year, monthNum - 1, 1));
  const end = new Date(Date.UTC(year, monthNum, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();

  const [locations, expectedCount, logs] = await Promise.all([
    prisma.storageLocation.findMany({
      where: { storeId, isActive: true },
      orderBy: { code: "asc" },
    }),
    getSetting("storageLogPerDay", storeId),
    prisma.storageLog.findMany({
      where: { storeId, businessDate: { gte: start, lt: end } },
      select: { storageLocationId: true, businessDate: true, outOfRange: true },
    }),
  ]);

  return locations.map((location) => {
    const byDay = new Map<string, { count: number; hasOutOfRange: boolean }>();
    for (const log of logs) {
      if (log.storageLocationId !== location.id) continue;
      const key = log.businessDate.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { count: 0, hasOutOfRange: false };
      entry.count += 1;
      entry.hasOutOfRange = entry.hasOutOfRange || log.outOfRange;
      byDay.set(key, entry);
    }

    const days = Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const key = `${yearStr}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const entry = byDay.get(key);
      return {
        businessDate: key,
        count: entry?.count ?? 0,
        expectedCount,
        hasOutOfRange: entry?.hasOutOfRange ?? false,
      };
    });

    return {
      locationId: location.id,
      locationCode: location.code,
      locationName: location.name,
      days,
    };
  });
}
