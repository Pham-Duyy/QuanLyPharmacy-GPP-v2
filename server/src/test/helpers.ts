import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app.js";
import { prisma } from "../db/prisma.js";
import { hashPassword } from "../lib/password.js";
import { PERMISSIONS, ROLES } from "../config/permissions.js";

export const app: Express = createApp();
export const api = () => request(app);

/** Xóa sạch dữ liệu giữa các test, giữ nguyên cấu trúc bảng và migration. */
export async function truncateAll(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;

  const list = tables.map((row) => `"${row.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export const TEST_PASSWORD = "MatKhau@12345";

export type Fixture = {
  storeId: string;
  otherStoreId: string;
  adminId: string;
  pharmacistId: string;
  salesId: string;
};

/**
 * Dữ liệu tối thiểu cho test: hai cửa hàng, đủ permission và vai trò,
 * một tài khoản admin bao toàn chuỗi và một dược sĩ chỉ thuộc cửa hàng 1.
 * Có hai cửa hàng để kiểm tra được việc không lộ dữ liệu chéo cửa hàng.
 */
export async function seedFixture(): Promise<Fixture> {
  const [store, otherStore] = await Promise.all([
    prisma.store.create({ data: { code: "NT01", name: "Nhà thuốc kiểm thử 1" } }),
    prisma.store.create({ data: { code: "NT02", name: "Nhà thuốc kiểm thử 2" } }),
  ]);

  await prisma.permission.createMany({ data: PERMISSIONS });

  const roleByCode = new Map<string, string>();
  for (const role of ROLES) {
    const saved = await prisma.role.create({ data: { code: role.code, name: role.name } });
    roleByCode.set(role.code, saved.id);
    await prisma.rolePermission.createMany({
      data: role.permissions.map((permissionCode) => ({ roleId: saved.id, permissionCode })),
    });
  }

  const passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await prisma.user.create({
    data: { username: "admin", passwordHash, fullName: "Quản trị", defaultStoreId: store.id },
  });
  await prisma.userRole.create({
    data: { userId: admin.id, roleId: roleByCode.get("admin")!, storeId: null },
  });

  const pharmacist = await prisma.user.create({
    data: { username: "duocsi", passwordHash, fullName: "Dược sĩ", defaultStoreId: store.id },
  });
  await prisma.userRole.create({
    data: { userId: pharmacist.id, roleId: roleByCode.get("pharmacist")!, storeId: store.id },
  });

  const sales = await prisma.user.create({
    data: {
      username: "banhang",
      passwordHash,
      fullName: "Nhân viên bán hàng",
      defaultStoreId: store.id,
    },
  });
  await prisma.userRole.create({
    data: { userId: sales.id, roleId: roleByCode.get("sales_staff")!, storeId: store.id },
  });

  return {
    storeId: store.id,
    otherStoreId: otherStore.id,
    adminId: admin.id,
    pharmacistId: pharmacist.id,
    salesId: sales.id,
  };
}

/** Đăng nhập và trả về access token cùng cookie refresh. */
export async function login(username: string): Promise<{ token: string; cookie: string }> {
  const response = await api()
    .post("/api/v1/auth/login")
    .send({ username, password: TEST_PASSWORD })
    .expect(200);

  const setCookie = response.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? (setCookie[0] ?? "") : String(setCookie ?? "");
  return { token: response.body.data.accessToken as string, cookie };
}

/** Header quen dùng: token và phạm vi cửa hàng. */
export function authHeaders(token: string, storeId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(storeId ? { "X-Store-Id": storeId } : {}),
  };
}
