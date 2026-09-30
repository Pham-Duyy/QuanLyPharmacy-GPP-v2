import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type { NdsClient } from "./nds-client.js";
import type { NationalDrugDto, NationalUnitDto } from "./nds-schemas.js";

/** Trần số trang mỗi lượt đồng bộ: chặn vòng lặp vô tận nếu API trả `total` sai. */
const MAX_PAGES = 400;
const PAGE_SIZE = 50;

/**
 * Chuẩn hóa tên thuốc để so khớp: bỏ dấu tiếng Việt, bỏ ký tự không phải chữ
 * và số, gộp khoảng trắng. "Amlodipin 5mg" và "AMLODIPIN 5 MG" thành một.
 */
export function normalizeDrugName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Số đăng ký so khớp không phân biệt hoa thường, dấu cách và gạch nối. */
export function normalizeRegistrationNumber(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, "");
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function drugRow(dto: NationalDrugDto) {
  return {
    id: dto.id,
    name: dto.name,
    drugGroupId: dto.drug_group_id ?? null,
    registrationNumber: dto.registration_number ?? null,
    oldRegistrationNumber: dto.old_registration_number ?? null,
    activeIngredient: dto.active_pharmaceutical_ingredient ?? null,
    strength: dto.strength ?? null,
    prescriptionStatus: dto.prescription_status ?? null,
    specialControlType: dto.special_control_type ?? null,
    manufacturerId: dto.manufacturer?.id ?? null,
    manufacturerName: dto.manufacturer?.name ?? null,
    manufacturerCountry: dto.manufacturer?.country ?? null,
    packagings: (dto.packagings ?? []) as object,
    lastUpdateTime: toDate(dto.last_update_time),
    syncedAt: new Date(),
  };
}

/**
 * Ghi cả trang danh mục bằng MỘT câu lệnh.
 *
 * Danh mục thuốc quốc gia có hàng chục nghìn dòng; upsert từng dòng nghĩa là
 * từng ấy lượt đi về CSDL, lượt đồng bộ đầu tiên sẽ chạy rất lâu. Prisma
 * chưa có upsert hàng loạt nên dùng thẳng `INSERT ... ON CONFLICT DO UPDATE`.
 */
async function upsertUnits(items: NationalUnitDto[]): Promise<void> {
  if (items.length === 0) return;
  await prisma.$executeRaw`
    INSERT INTO "national_units" ("id", "name", "synced_at")
    SELECT id, name, now()
    FROM UNNEST(
      ${items.map((item) => item.id)}::text[],
      ${items.map((item) => item.name)}::text[]
    ) AS t(id, name)
    ON CONFLICT ("id") DO UPDATE
      SET "name" = EXCLUDED."name", "synced_at" = EXCLUDED."synced_at"`;
}

type DrugRow = ReturnType<typeof drugRow>;

async function upsertDrugs(rows: DrugRow[]): Promise<void> {
  if (rows.length === 0) return;
  await prisma.$executeRaw`
    INSERT INTO "national_drugs" (
      "id", "name", "drug_group_id", "registration_number", "old_registration_number",
      "active_ingredient", "strength", "prescription_status", "special_control_type",
      "manufacturer_id", "manufacturer_name", "manufacturer_country", "packagings",
      "last_update_time", "synced_at")
    SELECT * FROM UNNEST(
      ${rows.map((row) => row.id)}::text[],
      ${rows.map((row) => row.name)}::text[],
      ${rows.map((row) => row.drugGroupId)}::text[],
      ${rows.map((row) => row.registrationNumber)}::text[],
      ${rows.map((row) => row.oldRegistrationNumber)}::text[],
      ${rows.map((row) => row.activeIngredient)}::text[],
      ${rows.map((row) => row.strength)}::text[],
      ${rows.map((row) => row.prescriptionStatus)}::smallint[],
      ${rows.map((row) => row.specialControlType)}::smallint[],
      ${rows.map((row) => row.manufacturerId)}::text[],
      ${rows.map((row) => row.manufacturerName)}::text[],
      ${rows.map((row) => row.manufacturerCountry)}::text[],
      ${rows.map((row) => JSON.stringify(row.packagings))}::jsonb[],
      ${rows.map((row) => row.lastUpdateTime)}::timestamptz[],
      ${rows.map((row) => row.syncedAt)}::timestamptz[]
    )
    ON CONFLICT ("id") DO UPDATE SET
      "name" = EXCLUDED."name",
      "drug_group_id" = EXCLUDED."drug_group_id",
      "registration_number" = EXCLUDED."registration_number",
      "old_registration_number" = EXCLUDED."old_registration_number",
      "active_ingredient" = EXCLUDED."active_ingredient",
      "strength" = EXCLUDED."strength",
      "prescription_status" = EXCLUDED."prescription_status",
      "special_control_type" = EXCLUDED."special_control_type",
      "manufacturer_id" = EXCLUDED."manufacturer_id",
      "manufacturer_name" = EXCLUDED."manufacturer_name",
      "manufacturer_country" = EXCLUDED."manufacturer_country",
      "packagings" = EXCLUDED."packagings",
      "last_update_time" = EXCLUDED."last_update_time",
      "synced_at" = EXCLUDED."synced_at"`;
}

export type MasterSyncResult = {
  units: number;
  drugs: number;
  /** Mốc dùng cho `last_update_from`; `null` là kéo toàn bộ danh mục. */
  updatedFrom: string | null;
};

/**
 * Kéo danh mục đơn vị tính và danh mục thuốc về máy.
 *
 * API quốc gia không thông báo khi danh mục đổi, phần mềm phải tự hỏi qua
 * `last_update_from`. Lượt đầu kéo toàn bộ, các lượt sau chỉ kéo phần đổi từ
 * lần đồng bộ trước, lùi lại một ngày cho chắc.
 */
export async function syncMasterData(
  client: NdsClient,
  options: { full?: boolean } = {},
): Promise<MasterSyncResult> {
  const config = await prisma.nationalSyncConfig.findUnique({ where: { id: true } });

  let updatedFrom: string | null = null;
  if (!options.full && config?.lastMasterSyncAt) {
    const since = new Date(config.lastMasterSyncAt.getTime() - 24 * 60 * 60 * 1000);
    updatedFrom = since.toISOString().slice(0, 10);
  }

  // Đơn vị tính: danh mục nhỏ, luôn kéo đủ.
  let units = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, total } = await client.fetchUnitsPage(page, PAGE_SIZE);
    if (items.length === 0) break;
    await upsertUnits(items);
    units += items.length;
    if (units >= total || items.length < PAGE_SIZE) break;
  }

  let drugs = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, total } = await client.fetchDrugsPage(page, {
      pageSize: PAGE_SIZE,
      ...(updatedFrom ? { updatedFrom } : {}),
    });
    if (items.length === 0) break;
    await upsertDrugs(items.map(drugRow));
    drugs += items.length;
    if (drugs >= total || items.length < PAGE_SIZE) break;
  }

  await prisma.nationalSyncConfig.update({
    where: { id: true },
    data: { lastMasterSyncAt: new Date() },
  });

  return { units, drugs, updatedFrom };
}

// --- Ghép mã ----------------------------------------------------------------

type Packaging = { unit_id?: string; unit_name?: string; gtin?: string };

function packagingsOf(value: unknown): Packaging[] {
  return Array.isArray(value) ? (value as Packaging[]) : [];
}

/**
 * Tìm mã đơn vị quốc gia tương ứng với đơn vị cơ bản của mặt hàng. Ưu tiên
 * quy cách đóng gói của chính thuốc đó (có kèm mã GTIN), không có thì tra
 * danh mục đơn vị tính chung.
 */
function resolveUnit(
  drugPackagings: unknown,
  baseUnitName: string,
  /** Danh mục đơn vị tính đã nạp sẵn: tra trong vòng lặp không được gọi lại CSDL. */
  unitsByName: Map<string, string>,
): { unitId: string; gtin: string | null } | null {
  const target = normalizeDrugName(baseUnitName);

  for (const packaging of packagingsOf(drugPackagings)) {
    if (packaging.unit_id && normalizeDrugName(packaging.unit_name ?? "") === target) {
      return { unitId: packaging.unit_id, gtin: packaging.gtin ?? null };
    }
  }

  const unitId = unitsByName.get(target);
  return unitId ? { unitId, gtin: null } : null;
}

export type AutoMatchResult = {
  scanned: number;
  matchedByRegistration: number;
  matchedByName: number;
  unmatched: number;
};

/**
 * Ghép tự động các mặt hàng chưa có mã quốc gia.
 *
 * Số đăng ký là định danh do Bộ Y tế cấp nên khớp số đăng ký là chắc chắn.
 * Khớp theo tên chỉ là gợi ý: nó vẫn được lưu nhưng **phải có người xác nhận**
 * mới được dùng để gửi dữ liệu (xem `isLinkUsable`).
 */
export async function autoMatchProducts(): Promise<AutoMatchResult> {
  const products = await prisma.product.findMany({
    where: { isActive: true, nationalDrugLink: null },
    include: { units: { where: { conversionToBase: 1 } } },
  });

  // Nạp một lần rồi tra trong bộ nhớ: vòng lặp bên dưới không gọi lại CSDL.
  const [drugs, units] = await Promise.all([
    prisma.nationalDrug.findMany(),
    prisma.nationalUnit.findMany(),
  ]);
  const unitsByName = new Map(units.map((unit) => [normalizeDrugName(unit.name), unit.id]));

  const byRegistration = new Map<string, (typeof drugs)[number]>();
  const byName = new Map<string, (typeof drugs)[number]>();
  const ambiguousNames = new Set<string>();

  for (const drug of drugs) {
    for (const candidate of [drug.registrationNumber, drug.oldRegistrationNumber]) {
      if (candidate) byRegistration.set(normalizeRegistrationNumber(candidate), drug);
    }
    const key = normalizeDrugName(drug.name);
    // Nhiều thuốc trùng tên (khác hàm lượng, khác hãng) thì không đoán bừa.
    if (byName.has(key)) ambiguousNames.add(key);
    byName.set(key, drug);
  }

  const result: AutoMatchResult = {
    scanned: products.length,
    matchedByRegistration: 0,
    matchedByName: 0,
    unmatched: 0,
  };
  const created: Array<{
    productId: string;
    drugId: string;
    unitId: string;
    gtin: string | null;
    matchedBy: string;
  }> = [];

  for (const product of products) {
    const baseUnit = product.units[0];
    if (!baseUnit) {
      result.unmatched += 1;
      continue;
    }

    let drug = product.registrationNumber
      ? byRegistration.get(normalizeRegistrationNumber(product.registrationNumber))
      : undefined;
    let matchedBy: "REGISTRATION_NUMBER" | "NAME" = "REGISTRATION_NUMBER";

    if (!drug) {
      const key = normalizeDrugName(product.name);
      if (!ambiguousNames.has(key)) drug = byName.get(key);
      matchedBy = "NAME";
    }

    if (!drug) {
      result.unmatched += 1;
      continue;
    }

    const unit = resolveUnit(drug.packagings, baseUnit.name, unitsByName);
    if (!unit) {
      // Ghép được thuốc nhưng không ra đơn vị tính thì vẫn là chưa ghép được:
      // gửi thiếu unit_id chắc chắn bị từ chối.
      result.unmatched += 1;
      continue;
    }

    created.push({
      productId: product.id,
      drugId: drug.id,
      unitId: unit.unitId,
      gtin: unit.gtin,
      matchedBy,
    });

    if (matchedBy === "REGISTRATION_NUMBER") result.matchedByRegistration += 1;
    else result.matchedByName += 1;
  }

  // Ghi một lượt thay vì từng dòng: danh mục lớn thì chênh lệch rất rõ.
  if (created.length > 0) await prisma.nationalDrugLink.createMany({ data: created });

  return result;
}

/**
 * Mã đã ghép có được phép dùng để gửi dữ liệu thật chưa.
 *
 * Khớp theo số đăng ký thì tin được ngay. Khớp theo tên hoặc do người dùng
 * tự chọn thì phải có người xác nhận — gửi sai mã thuốc lên Bộ Y tế là sai
 * dữ liệu quản lý dược, không phải lỗi hiển thị.
 */
export function isLinkUsable(link: { matchedBy: string; confirmedAt: Date | null }): boolean {
  return link.confirmedAt !== null || link.matchedBy === "REGISTRATION_NUMBER";
}

export async function setLink(
  productId: string,
  input: { drugId: string; unitId: string; gtin?: string | null },
  userId: string,
): Promise<void> {
  const [product, drug] = await Promise.all([
    prisma.product.findUnique({ where: { id: productId } }),
    prisma.nationalDrug.findUnique({ where: { id: input.drugId } }),
  ]);
  if (!product) throw AppError.notFound("Không tìm thấy mặt hàng");
  if (!drug) {
    throw AppError.validation("Mã thuốc quốc gia không có trong danh mục đã đồng bộ", [
      { field: "drugId", message: "Hãy đồng bộ lại danh mục thuốc rồi chọn lại" },
    ]);
  }

  const gtin =
    input.gtin ??
    packagingsOf(drug.packagings).find((packaging) => packaging.unit_id === input.unitId)?.gtin ??
    null;

  const data = {
    drugId: input.drugId,
    unitId: input.unitId,
    gtin,
    matchedBy: "MANUAL",
    confirmedBy: userId,
    confirmedAt: new Date(),
  };

  await prisma.nationalDrugLink.upsert({
    where: { productId },
    create: { productId, ...data },
    update: data,
  });

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "NATIONAL_DRUG_LINK_SET",
      resourceType: "product",
      resourceId: productId,
      after: { drugId: input.drugId, unitId: input.unitId, gtin },
    },
  });
}

/** Xác nhận một mã ghép tự động là đúng, cho phép dùng để gửi dữ liệu. */
export async function confirmLink(productId: string, userId: string): Promise<void> {
  const link = await prisma.nationalDrugLink.findUnique({ where: { productId } });
  if (!link) throw AppError.notFound("Mặt hàng chưa được ghép mã thuốc quốc gia");

  await prisma.nationalDrugLink.update({
    where: { productId },
    data: { confirmedBy: userId, confirmedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "NATIONAL_DRUG_LINK_CONFIRM",
      resourceType: "product",
      resourceId: productId,
      after: { drugId: link.drugId, unitId: link.unitId },
    },
  });
}

/**
 * Xác nhận một loạt mã ghép đã được xem trên màn hình.
 *
 * Nhận **danh sách mã cụ thể** chứ không phải lệnh "xác nhận hết": giao diện
 * gửi lên đúng những dòng đang hiển thị, nên người dùng đã nhìn thấy từng
 * cặp mặt hàng ↔ thuốc trước khi xác nhận. Nhà thuốc vài trăm mặt hàng mà
 * bắt bấm từng cái thì người ta sẽ bấm bừa, lúc đó luật kiểm soát còn tệ hơn.
 */
export async function confirmLinks(productIds: string[], userId: string): Promise<number> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return 0;

  const links = await prisma.nationalDrugLink.findMany({
    where: { productId: { in: unique }, confirmedAt: null },
    select: { productId: true, drugId: true },
  });
  if (links.length === 0) return 0;

  const now = new Date();
  await prisma.nationalDrugLink.updateMany({
    where: { productId: { in: links.map((link) => link.productId) } },
    data: { confirmedBy: userId, confirmedAt: now },
  });

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "NATIONAL_DRUG_LINK_CONFIRM_BULK",
      resourceType: "national_drug_link",
      resourceId: null,
      after: { count: links.length, links },
    },
  });

  return links.length;
}

export async function removeLink(productId: string, userId: string): Promise<void> {
  const link = await prisma.nationalDrugLink.findUnique({ where: { productId } });
  if (!link) throw AppError.notFound("Mặt hàng chưa được ghép mã thuốc quốc gia");

  await prisma.nationalDrugLink.delete({ where: { productId } });
  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "NATIONAL_DRUG_LINK_REMOVE",
      resourceType: "product",
      resourceId: productId,
      before: { drugId: link.drugId, unitId: link.unitId },
    },
  });
}
