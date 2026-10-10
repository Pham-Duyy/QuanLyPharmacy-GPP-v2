import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { businessDateNow, getSetting } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import { activeClient } from "./erx-config.service.js";
import {
  ErxError,
  PRESCRIPTION_CODE,
  normalizeCode,
  type NationalDrugItem,
  type NationalPrescription,
} from "./erx-client.js";

/**
 * Lấy đơn thuốc điện tử về thành đơn thuốc nháp của nhà thuốc (contract §12.1).
 *
 * Sau khi lấy về, đơn đi đúng luồng sẵn có: dược sĩ khớp thuốc chưa khớp,
 * xác nhận đơn, rồi mới bán. Mã thuốc trên đơn được tự khớp với sản phẩm nếu
 * đã từng ghép (bảng eprescription_drug_links) hoặc trùng mã thuốc quốc gia
 * đã ghép ở liên thông CSDL Dược.
 */

/** Ngày kê: tài liệu không nêu định dạng — nhận YYYY-MM-DD… hoặc DD/MM/YYYY…, không đọc được thì lấy hôm nay. */
export function parsePrescribedDate(value: unknown): Date {
  const text = typeof value === "string" ? value.trim() : "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (vn)
    return new Date(`${vn[3]}-${vn[2]!.padStart(2, "0")}-${vn[1]!.padStart(2, "0")}T00:00:00.000Z`);
  return businessDateNow();
}

/** Chẩn đoán có thể là chuỗi hoặc danh sách { ma_chan_doan, ten_chan_doan, ket_luan }. */
export function diagnosisText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const row = entry as Record<string, unknown>;
        const name = [row["ma_chan_doan"], row["ten_chan_doan"]].filter(Boolean).join(" ");
        return [name, row["ket_luan"]].filter(Boolean).join(": ");
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("; ").slice(0, 1000) : null;
  }
  return null;
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type ProductForMatch = {
  id: string;
  units: Array<{ id: string; name: string; conversionToBase: number }>;
};

/** Khớp một dòng thuốc trên đơn với sản phẩm và đơn vị bán. */
async function matchItem(
  item: NationalDrugItem,
): Promise<{ product: ProductForMatch; unitId: string; conversion: number } | null> {
  const code = item.ma_thuoc?.trim();
  if (!code) return null;
  const select = {
    id: true,
    units: { where: { isActive: true }, select: { id: true, name: true, conversionToBase: true } },
  } as const;
  const product =
    (
      await prisma.ePrescriptionDrugLink.findUnique({
        where: { nationalDrugCode: code },
        select: { product: { select } },
      })
    )?.product ??
    (
      await prisma.nationalDrugLink.findFirst({
        where: { drugId: code },
        select: { product: { select } },
      })
    )?.product ??
    null;
  if (!product || product.units.length === 0) return null;
  // Đơn vị trùng tên đơn vị trên đơn; không trùng thì dùng đơn vị nhỏ nhất.
  const unit =
    product.units.find(
      (candidate) => item.don_vi_tinh && sameName(candidate.name, item.don_vi_tinh),
    ) ??
    product.units.find((candidate) => candidate.conversionToBase === 1) ??
    product.units[0]!;
  return { product, unitId: unit.id, conversion: unit.conversionToBase };
}

export type ImportResult = { prescriptionId: string; created: boolean; unmatched: number };

export async function importByCode(
  storeId: string,
  auth: AuthContext,
  rawCode: string,
): Promise<ImportResult> {
  const code = normalizeCode(rawCode);
  if (!PRESCRIPTION_CODE.test(code)) {
    throw AppError.validation(
      "Mã đơn thuốc điện tử gồm 14 ký tự, dạng xxxxxyyyyyyy-c (đuôi -c, -n, -h hoặc -y)",
    );
  }

  // Một mã chỉ lấy về một lần: đã có thì mở lại đúng đơn đó.
  const existing = await prisma.prescription.findFirst({
    where: { source: "NATIONAL", externalCode: { equals: code, mode: "insensitive" } },
    select: { id: true, items: { where: { productId: null }, select: { id: true } } },
  });
  if (existing)
    return { prescriptionId: existing.id, created: false, unmatched: existing.items.length };

  const client = await activeClient();
  let national: NationalPrescription;
  try {
    national = await client.getPrescription(code);
  } catch (error) {
    if (error instanceof ErxError && error.status === 404) {
      throw AppError.notFound(`Không tìm thấy đơn thuốc ${code} trên Hệ thống đơn thuốc quốc gia`);
    }
    if (error instanceof ErxError)
      throw new AppError(502, "EPRESCRIPTION_UNAVAILABLE", error.message);
    throw error;
  }

  const items = (national.thong_tin_don_thuoc ?? []).filter(
    (item) => item && (item.ten_thuoc || item.ma_thuoc),
  );
  if (items.length === 0) throw AppError.validation("Đơn thuốc điện tử không có dòng thuốc nào");

  const matched = await Promise.all(items.map((item) => matchItem(item)));
  const prescribedDate = parsePrescribedDate(national.ngay_gio_ke_don);
  const validityDays = await getSetting("prescriptionValidityDays", storeId);
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { code: true },
  });

  const id = await prisma.$transaction(async (tx) => {
    const created = await tx.prescription.create({
      data: {
        storeId,
        code: await nextDocumentCode(tx, storeId, `DT-${store.code}-${codeDay()}-`),
        externalCode: code,
        source: "NATIONAL",
        patientName: national.ho_ten_benh_nhan?.trim() || null,
        patientBirthDate: national.ngay_sinh_benh_nhan
          ? String(national.ngay_sinh_benh_nhan).slice(0, 30)
          : null,
        prescriberName: national.ten_bac_si?.trim() || null,
        facilityName: national.ten_co_so_kham_chua_benh?.trim() || null,
        diagnosisText: diagnosisText(national.chan_doan),
        prescribedDate,
        validUntil: addDays(prescribedDate, validityDays),
        nationalPayload: national as Prisma.InputJsonValue,
        createdBy: auth.userId,
        items: {
          create: items.map((item, index) => {
            const match = matched[index];
            const quantity = Math.max(1, Math.round(Number(item.so_luong ?? 1)));
            return {
              lineNo: index + 1,
              productId: match?.product.id ?? null,
              productUnitId: match?.unitId ?? null,
              drugNameText:
                [item.ten_thuoc, item.biet_duoc ? `(${item.biet_duoc})` : null]
                  .filter(Boolean)
                  .join(" ")
                  .slice(0, 300) || String(item.ma_thuoc),
              quantity,
              baseQuantity: match ? quantity * match.conversion : null,
              dosageInstruction: item.cach_dung?.trim().slice(0, 500) || null,
              nationalDrugCode: item.ma_thuoc?.trim() || null,
              nationalUnitName: item.don_vi_tinh?.trim() || null,
              nationalQuantity:
                item.so_luong === undefined ? null : new Prisma.Decimal(Number(item.so_luong) || 0),
            };
          }),
        },
      },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "EPRESCRIPTION_IMPORT",
        resourceType: "prescription",
        resourceId: created.id,
        after: {
          externalCode: code,
          items: items.length,
          unmatched: matched.filter((m) => !m).length,
        },
      },
    });
    return created.id;
  });

  return { prescriptionId: id, created: true, unmatched: matched.filter((m) => !m).length };
}

/**
 * Dược sĩ chọn sản phẩm cho một dòng đơn điện tử chưa khớp. Lưu luôn cặp
 * mã thuốc trên đơn ↔ sản phẩm để lần sau tự khớp.
 */
export async function matchPrescriptionItem(
  prescriptionId: string,
  itemId: string,
  auth: AuthContext,
  input: { productId: string; unitId: string },
): Promise<void> {
  const item = await prisma.prescriptionItem.findFirst({
    where: { id: itemId, prescriptionId },
    include: { prescription: { select: { source: true, status: true, storeId: true } } },
  });
  if (!item) throw AppError.notFound("Không tìm thấy dòng thuốc của đơn");
  if (!["DRAFT", "PENDING_REVIEW"].includes(item.prescription.status)) {
    throw AppError.invalidState("Đơn đã xác nhận hoặc từ chối, không đổi thuốc được nữa");
  }
  const unit = await prisma.productUnit.findUnique({ where: { id: input.unitId } });
  if (!unit || unit.productId !== input.productId) {
    throw new AppError(422, "UNIT_NOT_IN_PRODUCT", "Đơn vị tính không thuộc sản phẩm đã chọn");
  }

  await prisma.$transaction(async (tx) => {
    await tx.prescriptionItem.update({
      where: { id: item.id },
      data: {
        productId: input.productId,
        productUnitId: unit.id,
        baseQuantity: item.quantity * unit.conversionToBase,
      },
    });
    if (item.nationalDrugCode) {
      await tx.ePrescriptionDrugLink.upsert({
        where: { nationalDrugCode: item.nationalDrugCode },
        create: {
          nationalDrugCode: item.nationalDrugCode,
          productId: input.productId,
          createdBy: auth.userId,
        },
        update: { productId: input.productId, createdBy: auth.userId, createdAt: new Date() },
      });
    }
    await tx.prescription.update({
      where: { id: prescriptionId },
      data: { version: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: {
        storeId: item.prescription.storeId,
        actorId: auth.userId,
        action: "EPRESCRIPTION_ITEM_MATCH",
        resourceType: "prescription",
        resourceId: prescriptionId,
        after: {
          itemId,
          nationalDrugCode: item.nationalDrugCode,
          productId: input.productId,
          unitId: unit.id,
        },
      },
    });
  });
}
