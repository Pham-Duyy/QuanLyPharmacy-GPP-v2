import { Router } from "express";
import { ROLES } from "../../config/permissions.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { updateWithVersion } from "../../lib/optimistic.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import { createStoreSchema, patchStoreSchema } from "./stores.schema.js";

export const storesRouter = Router();

// Giới hạn theo tiền tố thật sự dùng, cùng lý do đã ghi ở categories.routes.ts.
storesRouter.use("/stores", authenticate, storeContext);

/** GET /api/v1/stores: các cửa hàng người dùng được phép làm việc (contract §21). */
storesRouter.get("/stores", async (req, res) => {
  const auth = req.auth!;

  const stores = await prisma.store.findMany({
    where: auth.hasChainRole
      ? { isActive: true }
      : { isActive: true, id: { in: auth.assignedStoreIds } },
    orderBy: { code: "asc" },
  });

  sendData(res, {
    items: stores.map((store) => ({
      id: store.id,
      code: store.code,
      name: store.name,
      address: store.address,
      phone: store.phone,
      isDefault: store.id === auth.defaultStoreId,
      permissions: [...auth.permissionsForStore(store.id)].sort(),
    })),
    pagination: { page: 1, limit: stores.length, total: stores.length },
  });
});

/**
 * Cửa hàng người dùng không có quyền thì trả 404 chứ không trả 403,
 * để không lộ việc bản ghi đó có tồn tại hay không (contract §2.8).
 */
storesRouter.get("/stores/:id", async (req, res) => {
  const auth = req.auth!;
  const id = String(req.params.id);

  if (!auth.canAccessStore(id)) {
    throw AppError.notFound("Không tìm thấy cửa hàng");
  }

  const store = await prisma.store.findUnique({ where: { id } });
  if (!store) throw AppError.notFound("Không tìm thấy cửa hàng");

  sendData(res, {
    id: store.id,
    code: store.code,
    name: store.name,
    address: store.address,
    phone: store.phone,
    gppCertificateNumber: store.gppCertificateNumber,
    licenseNumber: store.licenseNumber,
    isActive: store.isActive,
    version: store.version,
    permissions: [...auth.permissionsForStore(store.id)].sort(),
  });
});

/** Vai trò mang quyền mở/quản lý cửa hàng — gán cho người tạo tại cửa hàng mới. */
const STORE_MANAGER_ROLES = ROLES.filter((role) => role.permissions.includes("store.manage")).map(
  (role) => role.code,
);

/**
 * POST /api/v1/stores: mở cửa hàng mới trong chuỗi (contract §21).
 *
 * Danh sách cửa hàng chỉ gồm nơi người dùng có vai trò (trừ vai trò toàn
 * chuỗi). Người tạo không có `store.manage` toàn chuỗi thì được gán vai trò
 * quản lý tại cửa hàng mới, cùng giao dịch — nếu không, chính họ không thấy
 * và không vào được cửa hàng vừa mở.
 */
storesRouter.post("/stores", requirePermission("store.manage"), async (req, res) => {
  const input = parseOrThrow(createStoreSchema, req.body);
  const auth = req.auth!;
  const assignCreator = !auth.chainPermissions.has("store.manage");

  const store = await withMappedErrors(
    () =>
      prisma.$transaction(async (tx) => {
        const created = await tx.store.create({
          data: {
            code: input.code.toUpperCase(),
            name: input.name,
            address: input.address ?? null,
            phone: input.phone ?? null,
            gppCertificateNumber: input.gppCertificateNumber ?? null,
            licenseNumber: input.licenseNumber ?? null,
          },
        });

        const roles = assignCreator
          ? await tx.role.findMany({ where: { code: { in: STORE_MANAGER_ROLES } } })
          : [];
        if (roles.length)
          await tx.userRole.createMany({
            data: roles.map((role) => ({
              userId: auth.userId,
              roleId: role.id,
              storeId: created.id,
              assignedBy: auth.userId,
            })),
          });

        await tx.auditLog.create({
          data: {
            storeId: created.id,
            actorId: auth.userId,
            action: "STORE_CREATE",
            resourceType: "store",
            resourceId: created.id,
            after: {
              code: created.code,
              name: created.name,
              creatorAssignedRoles: roles.map((role) => role.code),
            },
          },
        });
        return created;
      }),
    { conflictMessage: "Mã cửa hàng đã tồn tại" },
  );

  sendData(res, store, 201);
});

/** PATCH /api/v1/stores/{id}: sửa thông tin cửa hàng, khóa lạc quan theo version (contract §2.5, §21). */
storesRouter.patch("/stores/:id", requirePermission("store.manage"), async (req, res) => {
  const input = parseOrThrow(patchStoreSchema, req.body);
  const id = String(req.params.id);
  const { version, ...fields } = input;

  await updateWithVersion({
    notFoundMessage: "Không tìm thấy cửa hàng",
    update: () =>
      withMappedErrors(() =>
        prisma.store.updateMany({
          where: { id, version },
          data: {
            ...(fields.name !== undefined ? { name: fields.name } : {}),
            ...(fields.address !== undefined ? { address: fields.address } : {}),
            ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
            ...(fields.gppCertificateNumber !== undefined
              ? { gppCertificateNumber: fields.gppCertificateNumber }
              : {}),
            ...(fields.licenseNumber !== undefined ? { licenseNumber: fields.licenseNumber } : {}),
            version: { increment: 1 },
          },
        }),
      ),
    exists: async () => (await prisma.store.count({ where: { id } })) > 0,
  });

  sendData(res, await prisma.store.findUnique({ where: { id } }));
});

/** POST /api/v1/stores/{id}/deactivate: ngừng hoạt động, chặn nghiệp vụ mới tại đó (contract §21). */
storesRouter.post("/stores/:id/deactivate", requirePermission("store.manage"), async (req, res) => {
  const id = String(req.params.id);

  const result = await prisma.store.updateMany({ where: { id }, data: { isActive: false } });
  if (result.count === 0) throw AppError.notFound("Không tìm thấy cửa hàng");

  await prisma.auditLog.create({
    data: {
      storeId: id,
      actorId: req.auth!.userId,
      action: "STORE_DEACTIVATE",
      resourceType: "store",
      resourceId: id,
    },
  });

  sendData(res, await prisma.store.findUnique({ where: { id } }));
});
