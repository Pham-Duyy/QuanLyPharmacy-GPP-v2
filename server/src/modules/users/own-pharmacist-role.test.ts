import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

/** Chủ nhà thuốc kiêm dược sĩ (Phase 7, D29). */

let f: Fixture;
let token: string;

beforeEach(async () => {
  await truncateAll();
  f = await seedFixture({ sellingAdmin: false });
  token = (await login("admin")).token;
});
afterAll(() => prisma.$disconnect());

const permsAt = (me: { stores: Array<{ id: string; permissions: string[] }> }) =>
  me.stores.find((store) => store.id === f.storeId)?.permissions ?? [];

const addSelf = (body: Record<string, unknown>, as = token) =>
  api().post("/api/v1/users/me/pharmacist-role").set(authHeaders(as)).send(body);

const body = (extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId,
  qualificationReference: "Bằng Dược sĩ đại học số 123, ĐH Dược Hà Nội",
  practiceCertificateNumber: "CCHN-0001/HCM",
  ...extra,
});

describe("Quản lý tự thêm vai trò Dược sĩ cho mình", () => {
  it("trước đó không bán được, sau khi thêm thì có quyền bán tại cửa hàng đó", async () => {
    const before = await api()
      .get("/api/v1/auth/me")
      .set(authHeaders(token, f.storeId))
      .expect(200);
    expect(permsAt(before.body.data)).not.toContain("invoice.create");

    const response = await addSelf(body()).expect(201);
    expect(response.body.data.practiceCertificateNumber).toBe("CCHN-0001/HCM");

    const after = await api().get("/api/v1/auth/me").set(authHeaders(token, f.storeId)).expect(200);
    expect(permsAt(after.body.data)).toContain("invoice.create");

    const audit = await prisma.auditLog.findFirst({ where: { action: "USER_SELF_PHARMACIST" } });
    expect(audit?.actorId).toBe(f.adminId);
    expect(audit?.storeId).toBe(f.storeId);
  });

  it("vai trò quản lý cũ vẫn giữ nguyên", async () => {
    await addSelf(body()).expect(201);
    const roles = await prisma.userRole.findMany({
      where: { userId: f.adminId },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.code).sort()).toEqual(["admin", "pharmacist"]);
  });

  it("bắt buộc có số chứng chỉ hành nghề và căn cứ bằng cấp", async () => {
    await addSelf(body({ practiceCertificateNumber: undefined })).expect(422);
    await addSelf(body({ qualificationReference: "" })).expect(422);
  });

  it("không thêm hai lần", async () => {
    await addSelf(body()).expect(201);
    const again = await addSelf(body()).expect(409);
    expect(again.body.error.message).toContain("đã có vai trò Dược sĩ");
  });

  it("dược sĩ thường không dùng được lối này", async () => {
    const pharmacist = (await login("duocsi")).token;
    await addSelf(body(), pharmacist).expect(403);
  });
});
