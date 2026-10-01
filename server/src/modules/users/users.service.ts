import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { updateWithVersion } from "../../lib/optimistic.js";
import { generateTempPassword, hashPassword } from "../../lib/password.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import type { CreateUserInput, PatchUserInput, RoleAssignmentInput } from "./users.schema.js";

import { ROLES, PERMISSIONS, additionalPermissionsFor } from "../../config/permissions.js";
import type { AuthContext } from "../auth/auth.context.js";

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
      additionalPermissions: item.additionalPermissions,
      qualificationReference: item.qualificationReference,
      responsibleProfessional: item.responsibleProfessional,
    })),
  };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Người giao vai trò chỉ giao được trong phạm vi mình quản lý nhân sự:
 * vai trò toàn chuỗi cần `user.manage` toàn chuỗi, vai trò tại cửa hàng cần
 * `user.manage` tại đúng cửa hàng đó.
 */
function assertCanAssign(
  actor: AuthContext,
  assignments: ReadonlyArray<{ storeId?: string | null }>,
): void {
  for (const a of assignments) {
    if (!a.storeId) {
      if (!actor.chainPermissions.has("user.manage"))
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ người quản lý nhân sự toàn chuỗi mới giao được vai trò toàn chuỗi",
        );
    } else if (!actor.permissionsForStore(a.storeId).has("user.manage")) {
      throw new AppError(403, "FORBIDDEN", "Bạn không quản lý nhân sự tại cửa hàng này");
    }
  }
}

/**
 * Kiểm tra một bộ phân công vai trò, dùng chung cho tạo tài khoản và đổi vai
 * trò. Phải gọi trong giao dịch đã giữ khóa 724091. `target.id` là null khi
 * tài khoản chưa được tạo.
 */
async function validateAssignments(
  tx: Tx,
  assignments: RoleAssignmentInput[],
  target: { id: string | null; isActive: boolean; practiceCertificateNumber: string | null },
): Promise<Map<string, { id: string }>> {
  const codes = [...new Set(assignments.map((a) => a.roleCode))];
  if (codes.some((code) => !ROLES.some((r) => r.code === code)))
    throw AppError.validation("Vai trò không hợp lệ hoặc đã ngừng sử dụng");
  const roles = await tx.role.findMany({ where: { code: { in: codes } } });
  if (roles.length !== codes.length) throw AppError.validation("Có mã vai trò không tồn tại");
  const roleByCode = new Map(roles.map((r) => [r.code, r]));
  const seen = new Set<string>();
  for (const a of assignments) {
    const key = `${a.roleCode}:${a.storeId ?? "chain"}`;
    if (seen.has(key)) throw AppError.validation("Vai trò bị lặp trong cùng phạm vi");
    seen.add(key);
    if (a.storeId && !(await tx.store.findFirst({ where: { id: a.storeId, isActive: true } })))
      throw AppError.validation("Cửa hàng không tồn tại hoặc đã ngừng hoạt động");
    if (
      a.additionalPermissions.length &&
      (!a.storeId ||
        a.additionalPermissions.some(
          (code) => !additionalPermissionsFor(a.roleCode).includes(code),
        ))
    ) {
      throw AppError.validation(
        "Quyền bổ sung phải thuộc danh sách cho phép và một cửa hàng cụ thể",
      );
    }
    if (a.roleCode === "pharmacist" && !a.qualificationReference)
      throw AppError.validation(
        "Cần ghi căn cứ đã kiểm tra bằng cấp chuyên môn trước khi gán vai trò Dược sĩ",
      );
    if (a.responsibleProfessional) {
      if (
        a.roleCode !== "pharmacist" ||
        !a.storeId ||
        !target.isActive ||
        !target.practiceCertificateNumber?.trim()
      )
        throw AppError.validation(
          "Người phụ trách phải là dược sĩ đang hoạt động, có chứng chỉ hành nghề và được phân công tại một cửa hàng cụ thể",
        );
      const existing = await tx.userRole.findFirst({
        where: {
          storeId: a.storeId,
          responsibleProfessional: true,
          ...(target.id ? { userId: { not: target.id } } : {}),
        },
      });
      if (existing)
        throw AppError.validation(
          "Cửa hàng đã có người chịu trách nhiệm chuyên môn; cần kết thúc phân công cũ trước",
        );
    }
  }
  return roleByCode;
}

function assignmentRows(
  userId: string,
  actorId: string,
  assignments: RoleAssignmentInput[],
  roleByCode: Map<string, { id: string }>,
) {
  return assignments.map((a) => ({
    userId,
    roleId: roleByCode.get(a.roleCode)!.id,
    storeId: a.storeId ?? null,
    assignedBy: actorId,
    additionalPermissions: [...new Set(a.additionalPermissions)],
    qualificationReference: a.roleCode === "pharmacist" ? (a.qualificationReference ?? null) : null,
    responsibleProfessional: a.responsibleProfessional,
  }));
}

/**
 * Tạo tài khoản (contract §21). Không gửi `password` thì máy chủ sinh mật
 * khẩu tạm, trả về đúng một lần và bắt đổi ở lần đăng nhập đầu. Tài khoản,
 * mật khẩu và phân quyền (nếu có) nằm trong một giao dịch: phân quyền không
 * hợp lệ thì không có tài khoản nào được tạo.
 */
export async function create(
  input: CreateUserInput,
  actor: AuthContext,
): Promise<{ id: string; tempPassword: string | null }> {
  const assignments = input.roles ?? [];
  assertCanAssign(actor, assignments);

  const managerSetPassword = input.password !== undefined;
  const plain = input.password ?? generateTempPassword();
  const passwordHash = await hashPassword(plain);
  const mustChangePassword = managerSetPassword ? input.mustChangePassword : true;
  const practiceCertificateNumber = input.practiceCertificateNumber?.trim() || null;

  const user = await withMappedErrors(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(724091)`;
        const roleByCode = await validateAssignments(tx, assignments, {
          id: null,
          isActive: true,
          practiceCertificateNumber,
        });
        const created = await tx.user.create({
          data: {
            username: input.username.toLowerCase(),
            passwordHash,
            mustChangePassword,
            fullName: input.fullName,
            phone: input.phone?.trim() || null,
            practiceCertificateNumber,
            defaultStoreId: input.defaultStoreId ?? null,
          },
        });
        if (assignments.length)
          await tx.userRole.createMany({
            data: assignmentRows(created.id, actor.userId, assignments, roleByCode),
          });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            action: "USER_CREATE",
            resourceType: "user",
            resourceId: created.id,
            // Không ghi mật khẩu, chỉ ghi ai đặt và có bắt đổi hay không.
            after: {
              username: created.username,
              fullName: created.fullName,
              password: managerSetPassword ? "SET_BY_MANAGER" : "TEMPORARY",
              mustChangePassword,
              roles: assignments,
            },
          },
        });
        return created;
      }),
    { conflictMessage: "Tên đăng nhập đã tồn tại" },
  );

  return { id: user.id, tempPassword: managerSetPassword ? null : plain };
}

export async function update(id: string, input: PatchUserInput): Promise<void> {
  const { version, ...fields } = input;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(724091)`;
    if (
      fields.practiceCertificateNumber !== undefined &&
      !fields.practiceCertificateNumber?.trim() &&
      (await tx.userRole.count({ where: { userId: id, responsibleProfessional: true } }))
    ) {
      throw AppError.validation(
        "Kết thúc phân công phụ trách chuyên môn trước khi xóa chứng chỉ hành nghề",
      );
    }
    await updateWithVersion({
      notFoundMessage: "Không tìm thấy người dùng",
      update: () =>
        tx.user.updateMany({
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
      exists: async () => (await tx.user.count({ where: { id } })) > 0,
    });
  });
}

/** Vai trò, quyền bổ sung và chức danh được thay nguyên tử, có nhật ký.
 * Khóa chung tránh hai quản lý đồng thời gỡ admin cuối hoặc phân công hai
 * người phụ trách cùng cửa hàng. Đây là thao tác quản trị ít xảy ra. */
export async function replaceRoles(
  targetUserId: string,
  actor: AuthContext,
  assignments: RoleAssignmentInput[],
): Promise<void> {
  const actorId = actor.userId;
  if (targetUserId === actorId)
    throw AppError.validation("Không thể tự đổi vai trò của chính mình");
  await withMappedErrors(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(724091)`;
        const target = await tx.user.findUnique({
          where: { id: targetUserId },
          include: { userRoles: { include: { role: true } } },
        });
        if (!target) throw AppError.notFound("Không tìm thấy người dùng");
        // Thay toàn bộ vai trò nên đụng cả phạm vi cũ lẫn mới: người sửa phải
        // quản lý nhân sự ở mọi phạm vi đó, không gỡ được vai trò ở nơi khác.
        assertCanAssign(actor, [...assignments, ...target.userRoles]);
        const roleByCode = await validateAssignments(tx, assignments, target);
        const removingAdmin =
          target.userRoles.some((a) => a.role.code === ADMIN_ROLE_CODE) &&
          !assignments.some((a) => a.roleCode === ADMIN_ROLE_CODE);
        if (
          removingAdmin &&
          !(await tx.userRole.findFirst({
            where: {
              role: { code: ADMIN_ROLE_CODE },
              user: { isActive: true },
              userId: { not: targetUserId },
            },
          }))
        )
          throw AppError.validation("Không thể gỡ vai trò admin của người cuối cùng còn giữ nó");
        await tx.userRole.deleteMany({ where: { userId: targetUserId } });
        if (assignments.length)
          await tx.userRole.createMany({
            data: assignmentRows(targetUserId, actorId, assignments, roleByCode),
          });
        await tx.refreshSession.updateMany({
          where: { userId: targetUserId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: "ROLES_CHANGED" },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: "USER_ROLES_REPLACE",
            resourceType: "user",
            resourceId: targetUserId,
            before: {
              roles: target.userRoles.map((a) => ({
                roleCode: a.role.code,
                storeId: a.storeId,
                additionalPermissions: a.additionalPermissions,
                qualificationReference: a.qualificationReference,
                responsibleProfessional: a.responsibleProfessional,
              })),
            },
            after: { roles: assignments },
          },
        });
      }),
    { conflictMessage: "Phân công bị trùng; tải lại thông tin trước khi lưu" },
  );
}

/** Không khóa admin cuối hoặc người đang được phân công phụ trách chuyên môn. */
export async function deactivate(targetUserId: string, actorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(724091)`;
    const target = await tx.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw AppError.notFound("Không tìm thấy người dùng");
    if (await tx.userRole.count({ where: { userId: targetUserId, responsibleProfessional: true } }))
      throw AppError.validation("Kết thúc phân công phụ trách chuyên môn trước khi khóa tài khoản");
    const isAdmin = await tx.userRole.findFirst({
      where: { userId: targetUserId, role: { code: ADMIN_ROLE_CODE } },
    });
    if (
      isAdmin &&
      !(await tx.userRole.findFirst({
        where: {
          role: { code: ADMIN_ROLE_CODE },
          user: { isActive: true },
          userId: { not: targetUserId },
        },
      }))
    )
      throw AppError.validation("Không thể vô hiệu hóa admin cuối cùng trong hệ thống");
    await tx.user.update({ where: { id: targetUserId }, data: { isActive: false } });
    await tx.refreshSession.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "USER_DEACTIVATED" },
    });
    await tx.auditLog.create({
      data: { actorId, action: "USER_DEACTIVATE", resourceType: "user", resourceId: targetUserId },
    });
  });
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
    where: { code: { in: ROLES.map((r) => r.code) } },
    include: { permissions: { select: { permissionCode: true } } },
    orderBy: { name: "asc" },
  });
  return roles.map((role) => ({
    code: role.code,
    name: role.name,
    description: role.description,
    additionalPermissions: additionalPermissionsFor(role.code).map((code) => ({
      code,
      description: PERMISSIONS.find((p) => p.code === code)!.description,
    })),
    permissions: role.permissions.map((item) => item.permissionCode).sort(),
    /** Mô tả quyền thật của vai trò, để giao diện tóm tắt quyền mà không viết cứng. */
    permissionDetails: role.permissions
      .map((item) => item.permissionCode)
      .sort()
      .map((code) => ({
        code,
        description: PERMISSIONS.find((p) => p.code === code)?.description ?? code,
      })),
  }));
}
