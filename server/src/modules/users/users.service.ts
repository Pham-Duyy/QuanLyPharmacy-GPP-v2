import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { updateWithVersion } from "../../lib/optimistic.js";
import { generateTempPassword, hashPassword } from "../../lib/password.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import type { CreateUserInput, PatchUserInput, RoleAssignmentInput } from "./users.schema.js";

const ADMIN_ROLE_CODE = "admin";

function toListItem(user: {
  id: string;
  username: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  userRoles: Array<{ role: { code: string; name: string }; storeId: string | null }>;
}) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    phone: user.phone,
    isActive: user.isActive,
    roles: user.userRoles.map((item) => ({
      roleCode: item.role.code,
      roleName: item.role.name,
      storeId: item.storeId,
    })),
  };
}

export async function list(query: { search?: string }) {
  const search = query.search?.trim();
  const users = await prisma.user.findMany({
    where: search
      ? {
          OR: [
            { username: { contains: search, mode: "insensitive" } },
            { fullName: { contains: search, mode: "insensitive" } },
          ],
        }
      : {},
    orderBy: { fullName: "asc" },
    include: { userRoles: { include: { role: { select: { code: true, name: true } } } } },
  });
  return users.map(toListItem);
}

export async function getDetail(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      userRoles: {
        include: {
          role: { select: { code: true, name: true } },
          store: { select: { id: true, code: true, name: true } },
        },
      },
    },
  });
  if (!user) throw AppError.notFound("Không tìm thấy người dùng");

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    phone: user.phone,
    practiceCertificateNumber: user.practiceCertificateNumber,
    mustChangePassword: user.mustChangePassword,
    isActive: user.isActive,
    defaultStoreId: user.defaultStoreId,
    version: user.version,
    roles: user.userRoles.map((item) => ({
      roleCode: item.role.code,
      roleName: item.role.name,
      storeId: item.storeId,
      storeName: item.store?.name ?? null,
    })),
  };
}

/** Tạo tài khoản với mật khẩu tạm, bắt đổi ở lần đăng nhập đầu (contract §21). */
export async function create(
  input: CreateUserInput,
  actorId: string,
): Promise<{ id: string; tempPassword: string }> {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const user = await withMappedErrors(
    () =>
      prisma.user.create({
        data: {
          username: input.username.toLowerCase(),
          passwordHash,
          fullName: input.fullName,
          phone: input.phone ?? null,
          practiceCertificateNumber: input.practiceCertificateNumber ?? null,
          defaultStoreId: input.defaultStoreId ?? null,
        },
      }),
    { conflictMessage: "Tên đăng nhập đã tồn tại" },
  );

  await prisma.auditLog.create({
    data: {
      actorId,
      action: "USER_CREATE",
      resourceType: "user",
      resourceId: user.id,
      after: { username: user.username, fullName: user.fullName },
    },
  });

  return { id: user.id, tempPassword };
}

export async function update(id: string, input: PatchUserInput): Promise<void> {
  const { version, ...fields } = input;

  await updateWithVersion({
    notFoundMessage: "Không tìm thấy người dùng",
    update: () =>
      prisma.user.updateMany({
        where: { id, version },
        data: {
          ...(fields.fullName !== undefined ? { fullName: fields.fullName } : {}),
          ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
          ...(fields.practiceCertificateNumber !== undefined
            ? { practiceCertificateNumber: fields.practiceCertificateNumber }
            : {}),
          version: { increment: 1 },
        },
      }),
    exists: async () => (await prisma.user.count({ where: { id } })) > 0,
  });
}

/** Số người hiện giữ vai trò admin (không phân biệt cửa hàng) — dùng để chặn gỡ người cuối cùng. */
async function countAdmins(): Promise<number> {
  const rows = await prisma.userRole.findMany({
    where: { role: { code: ADMIN_ROLE_CODE } },
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.length;
}

/**
 * Thay toàn bộ vai trò của một người (contract §21). Không ai tự đổi vai
 * trò của chính mình, và không được gỡ vai trò admin của người cuối cùng
 * còn giữ nó — hai luật này chặn đứt việc tự khóa quyền quản trị của cả hệ
 * thống. Đổi vai trò thì thu hồi mọi phiên đăng nhập hiện có (contract §3).
 */
export async function replaceRoles(
  targetUserId: string,
  actorId: string,
  assignments: RoleAssignmentInput[],
): Promise<void> {
  if (targetUserId === actorId) {
    throw AppError.validation("Không thể tự đổi vai trò của chính mình");
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw AppError.notFound("Không tìm thấy người dùng");

  const roleCodes = [...new Set(assignments.map((item) => item.roleCode))];
  const roles =
    roleCodes.length > 0 ? await prisma.role.findMany({ where: { code: { in: roleCodes } } }) : [];
  if (roles.length !== roleCodes.length) {
    throw AppError.validation("Có mã vai trò không tồn tại");
  }
  const roleByCode = new Map(roles.map((role) => [role.code, role]));

  const storeIds = [
    ...new Set(assignments.flatMap((item) => (item.storeId ? [item.storeId] : []))),
  ];
  if (storeIds.length > 0) {
    const storeCount = await prisma.store.count({ where: { id: { in: storeIds } } });
    if (storeCount !== storeIds.length) throw AppError.validation("Có storeId không tồn tại");
  }

  const currentlyAdmin = await prisma.userRole.findFirst({
    where: { userId: targetUserId, role: { code: ADMIN_ROLE_CODE } },
  });
  const willStillBeAdmin = assignments.some((item) => item.roleCode === ADMIN_ROLE_CODE);
  if (currentlyAdmin && !willStillBeAdmin && (await countAdmins()) <= 1) {
    throw AppError.validation("Không thể gỡ vai trò admin của người cuối cùng còn giữ nó");
  }

  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId: targetUserId } }),
    ...(assignments.length > 0
      ? [
          prisma.userRole.createMany({
            data: assignments.map((item) => ({
              userId: targetUserId,
              roleId: roleByCode.get(item.roleCode)!.id,
              storeId: item.storeId ?? null,
              assignedBy: actorId,
            })),
          }),
        ]
      : []),
    prisma.refreshSession.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "ROLES_CHANGED" },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: "USER_ROLES_REPLACE",
        resourceType: "user",
        resourceId: targetUserId,
        after: { roles: assignments },
      },
    }),
  ]);
}

/** Vô hiệu hóa và thu hồi mọi phiên (contract §3, §21); không được là admin cuối cùng. */
export async function deactivate(targetUserId: string, actorId: string): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw AppError.notFound("Không tìm thấy người dùng");

  const currentlyAdmin = await prisma.userRole.findFirst({
    where: { userId: targetUserId, role: { code: ADMIN_ROLE_CODE } },
  });
  if (currentlyAdmin && (await countAdmins()) <= 1) {
    throw AppError.validation("Không thể vô hiệu hóa admin cuối cùng trong hệ thống");
  }

  await prisma.$transaction([
    prisma.user.updateMany({ where: { id: targetUserId }, data: { isActive: false } }),
    prisma.refreshSession.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "USER_DEACTIVATED" },
    }),
    prisma.auditLog.create({
      data: { actorId, action: "USER_DEACTIVATE", resourceType: "user", resourceId: targetUserId },
    }),
  ]);
}

export async function activate(targetUserId: string, actorId: string): Promise<void> {
  const result = await prisma.user.updateMany({
    where: { id: targetUserId },
    data: { isActive: true },
  });
  if (result.count === 0) throw AppError.notFound("Không tìm thấy người dùng");

  await prisma.auditLog.create({
    data: { actorId, action: "USER_ACTIVATE", resourceType: "user", resourceId: targetUserId },
  });
}

/** Đặt mật khẩu tạm mới, bắt đổi ở lần đăng nhập tới, thu hồi mọi phiên (contract §3, §21). */
export async function resetPassword(targetUserId: string, actorId: string): Promise<string> {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const result = await prisma.user.updateMany({
    where: { id: targetUserId },
    data: {
      passwordHash,
      mustChangePassword: true,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
    },
  });
  if (result.count === 0) throw AppError.notFound("Không tìm thấy người dùng");

  await prisma.$transaction([
    prisma.refreshSession.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "PASSWORD_RESET" },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: "USER_PASSWORD_RESET",
        resourceType: "user",
        resourceId: targetUserId,
      },
    }),
  ]);

  return tempPassword;
}

/** `GET /roles`: danh sách vai trò và permission của từng vai trò (contract §21). */
export async function listRoles() {
  const roles = await prisma.role.findMany({
    include: { permissions: { select: { permissionCode: true } } },
    orderBy: { name: "asc" },
  });
  return roles.map((role) => ({
    code: role.code,
    name: role.name,
    description: role.description,
    permissions: role.permissions.map((item) => item.permissionCode).sort(),
  }));
}
