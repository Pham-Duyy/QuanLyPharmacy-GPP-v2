import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
// Dùng chung bộ mã hóa bí mật với liên thông CSDL Dược (khóa dẫn xuất từ JWT_SECRET).
import { decryptSecret, encryptSecret } from "../national-sync/nds-crypto.js";
import { ErxClient, erxRoot } from "./erx-client.js";

/**
 * Cấu hình Hệ thống đơn thuốc quốc gia. app-name/app-key cấp cho đơn vị làm
 * phần mềm nên là cấu hình chung cả chuỗi; mã định danh cơ sở cung ứng thuốc
 * thì riêng từng cửa hàng.
 */

export type ErxConfigView = {
  enabled: boolean;
  baseUrl: string;
  appName: string | null;
  /** Không bao giờ trả app-key ra ngoài. */
  hasAppKey: boolean;
  /** Mã định danh cơ sở cung ứng thuốc của cửa hàng đang chọn. */
  facilityCode: string | null;
  updatedAt: string | null;
};

export async function getConfigView(storeId: string | null): Promise<ErxConfigView> {
  const [config, store] = await Promise.all([
    prisma.ePrescriptionConfig.findUnique({ where: { id: 1 } }),
    storeId ? prisma.ePrescriptionStoreConfig.findUnique({ where: { storeId } }) : null,
  ]);
  return {
    enabled: config?.enabled ?? false,
    baseUrl: erxRoot(),
    appName: config?.appName ?? null,
    hasAppKey: Boolean(config?.appKeyCipher),
    facilityCode: store?.facilityCode ?? null,
    updatedAt: config?.updatedAt.toISOString() ?? null,
  };
}

export async function updateChainConfig(
  userId: string,
  patch: {
    enabled?: boolean | undefined;
    appName?: string | null | undefined;
    appKey?: string | null | undefined;
  },
): Promise<void> {
  const current = await prisma.ePrescriptionConfig.findUnique({ where: { id: 1 } });
  const appName = patch.appName === undefined ? (current?.appName ?? null) : patch.appName || null;
  const appKeyCipher =
    patch.appKey === undefined
      ? (current?.appKeyCipher ?? null)
      : patch.appKey
        ? encryptSecret(patch.appKey)
        : null;
  const enabled = patch.enabled ?? current?.enabled ?? false;
  if (enabled && (!appName || !appKeyCipher)) {
    throw AppError.validation("Nhập app-name và app-key do đơn vị vận hành cấp trước khi bật");
  }

  await prisma.$transaction(async (tx) => {
    await tx.ePrescriptionConfig.upsert({
      where: { id: 1 },
      create: { id: 1, enabled, appName, appKeyCipher, updatedBy: userId },
      update: { enabled, appName, appKeyCipher, updatedBy: userId },
    });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "EPRESCRIPTION_CONFIG_UPDATE",
        resourceType: "eprescription_config",
        // Không ghi app-key vào nhật ký, chỉ ghi là có đổi hay không.
        after: { enabled, appName, appKeyChanged: patch.appKey !== undefined },
      },
    });
  });
}

export async function updateStoreConfig(
  storeId: string,
  userId: string,
  facilityCode: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.ePrescriptionStoreConfig.upsert({
      where: { storeId },
      create: { storeId, facilityCode, updatedBy: userId },
      update: { facilityCode, updatedBy: userId },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: userId,
        action: "EPRESCRIPTION_STORE_CONFIG_UPDATE",
        resourceType: "eprescription_config",
        after: { facilityCode },
      },
    });
  });
}

/** Client đã cấu hình và đang bật; chưa bật thì báo rõ để giao diện hướng dẫn. */
export async function activeClient(): Promise<ErxClient> {
  const config = await prisma.ePrescriptionConfig.findUnique({ where: { id: 1 } });
  if (!config?.enabled || !config.appName || !config.appKeyCipher) {
    throw new AppError(
      409,
      "EPRESCRIPTION_DISABLED",
      "Chưa bật kết nối Hệ thống đơn thuốc quốc gia. Quản lý nhập app-name/app-key ở Liên thông CSDL Dược → Đơn thuốc điện tử.",
    );
  }
  const appKey = decryptSecret(config.appKeyCipher);
  if (!appKey)
    throw new AppError(
      409,
      "EPRESCRIPTION_DISABLED",
      "Không giải mã được app-key, nhập lại ở phần cấu hình",
    );
  return new ErxClient(config.appName, appKey);
}
