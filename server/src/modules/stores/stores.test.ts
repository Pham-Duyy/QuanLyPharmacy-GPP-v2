import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let salesToken: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function h(token = adminToken) {
  return authHeaders(token, fixture.storeId);
}

describe("Mở cửa hàng mới", () => {
  it("tạo được, thấy ngay trong danh sách", async () => {
    const response = await api()
      .post("/api/v1/stores")
      .set(h())
      .send({
        code: "nt03",
        name: "Nhà thuốc chi nhánh 3",
        address: "12 Lê Lợi",
        phone: "0281234567",
      })
      .expect(201);

    expect(response.body.data.code).toBe("NT03");

    const list = await api().get("/api/v1/stores").set(h()).expect(200);
    expect(list.body.data.items.some((item: { code: string }) => item.code === "NT03")).toBe(true);
  });

  it("quản lý một cửa hàng mở cửa hàng mới: được gán quản lý tại đó, thấy và vào được ngay", async () => {
    await useTestRole(fixture.salesId, "admin", fixture.storeId);
    const manager = (await login("banhang")).token;

    const created = await api()
      .post("/api/v1/stores")
      .set(h(manager))
      .send({ code: "nt05", name: "Nhà thuốc chi nhánh 5" })
      .expect(201);
    const id = created.body.data.id as string;

    const list = await api().get("/api/v1/stores").set(h(manager)).expect(200);
    expect(list.body.data.items.map((item: { code: string }) => item.code)).toContain("NT05");
    const detail = await api()
      .get(`/api/v1/stores/${id}`)
      .set(authHeaders(manager, id))
      .expect(200);
    expect(detail.body.data.permissions).toContain("store.manage");

    const roles = await prisma.userRole.findMany({
      where: { userId: fixture.salesId, storeId: id },
      include: { role: true },
    });
    expect(roles.map((item) => item.role.code)).toEqual(["admin"]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "STORE_CREATE", resourceId: id },
    });
    expect(audit.after).toMatchObject({ creatorAssignedRoles: ["admin"] });
  });

  it("admin toàn chuỗi mở cửa hàng: không gán thêm vai trò (vốn đã thấy mọi cửa hàng)", async () => {
    const created = await api()
      .post("/api/v1/stores")
      .set(h())
      .send({ code: "nt06", name: "Nhà thuốc chi nhánh 6" })
      .expect(201);
    expect(
      await prisma.userRole.count({ where: { storeId: created.body.data.id as string } }),
    ).toBe(0);
  });

  it("chặn trùng mã cửa hàng", async () => {
    const response = await api()
      .post("/api/v1/stores")
      .set(h())
      .send({ code: "NT01", name: "Trùng mã" })
      .expect(409);
    expect(response.body.error.code).toBe("DUPLICATE");
  });

  it("nhân viên bán hàng không có quyền mở cửa hàng", async () => {
    const response = await api()
      .post("/api/v1/stores")
      .set(h(salesToken))
      .send({ code: "NT04", name: "Không được phép" })
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Sửa thông tin cửa hàng", () => {
  it("sửa được theo đúng version", async () => {
    const detail = await api().get(`/api/v1/stores/${fixture.storeId}`).set(h()).expect(200);

    const response = await api()
      .patch(`/api/v1/stores/${fixture.storeId}`)
      .set(h())
      .send({ version: detail.body.data.version, address: "Địa chỉ mới", phone: "0909999999" })
      .expect(200);

    expect(response.body.data).toMatchObject({ address: "Địa chỉ mới", phone: "0909999999" });
  });

  it("chặn khi version không khớp", async () => {
    const detail = await api().get(`/api/v1/stores/${fixture.storeId}`).set(h()).expect(200);

    const response = await api()
      .patch(`/api/v1/stores/${fixture.storeId}`)
      .set(h())
      .send({ version: detail.body.data.version + 1, name: "Sửa nhầm version" })
      .expect(409);
    expect(response.body.error.code).toBe("VERSION_CONFLICT");
  });
});

describe("Ngừng hoạt động cửa hàng", () => {
  it("ngừng được, chặn luôn nghiệp vụ mới tại cửa hàng đó", async () => {
    await api().post(`/api/v1/stores/${fixture.storeId}/deactivate`).set(h()).expect(200);

    const response = await api()
      .get("/api/v1/products")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(403);
    expect(response.body.error.code).toBe("STORE_FORBIDDEN");
  });

  it("cửa hàng đã ngừng không còn hiện trong danh sách", async () => {
    await api().post(`/api/v1/stores/${fixture.storeId}/deactivate`).set(h()).expect(200);

    const list = await api().get("/api/v1/stores").set(authHeaders(adminToken)).expect(200);
    expect(list.body.data.items.some((item: { id: string }) => item.id === fixture.storeId)).toBe(
      false,
    );
  });
});
