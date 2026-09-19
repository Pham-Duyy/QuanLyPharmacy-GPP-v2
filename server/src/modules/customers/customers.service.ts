import { randomBytes } from "node:crypto";
import type { PageQuery } from "../../lib/pagination.js";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { updateWithVersion } from "../../lib/optimistic.js";
import type { AuthContext } from "../auth/auth.context.js";
import type {
  CreateCustomerInput,
  PatchCustomerInput,
  PatchHealthProfileInput,
} from "./customers.schema.js";

/** Che bớt số điện thoại khi hiện trong danh sách tìm kiếm (contract §11). */
function maskPhone(phone: string | null): string | null {
  if (!phone || phone.length < 6) return phone;
  const head = phone.slice(0, 3);
  const tail = phone.slice(-3);
  return `${head}${"*".repeat(phone.length - 6)}${tail}`;
}

/**
 * Tìm theo tên hoặc số điện thoại, không phân biệt dấu tiếng Việt cho tên
 * (cùng cơ chế f_unaccent dùng cho sản phẩm, ERD §1.6). Chỉ trả trường tối
 * thiểu và che số điện thoại — đây là kết quả gợi ý lúc gõ tìm, không phải
 * xem chi tiết một khách cụ thể.
 */
export async function search(term: string) {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; full_name: string | null; phone: string | null }>
  >(Prisma.sql`
    SELECT id::text, full_name, phone
    FROM customers
    WHERE is_anonymized = false
      AND (
        f_unaccent(lower(full_name)) LIKE '%' || f_unaccent(lower(${term})) || '%'
        OR phone LIKE '%' || ${term} || '%'
      )
    ORDER BY full_name NULLS LAST
    LIMIT 20
  `);

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    phone: maskPhone(row.phone),
  }));
}

/** Danh sách phân trang cho màn Khách hàng: trường tối thiểu, số điện thoại che bớt. */
export async function list(page: PageQuery) {
  const where = { isAnonymized: false };
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [{ [page.sortBy]: page.order }, { id: "asc" }],
      skip: page.skip,
      take: page.limit,
      select: {
        id: true,
        fullName: true,
        phone: true,
        birthYear: true,
        gender: true,
        createdAt: true,
        healthDataConsentAt: true,
      },
    }),
    prisma.customer.count({ where }),
  ]);

  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      phone: maskPhone(row.phone),
      birthYear: row.birthYear,
      gender: row.gender,
      createdAt: row.createdAt,
      hasHealthConsent: row.healthDataConsentAt !== null,
    })),
  };
}

export async function getDetail(customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");

  return {
    id: customer.id,
    fullName: customer.fullName,
    phone: customer.phone,
    birthYear: customer.birthYear,
    gender: customer.gender,
    note: customer.note,
    hasHealthConsent: customer.healthDataConsentAt !== null,
    isAnonymized: customer.isAnonymized,
    version: customer.version,
  };
}

export async function create(input: CreateCustomerInput): Promise<string> {
  const customer = await prisma.customer.create({
    data: {
      fullName: input.fullName ?? null,
      phone: input.phone ?? null,
      birthYear: input.birthYear ?? null,
      gender: input.gender ?? null,
      note: input.note ?? null,
    },
  });
  return customer.id;
}

/**
 * Sửa không được để khách đang có dữ liệu biến thành hoàn toàn rỗng: nếu
 * một trường bị xóa (gửi null) thì trường còn lại phải vẫn có giá trị —
 * hoặc trường đó vốn đã có sẵn trong CSDL, hoặc chính request này gán cho
 * nó. Đọc bản ghi hiện tại trước để biết trường không được gửi trong
 * request vẫn giữ giá trị nào; race giữa lúc đọc và lúc ghi vẫn an toàn vì
 * `updateWithVersion` chặn bằng version ngay sau đó.
 */
export async function update(customerId: string, input: PatchCustomerInput): Promise<void> {
  const existing = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!existing) throw AppError.notFound("Không tìm thấy khách hàng");

  const nextFullName = input.fullName !== undefined ? input.fullName : existing.fullName;
  const nextPhone = input.phone !== undefined ? input.phone : existing.phone;
  if (!nextFullName && !nextPhone) {
    throw new AppError(422, "VALIDATION_ERROR", "Phải giữ lại ít nhất họ tên hoặc số điện thoại");
  }

  await updateWithVersion({
    notFoundMessage: "Không tìm thấy khách hàng",
    exists: async () => (await prisma.customer.count({ where: { id: customerId } })) > 0,
    update: () =>
      prisma.customer.updateMany({
        where: { id: customerId, version: input.version },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.birthYear !== undefined ? { birthYear: input.birthYear } : {}),
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          version: { increment: 1 },
        },
      }),
  });
}

/** Chi tiết hồ sơ sức khỏe. Mỗi lần xem đều ghi audit (contract §11, §18). */
export async function getHealthProfile(customerId: string, auth: AuthContext) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      healthProfile: true,
      allergies: { include: { ingredient: { select: { id: true, name: true } } } },
    },
  });
  if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");

  await prisma.auditLog.create({
    data: {
      actorId: auth.userId,
      action: "CUSTOMER_HEALTH_PROFILE_VIEW",
      resourceType: "customer",
      resourceId: customerId,
    },
  });

  return {
    hasHealthConsent: customer.healthDataConsentAt !== null,
    healthDataConsentAt: customer.healthDataConsentAt,
    chronicConditions: customer.healthProfile?.chronicConditions ?? null,
    note: customer.healthProfile?.note ?? null,
    allergies: customer.allergies.map((allergy) => ({
      ingredientId: allergy.ingredientId,
      ingredientName: allergy.ingredient.name,
      note: allergy.note,
    })),
  };
}

/**
 * Cập nhật hồ sơ sức khỏe: chặn nếu chưa ghi nhận đồng ý của khách, trừ khi
 * chính request này xác nhận đồng ý luôn (contract §11, P8). Thay nguyên
 * danh sách dị ứng thay vì thêm/xóa từng dòng — đơn giản và đủ dùng, vì đây
 * không phải danh sách lớn cần sửa từng phần như dòng hóa đơn.
 */
export async function updateHealthProfile(
  customerId: string,
  auth: AuthContext,
  input: PatchHealthProfileInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");

    const alreadyConsented = customer.healthDataConsentAt !== null;
    if (!alreadyConsented && !input.consent) {
      throw new AppError(
        422,
        "VALIDATION_ERROR",
        "Phải ghi nhận sự đồng ý của khách trước khi lưu hồ sơ sức khỏe",
      );
    }

    if (!alreadyConsented) {
      await tx.customer.update({
        where: { id: customerId },
        data: { healthDataConsentAt: new Date() },
      });
    }

    await tx.customerHealthProfile.upsert({
      where: { customerId },
      create: {
        customerId,
        chronicConditions: input.chronicConditions ?? null,
        note: input.note ?? null,
        updatedBy: auth.userId,
      },
      update: {
        chronicConditions: input.chronicConditions ?? null,
        note: input.note ?? null,
        updatedBy: auth.userId,
      },
    });

    await tx.customerAllergy.deleteMany({ where: { customerId } });
    if (input.allergies.length > 0) {
      await tx.customerAllergy.createMany({
        data: input.allergies.map((allergy) => ({
          customerId,
          ingredientId: allergy.ingredientId,
          note: allergy.note ?? null,
        })),
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: auth.userId,
        action: "CUSTOMER_HEALTH_PROFILE_UPDATE",
        resourceType: "customer",
        resourceId: customerId,
        after: { allergyCount: input.allergies.length },
      },
    });
  });
}

/**
 * Lịch sử mua hàng, gộp toàn chuỗi (contract §2.8: khách dùng chung toàn
 * chuỗi, mua ở cửa hàng nào cũng tra được). Mỗi lần xem đều ghi audit.
 */
export async function getInvoiceHistory(customerId: string, auth: AuthContext) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");

  const invoices = await prisma.invoice.findMany({
    where: { customerId },
    orderBy: { soldAt: "desc" },
    take: 100,
    include: { store: { select: { code: true, name: true } }, _count: { select: { lines: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId: auth.userId,
      action: "CUSTOMER_INVOICES_VIEW",
      resourceType: "customer",
      resourceId: customerId,
    },
  });

  return invoices.map((invoice) => ({
    id: invoice.id,
    code: invoice.code,
    storeCode: invoice.store.code,
    storeName: invoice.store.name,
    status: invoice.status,
    soldAt: invoice.soldAt,
    totalAmount: invoice.totalAmount,
    lineCount: invoice._count.lines,
  }));
}

/**
 * Ẩn danh khi khách yêu cầu xóa dữ liệu cá nhân (contract §11, P8). Chỉ xóa
 * đúng ba thứ contract nêu — họ tên, số điện thoại, hồ sơ sức khỏe — không
 * đụng tới birthYear/gender/note vì không nằm trong danh sách đó. Chứng từ
 * đã phát sinh (hóa đơn, đơn thuốc, thẻ kho) giữ nguyên, chỉ hiện tên thay
 * bằng mã ẩn danh nên vẫn tra cứu được mà không lộ danh tính.
 */
export async function anonymize(
  customerId: string,
  auth: AuthContext,
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw AppError.notFound("Không tìm thấy khách hàng");
    if (customer.isAnonymized) {
      throw new AppError(409, "INVALID_STATE", "Khách hàng này đã được ẩn danh từ trước");
    }

    const anonymCode = `KH-AN-${randomBytes(4).toString("hex").toUpperCase()}`;

    await tx.customer.update({
      where: { id: customerId },
      data: {
        fullName: anonymCode,
        phone: null,
        healthDataConsentAt: null,
        isAnonymized: true,
        anonymizedAt: new Date(),
      },
    });

    await tx.customerHealthProfile.deleteMany({ where: { customerId } });
    await tx.customerAllergy.deleteMany({ where: { customerId } });

    await tx.auditLog.create({
      data: {
        actorId: auth.userId,
        action: "CUSTOMER_ANONYMIZE",
        resourceType: "customer",
        resourceId: customerId,
        reason,
      },
    });
  });
}
