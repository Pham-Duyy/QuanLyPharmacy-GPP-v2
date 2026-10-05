import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { baseUrlOverride, NdsClient, resolveBaseUrl, type NdsEnvironment } from "./nds-client.js";
import { decryptSecret, encryptSecret } from "./nds-crypto.js";

/**
 * Cấu hình liên thông theo từng cửa hàng: mỗi cơ sở bán lẻ được cấp một tài
 * khoản riêng (Công văn 934/TTYQG). Phần dùng chung toàn chuỗi (mốc đồng bộ
 * danh mục) nằm ở bảng `national_sync_config`.
 */

export type NdsConfigView = {
  storeId: string;
  enabled: boolean;
  environment: NdsEnvironment;
  /** Địa chỉ API thực sự đang gọi, đã tính cả biến môi trường ghi đè. */
  baseUrl: string;
  /** True khi đang trỏ sang địa chỉ khác địa chỉ chính thức (máy chủ mô phỏng). */
  baseUrlOverridden: boolean;
  username: string | null;
  /** Không bao giờ trả mật khẩu ra ngoài, chỉ cho biết đã lưu hay chưa. */
  hasPassword: boolean;
  practiceLicenseCode: string | null;
  startDate: string | null;
  /** Mốc đồng bộ danh mục thuốc quốc gia, dùng chung toàn chuỗi. */
  lastMasterSyncAt: string | null;
  updatedAt: string;
};

export type StoreConfigRow = Awaited<ReturnType<typeof readStoreConfig>>;

/** Cửa hàng chưa từng cấu hình thì trả cấu hình mặc định (tắt), chưa ghi CSDL. */
export async function readStoreConfig(storeId: string) {
  const existing = await prisma.nationalSyncStoreConfig.findUnique({ where: { storeId } });
  return (
    existing ?? {
      storeId,
      enabled: false,
      environment: "SANDBOX",
      username: null,
      passwordCipher: null,
      practiceLicenseCode: null,
      startDate: null,
      updatedAt: new Date(0),
      updatedBy: null,
    }
  );
}

/** Các cửa hàng đang bật liên thông. */
export async function enabledStoreConfigs() {
  return prisma.nationalSyncStoreConfig.findMany({ where: { enabled: true } });
}

export async function readChainConfig() {
  const existing = await prisma.nationalSyncConfig.findUnique({ where: { id: true } });
  // Migration đã chèn sẵn dòng này; tạo bù để CSDL test chưa seed vẫn chạy.
  return existing ?? (await prisma.nationalSyncConfig.create({ data: { id: true } }));
}

function environmentOf(value: string): NdsEnvironment {
  return value === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

export async function getConfigView(storeId: string): Promise<NdsConfigView> {
  const [row, chain] = await Promise.all([readStoreConfig(storeId), readChainConfig()]);
  const environment = environmentOf(row.environment);
  return {
    storeId,
    enabled: row.enabled,
    environment,
    baseUrl: resolveBaseUrl(environment),
    baseUrlOverridden: baseUrlOverride() !== null,
    username: row.username,
    hasPassword: Boolean(row.passwordCipher),
    practiceLicenseCode: row.practiceLicenseCode,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    lastMasterSyncAt: chain.lastMasterSyncAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ConfigPatch = {
  enabled?: boolean;
  environment?: NdsEnvironment;
  username?: string | null;
  password?: string | null;
  practiceLicenseCode?: string | null;
  startDate?: string | null;
};

export async function updateConfig(
  storeId: string,
  patch: ConfigPatch,
  userId: string,
): Promise<NdsConfigView> {
  const current = await readStoreConfig(storeId);

  const next = {
    enabled: patch.enabled ?? current.enabled,
    environment: patch.environment ?? current.environment,
    username: patch.username === undefined ? current.username : patch.username,
    practiceLicenseCode:
      patch.practiceLicenseCode === undefined
        ? current.practiceLicenseCode
        : patch.practiceLicenseCode,
    startDate:
      patch.startDate === undefined
        ? current.startDate
        : patch.startDate === null
          ? null
          : new Date(`${patch.startDate}T00:00:00.000Z`),
    // `undefined` giữ nguyên mật khẩu cũ, `null` xóa hẳn, chuỗi thì đặt mới.
    passwordCipher:
      patch.password === undefined
        ? current.passwordCipher
        : patch.password === null || patch.password === ""
          ? null
          : encryptSecret(patch.password),
    updatedBy: userId,
  };

  // Bật liên thông mà thiếu tài khoản thì bộ chạy nền sẽ lỗi vòng lặp: chặn ngay.
  if (next.enabled && (!next.username || !next.passwordCipher)) {
    throw AppError.validation("Phải nhập tài khoản và mật khẩu liên thông trước khi bật", [
      { field: "enabled", message: "Thiếu tài khoản hoặc mật khẩu" },
    ]);
  }

  // Mỗi cơ sở một tài khoản: không cho hai cửa hàng dùng chung tài khoản.
  if (next.username) {
    const other = await prisma.nationalSyncStoreConfig.findFirst({
      where: {
        username: next.username,
        environment: next.environment,
        storeId: { not: storeId },
      },
      include: { store: { select: { code: true } } },
    });
    if (other) {
      throw AppError.validation(
        `Tài khoản liên thông này đang dùng cho cửa hàng ${other.store.code}. Mỗi cơ sở dùng tài khoản riêng do cơ sở đó đăng ký.`,
        [{ field: "username", message: "Tài khoản đã gắn với cửa hàng khác" }],
      );
    }
  }

  await prisma.nationalSyncStoreConfig.upsert({
    where: { storeId },
    create: { storeId, ...next },
    update: next,
  });

  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: userId,
      action: "NATIONAL_SYNC_CONFIG_UPDATE",
      resourceType: "national_sync_store_config",
      resourceId: storeId,
      // Không ghi mật khẩu vào nhật ký, chỉ ghi việc có đổi hay không.
      after: {
        enabled: next.enabled,
        environment: next.environment,
        username: next.username,
        passwordChanged: patch.password !== undefined,
        practiceLicenseCode: next.practiceLicenseCode,
        startDate: next.startDate ? next.startDate.toISOString().slice(0, 10) : null,
      },
    },
  });

  return getConfigView(storeId);
}

/**
 * Máy khách đang dùng của từng cửa hàng, giữ lại giữa các lượt gọi.
 *
 * Token nằm trong máy khách, nên dựng máy khách mới mỗi lần là vứt token đi
 * và đăng nhập lại — một lượt chạy nền gọi cả gửi lẫn hỏi trạng thái sẽ tốn
 * hai lần đăng nhập vô ích, trong khi API này có giới hạn tần suất.
 *
 * Khóa gồm cả bản mã mật khẩu: đổi tài khoản hay đổi mật khẩu là khóa đổi
 * theo, máy khách cũ bị bỏ, không có chuyện dùng nhầm tài khoản cũ.
 */
const cachedClients = new Map<string, { key: string; client: NdsClient }>();

type ClientSource = Pick<StoreConfigRow, "storeId" | "environment" | "username" | "passwordCipher">;

function clientFor(row: ClientSource): NdsClient | null {
  if (!row.username || !row.passwordCipher) return null;
  const password = decryptSecret(row.passwordCipher);
  if (password === null) return null;

  const environment = environmentOf(row.environment);
  const key = [environment, row.username, row.passwordCipher, resolveBaseUrl(environment)].join(
    "|",
  );
  const cached = cachedClients.get(row.storeId);
  if (cached?.key === key) return cached.client;

  const client = new NdsClient({ environment, username: row.username, password });
  cachedClients.set(row.storeId, { key, client });
  return client;
}

/**
 * Dựng máy khách từ cấu hình của cửa hàng. Trả `null` khi chưa đủ thông tin
 * để gọi API — bên gọi tự quyết định báo lỗi hay bỏ qua lượt chạy.
 */
export async function buildClient(storeId: string): Promise<NdsClient | null> {
  return clientFor(await readStoreConfig(storeId));
}

/** Như `buildClient` nhưng báo lỗi rõ ràng cho người dùng cuối. */
export async function requireClient(storeId: string): Promise<NdsClient> {
  const row = await readStoreConfig(storeId);
  if (!row.username || !row.passwordCipher) {
    throw AppError.invalidState("Cửa hàng này chưa cấu hình tài khoản liên thông CSDL Dược");
  }
  const client = clientFor(row);
  if (!client) {
    throw AppError.invalidState(
      "Không giải mã được mật khẩu đã lưu (JWT_SECRET có thể đã đổi). Hãy nhập lại mật khẩu.",
    );
  }
  return client;
}
