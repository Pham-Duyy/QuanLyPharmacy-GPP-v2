import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { storeContext } from "../../middlewares/store-context.js";

export const storesRouter = Router();

storesRouter.use(authenticate, storeContext);

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
    permissions: [...auth.permissionsForStore(store.id)].sort(),
  });
});
