import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { baseUrlOverride, NdsClient, resolveBaseUrl, type NdsEnvironment } from "./nds-client.js";
import { decryptSecret, encryptSecret } from "./nds-crypto.js";

/** Bảng cấu hình chỉ có một dòng; khóa chính là hằng TRUE. */
const ROW = { id: true };

export type NdsConfigView = {
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
  lastMasterSyncAt: string | null;
  updatedAt: string;
};

export async function readConfigRow() {
  const existing = await prisma.nationalSyncConfig.findUnique({ where: ROW });
  // Migration đã chèn sẵn dòng này; tạo bù để CSDL test chưa seed vẫn chạy.
  return existing ?? (await prisma.nationalSyncConfig.create({ data: { id: true } }));
}

function environmentOf(value: string): NdsEnvironment {
  return value === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

export async function getConfigView(): Promise<NdsConfigView> {
  const row = await readConfigRow();
  const environment = environmentOf(row.environment);
  return {
    enabled: row.enabled,
    environment,
    baseUrl: resolveBaseUrl(environment),
    baseUrlOverridden: baseUrlOverride() !== null,
    username: row.username,
    hasPassword: Boolean(row.passwordCipher),
    practiceLicenseCode: row.practiceLicenseCode,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    lastMasterSyncAt: row.lastMasterSyncAt?.toISOString() ?? null,
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

export async function updateConfig(patch: ConfigPatch, userId: string): Promise<NdsConfigView> {
  const current = await readConfigRow();

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

  await prisma.nationalSyncConfig.update({ where: ROW, data: next });

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "NATIONAL_SYNC_CONFIG_UPDATE",
      resourceType: "national_sync_config",
      resourceId: null,
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

  return getConfigView();
}

/**
 * Máy khách đang dùng, giữ lại giữa các lượt gọi.
 *
 * Token nằm trong máy khách, nên dựng máy khách mới mỗi lần là vứt token đi
 * và đăng nhập lại — một lượt chạy nền gọi cả gửi lẫn hỏi trạng thái sẽ tốn
 * hai lần đăng nhập vô ích, trong khi API này có giới hạn tần suất.
 *
 * Khóa gồm cả bản mã mật khẩu: đổi tài khoản hay đổi mật khẩu là khóa đổi
 * theo, máy khách cũ bị bỏ, không có chuyện dùng nhầm tài khoản cũ.
 */
let cachedClient: { key: string; client: NdsClient } | null = null;

/**
 * Dựng máy khách từ cấu hình đã lưu. Trả `null` khi chưa đủ thông tin để
 * gọi API — bên gọi tự quyết định báo lỗi hay bỏ qua lượt chạy.
 */
export async function buildClient(): Promise<NdsClient | null> {
  const row = await readConfigRow();
  if (!row.username || !row.passwordCipher) return null;

  const password = decryptSecret(row.passwordCipher);
  if (password === null) return null;

  const environment = environmentOf(row.environment);
  const key = [environment, row.username, row.passwordCipher, resolveBaseUrl(environment)].join("|");
  if (cachedClient?.key === key) return cachedClient.client;

  const client = new NdsClient({ environment, username: row.username, password });
  cachedClient = { key, client };
  return client;
}

/** Như `buildClient` nhưng báo lỗi rõ ràng cho người dùng cuối. */
export async function requireClient(): Promise<NdsClient> {
  const row = await readConfigRow();
  if (!row.username || !row.passwordCipher) {
    throw AppError.invalidState("Chưa cấu hình tài khoản liên thông CSDL Dược");
  }
  const client = await buildClient();
  if (!client) {
    throw AppError.invalidState(
      "Không giải mã được mật khẩu đã lưu (JWT_SECRET có thể đã đổi). Hãy nhập lại mật khẩu.",
    );
  }
  return client;
}
