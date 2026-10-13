import { prisma } from "../../db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import { DEFAULT_STORAGE_LOCATIONS } from "./storage-location-defaults.js";
import type { CreateLocationInput, UpdateLocationInput } from "./storage-logs.schema.js";

type Tx = Prisma.TransactionClient;

type LocationRow = {
  id: string;
  code: string;
  name: string;
  minTempC: Prisma.Decimal | null;
  maxTempC: Prisma.Decimal | null;
  maxHumidityPercent: Prisma.Decimal | null;
  isActive: boolean;
};

const toNumber = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));

function toItem(row: LocationRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    minTempC: toNumber(row.minTempC),
    maxTempC: toNumber(row.maxTempC),
    maxHumidityPercent: toNumber(row.maxHumidityPercent),
    isActive: row.isActive,
  };
}

/** Tạo hai khu mặc định cho cửa hàng (bỏ qua khu đã có cùng mã). */
export async function createDefaultLocations(tx: Tx, storeId: string): Promise<void> {
  await tx.storageLocation.createMany({
    data: DEFAULT_STORAGE_LOCATIONS.map((location) => ({ storeId, ...location })),
    skipDuplicates: true,
  });
}

/** Mọi khu của cửa hàng, khu đang dùng trước. */
export async function listLocations(storeId: string, client: Tx = prisma) {
  const rows = await client.storageLocation.findMany({
    where: { storeId },
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
  return rows.map(toItem);
}

/** Cửa hàng chưa có khu nào (cửa hàng mở trước khi có chức năng này): tạo hai khu mặc định. */
export async function createDefaults(storeId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    if ((await tx.storageLocation.count({ where: { storeId } })) > 0) {
      throw AppError.invalidState("Cửa hàng đã có khu vực bảo quản, thêm từng khu nếu cần");
    }
    await createDefaultLocations(tx, storeId);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: userId,
        action: "STORAGE_LOCATION_CREATE",
        resourceType: "storage_location",
        after: { defaults: DEFAULT_STORAGE_LOCATIONS.map((location) => location.code) },
      },
    });
    return listLocations(storeId, tx);
  });
}

function checkRange(minTempC: number | null, maxTempC: number | null): void {
  if (minTempC !== null && maxTempC !== null && minTempC >= maxTempC) {
    throw AppError.validation("Nhiệt độ cao nhất phải lớn hơn nhiệt độ thấp nhất");
  }
}

/** Mã khu do máy tự đặt (KV01, KV02...): người dùng chỉ cần đặt tên. */
async function nextCode(tx: Tx, storeId: string): Promise<string> {
  const rows = await tx.storageLocation.findMany({
    where: { storeId, code: { startsWith: "KV" } },
    select: { code: true },
  });
  const used = rows.map((row) => Number(row.code.slice(2))).filter(Number.isInteger);
  return `KV${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
}

export async function createLocation(storeId: string, userId: string, input: CreateLocationInput) {
  checkRange(input.minTempC ?? null, input.maxTempC ?? null);
  return prisma.$transaction(async (tx) => {
    const created = await tx.storageLocation.create({
      data: {
        storeId,
        code: await nextCode(tx, storeId),
        name: input.name,
        minTempC: input.minTempC ?? null,
        maxTempC: input.maxTempC ?? null,
        maxHumidityPercent: input.maxHumidityPercent ?? null,
      },
    });
    const item = toItem(created);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: userId,
        action: "STORAGE_LOCATION_CREATE",
        resourceType: "storage_location",
        resourceId: created.id,
        after: item,
      },
    });
    return item;
  });
}

/**
 * Sửa tên, ngưỡng hoặc ngưng dùng khu. Không xóa khu: sổ đã ghi vẫn trỏ về khu
 * đó. Ngưỡng mới chỉ áp cho lần đo ghi sau; lần đo cũ giữ nguyên kết luận vượt
 * ngưỡng lúc ghi.
 */
export async function updateLocation(
  storeId: string,
  userId: string,
  locationId: string,
  input: UpdateLocationInput,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.storageLocation.findFirst({ where: { id: locationId, storeId } });
    if (!existing) throw AppError.notFound("Không tìm thấy khu vực bảo quản");
    const before = toItem(existing);
    const minTempC = input.minTempC === undefined ? before.minTempC : input.minTempC;
    const maxTempC = input.maxTempC === undefined ? before.maxTempC : input.maxTempC;
    checkRange(minTempC, maxTempC);

    const updated = await tx.storageLocation.update({
      where: { id: locationId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        minTempC,
        maxTempC,
        ...(input.maxHumidityPercent !== undefined
          ? { maxHumidityPercent: input.maxHumidityPercent }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    const after = toItem(updated);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: userId,
        action: "STORAGE_LOCATION_UPDATE",
        resourceType: "storage_location",
        resourceId: locationId,
        before,
        after,
      },
    });
    return after;
  });
}
