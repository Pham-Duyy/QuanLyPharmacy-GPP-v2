import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
// Dùng chung bộ mã hóa mật khẩu với liên thông CSDL Dược (khóa dẫn xuất từ JWT_SECRET).
import { decryptSecret, encryptSecret } from "../national-sync/nds-crypto.js";
import { MisaClient, misaRoot, type EInvoiceEnvironment } from "./misa-client.js";

/** Cấu hình hóa đơn điện tử theo cửa hàng: mỗi cơ sở có MST, ký hiệu, tài khoản riêng. */

export type EInvoiceConfigView = {
  storeId: string;
  enabled: boolean;
  provider: "MISA";
  environment: EInvoiceEnvironment;
  baseUrl: string;
  appId: string | null;
  taxCode: string | null;
  username: string | null;
  /** Không bao giờ trả mật khẩu ra ngoài. */
  hasPassword: boolean;
  invSeries: string | null;
  enabledFrom: string | null;
  updatedAt: string;
};

export async function readStoreConfig(storeId: string) {
  const existing = await prisma.eInvoiceStoreConfig.findUnique({ where: { storeId } });
  return (
    existing ?? {
      storeId,
      enabled: false,
      provider: "MISA",
      environment: "SANDBOX",
      appId: null,
      taxCode: null,
      username: null,
      passwordCipher: null,
      invSeries: null,
      enabledFrom: null,
      updatedAt: new Date(0),
      updatedBy: null,
    }
  );
}

function environmentOf(value: string): EInvoiceEnvironment {
  return value === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

export async function getConfigView(storeId: string): Promise<EInvoiceConfigView> {
  const row = await readStoreConfig(storeId);
  const environment = environmentOf(row.environment);
  return {
    storeId,
    enabled: row.enabled,
    provider: "MISA",
    environment,
    baseUrl: misaRoot(environment),
    appId: row.appId,
    taxCode: row.taxCode,
    username: row.username,
    hasPassword: Boolean(row.passwordCipher),
    invSeries: row.invSeries,
    enabledFrom: row.enabledFrom?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ConfigPatch = {
  enabled?: boolean;
  environment?: EInvoiceEnvironment;
  appId?: string | null;
  taxCode?: string | null;
  username?: string | null;
  password?: string | null;
  invSeries?: string | null;
};

export async function updateConfig(
  storeId: string,
  patch: ConfigPatch,
  userId: string,
): Promise<EInvoiceConfigView> {
  const current = await readStoreConfig(storeId);
  const pick = <K extends keyof ConfigPatch>(key: K, fallback: ConfigPatch[K]) =>
    patch[key] === undefined ? fallback : patch[key];

  const enabled = patch.enabled ?? current.enabled;
  const next = {
    enabled,
    environment: patch.environment ?? current.environment,
    appId: pick("appId", current.appId) ?? null,
    taxCode: pick("taxCode", current.taxCode) ?? null,
    username: pick("username", current.username) ?? null,
    invSeries: pick("invSeries", current.invSeries)?.toUpperCase() ?? null,
    passwordCipher:
      patch.password === undefined
        ? current.passwordCipher
        : patch.password === null || patch.password === ""
          ? null
          : encryptSecret(patch.password),
    // Mốc phát hành chốt ở lần bật đầu tiên; không phát hành hồi tố hóa đơn cũ.
    enabledFrom: enabled && !current.enabledFrom ? new Date() : current.enabledFrom,
    updatedBy: userId,
  };

  if (
    next.enabled &&
    (!next.appId || !next.taxCode || !next.username || !next.passwordCipher || !next.invSeries)
  ) {
    throw AppError.validation(
      "Phải nhập đủ AppID, mã số thuế, tài khoản, mật khẩu và ký hiệu hóa đơn trước khi bật",
      [{ field: "enabled", message: "Thiếu thông tin kết nối" }],
    );
  }

  await prisma.eInvoiceStoreConfig.upsert({
    where: { storeId },
    create: { storeId, ...next },
    update: next,
  });

  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: userId,
      action: "EINVOICE_CONFIG_UPDATE",
      resourceType: "einvoice_store_config",
      resourceId: storeId,
      // Không ghi mật khẩu vào nhật ký.
      after: {
        enabled: next.enabled,
        environment: next.environment,
        appId: next.appId,
        taxCode: next.taxCode,
        username: next.username,
        invSeries: next.invSeries,
        passwordChanged: patch.password !== undefined,
        enabledFrom: next.enabledFrom?.toISOString() ?? null,
      },
    },
  });

  return getConfigView(storeId);
}

/** Máy khách theo cửa hàng, giữ token giữa các lượt; đổi thông tin kết nối là bỏ máy khách cũ. */
const cachedClients = new Map<string, { key: string; client: MisaClient }>();

type ClientSource = Awaited<ReturnType<typeof readStoreConfig>>;

function clientFor(row: ClientSource): MisaClient | null {
  if (!row.appId || !row.taxCode || !row.username || !row.passwordCipher) return null;
  const password = decryptSecret(row.passwordCipher);
  if (password === null) return null;
  const environment = environmentOf(row.environment);
  const key = [
    environment,
    row.appId,
    row.taxCode,
    row.username,
    row.passwordCipher,
    misaRoot(environment),
  ].join("|");
  const cached = cachedClients.get(row.storeId);
  if (cached?.key === key) return cached.client;
  const client = new MisaClient({
    environment,
    appId: row.appId,
    taxCode: row.taxCode,
    username: row.username,
    password,
  });
  cachedClients.set(row.storeId, { key, client });
  return client;
}

export async function buildClient(storeId: string): Promise<MisaClient | null> {
  return clientFor(await readStoreConfig(storeId));
}

export async function requireClient(storeId: string): Promise<MisaClient> {
  const row = await readStoreConfig(storeId);
  if (!row.appId || !row.taxCode || !row.username || !row.passwordCipher) {
    throw AppError.invalidState("Cửa hàng này chưa cấu hình kết nối hóa đơn điện tử");
  }
  const client = clientFor(row);
  if (!client) {
    throw AppError.invalidState(
      "Không giải mã được mật khẩu đã lưu (JWT_SECRET có thể đã đổi). Hãy nhập lại mật khẩu.",
    );
  }
  return client;
}
