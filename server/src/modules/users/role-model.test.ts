import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { ROLES, ADDITIONAL_PERMISSIONS } from "../../config/permissions.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";
import { loadAuthContext } from "../auth/auth.context.js";
import { replaceRolesSchema } from "./users.schema.js";
import { replaceRoles } from "./users.service.js";
import { readFileSync } from "node:fs";
import pg from "pg";

let f: Fixture;
let token: string;
const assignment = (extra: Record<string, unknown> = {}) => ({
  roleCode: "pharmacist",
  storeId: f.storeId,
  qualificationReference: "Đã đối chiếu bằng dược, hồ sơ TEST-01",
  ...extra,
});
const put = (rows: unknown[], id = f.salesId) =>
  api().put(`/api/v1/users/${id}/roles`).set(authHeaders(token)).send(rows);

beforeEach(async () => {
  await truncateAll();
  f = await seedFixture({ sellingAdmin: false });
  token = (await login("admin")).token;
});
afterAll(() => prisma.$disconnect());

describe("Bốn vai trò và phân công theo cửa hàng", () => {
  it("migration gỡ sales_staff, giữ tài khoản và audit, không tự nâng sang dược sĩ", async () => {
    const legacy = await prisma.role.create({ data: { code: "sales_staff", name: "Vai trò cũ" } });
    await prisma.userRole.deleteMany({ where: { userId: f.salesId } });
    await prisma.userRole.create({
      data: { userId: f.salesId, roleId: legacy.id, storeId: f.storeId },
    });
    await prisma.rolePermission.create({
      data: { roleId: legacy.id, permissionCode: "invoice.create" },
    });
    const old = await login("banhang");
    const migration = readFileSync(
      new URL(
        "../../../prisma/migrations/20260930120000_four_roles_scoped_approvals/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    // Schema đã được globalSetup migrate; chạy đúng phần chuyển đổi dữ liệu
    // trên tài khoản cũ được dựng lại, không viết bản mô phỏng thuật toán.
    const client = new pg.Client({ connectionString: process.env["DATABASE_URL_TEST"] });
    await client.connect();
    try {
      await client.query("BEGIN;\n" + migration.slice(migration.indexOf("INSERT INTO audit_logs")));
    } finally {
      await client.end();
    }
    expect(await prisma.user.findUnique({ where: { id: f.salesId } })).not.toBeNull();
    expect(await prisma.userRole.count({ where: { userId: f.salesId } })).toBe(0);
    expect(await prisma.role.findUnique({ where: { code: "sales_staff" } })).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { resourceId: f.salesId, action: "LEGACY_SALES_ROLE_RETIRED" },
      }),
    ).toBe(1);
    await api().get("/api/v1/auth/me").set(authHeaders(old.token)).expect(401);
  });
  it("admin thuần không bán; dược sĩ cơ bản không được các quyền duyệt bổ sung", async () => {
    expect(ROLES.map((r) => r.code).sort()).toEqual([
      "admin",
      "auditor",
      "pharmacist",
      "warehouse_staff",
    ]);
    const manager = await loadAuthContext(f.adminId, "test");
    expect(manager!.can("invoice.create")).toBe(false);
    const pharmacist = await loadAuthContext(f.salesId, "test");
    expect(pharmacist!.can("invoice.create")).toBe(true);
    for (const code of ADDITIONAL_PERMISSIONS) expect(pharmacist!.can(code), code).toBe(false);
    await api().post("/api/v1/invoices").set(authHeaders(token, f.storeId)).send({}).expect(403);
  });

  it("từ chối vai trò cũ, thiếu căn cứ chuyên môn, quyền tùy ý và quyền toàn chuỗi", async () => {
    await put([{ roleCode: "sales_staff", storeId: f.storeId }]).expect(422);
    await put([assignment({ qualificationReference: null })]).expect(422);
    await put([assignment({ additionalPermissions: ["user.manage"] })]).expect(422);
    await put([assignment({ storeId: null, additionalPermissions: ["invoice.void"] })]).expect(422);
    await put([
      {
        roleCode: "warehouse_staff",
        storeId: f.storeId,
        additionalPermissions: ["stock.adjust.approve"],
      },
    ]).expect(422);
  });

  it("quyền bổ sung chỉ tại cửa hàng được cấp; bỏ cấp quyền thu hồi phiên và có audit trước sau", async () => {
    const oldLogin = await login("banhang");
    await put([
      assignment({ additionalPermissions: ["invoice.void"] }),
      assignment({ storeId: f.otherStoreId }),
    ]).expect(200);
    await api().get("/api/v1/auth/me").set(authHeaders(oldLogin.token)).expect(401);
    let auth = (await loadAuthContext(f.salesId, "test"))!;
    auth.storeId = f.storeId;
    expect(auth.can("invoice.void")).toBe(true);
    auth.storeId = f.otherStoreId;
    expect(auth.can("invoice.void")).toBe(false);
    const meToken = (await login("banhang")).token;
    const me = await api().get("/api/v1/auth/me").set(authHeaders(meToken)).expect(200);
    expect(
      me.body.data.stores.find((s: { id: string }) => s.id === f.storeId).permissions,
    ).toContain("invoice.void");
    await put([assignment()]).expect(200);
    auth = (await loadAuthContext(f.salesId, "test"))!;
    auth.storeId = f.storeId;
    expect(auth.can("invoice.void")).toBe(false);
    const logs = await prisma.auditLog.findMany({
      where: { resourceId: f.salesId, action: "USER_ROLES_REPLACE" },
    });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.before && l.after && l.actorId === f.adminId)).toBe(true);
  });

  it("không tự nâng quyền hoặc để tài khoản thiếu user.manage gán quyền", async () => {
    await put([{ roleCode: "admin" }], f.adminId).expect(422);
    const pharmacist = (await login("banhang")).token;
    await api()
      .put(`/api/v1/users/${f.pharmacistId}/roles`)
      .set(authHeaders(pharmacist))
      .send([assignment()])
      .expect(403);
  });

  it("phụ trách cần chứng chỉ và cửa hàng cụ thể, chức danh không tự cấp quyền", async () => {
    await put([assignment({ responsibleProfessional: true })]).expect(422);
    await prisma.user.update({
      where: { id: f.salesId },
      data: { practiceCertificateNumber: "TEST-CCHN" },
    });
    await put([assignment({ responsibleProfessional: true, storeId: null })]).expect(422);
    await put([assignment({ responsibleProfessional: true })]).expect(200);
    const auth = (await loadAuthContext(f.salesId, "test"))!;
    expect(auth.can("prescription.verify")).toBe(false);
    await api().post(`/api/v1/users/${f.salesId}/deactivate`).set(authHeaders(token)).expect(422);
    await api()
      .patch(`/api/v1/users/${f.salesId}`)
      .set(authHeaders(token))
      .send({ practiceCertificateNumber: "", version: 1 })
      .expect(422);
    await put([assignment()]).expect(200);
    await api().post(`/api/v1/users/${f.salesId}/deactivate`).set(authHeaders(token)).expect(200);
  });

  it("hai quản lý phân công đồng thời chỉ một người được phụ trách một cửa hàng", async () => {
    await prisma.user.updateMany({
      where: { id: { in: [f.salesId, f.pharmacistId] } },
      data: { practiceCertificateNumber: "TEST-CCHN" },
    });
    const results = await Promise.all([
      put([assignment({ responsibleProfessional: true })]),
      put([assignment({ responsibleProfessional: true })], f.pharmacistId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(
      await prisma.userRole.count({ where: { storeId: f.storeId, responsibleProfessional: true } }),
    ).toBe(1);
  });

  it("gỡ vai trò xóa luôn quyền bổ sung và phân công; giữ tài khoản và audit", async () => {
    await prisma.user.update({
      where: { id: f.salesId },
      data: { practiceCertificateNumber: "TEST-CCHN" },
    });
    await put([
      assignment({ responsibleProfessional: true, additionalPermissions: ["prescription.verify"] }),
    ]).expect(200);
    await put([{ roleCode: "warehouse_staff", storeId: f.storeId }]).expect(200);
    const auth = (await loadAuthContext(f.salesId, "test"))!;
    expect(auth.can("prescription.verify")).toBe(false);
    expect(auth.can("invoice.create")).toBe(false);
    expect(
      await prisma.userRole.count({ where: { userId: f.salesId, responsibleProfessional: true } }),
    ).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: f.salesId } })).not.toBeNull();
  });

  it("quản lý kiêm dược sĩ mới được bán; không cấp quyền phê duyệt ngoài danh sách", async () => {
    await replaceRoles(
      f.salesId,
      f.adminId,
      replaceRolesSchema.parse([{ roleCode: "admin", storeId: f.storeId }, assignment()]),
    );
    const auth = (await loadAuthContext(f.salesId, "test"))!;
    auth.storeId = f.storeId;
    expect(auth.can("invoice.create")).toBe(true);
    auth.storeId = f.otherStoreId;
    expect(auth.can("invoice.create")).toBe(false);
  });
});
