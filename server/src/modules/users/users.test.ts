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

/** Cookie refresh thô từ response đăng nhập, cùng cách đọc với `login()` ở test/helpers.ts. */
function cookieOf(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  return Array.isArray(setCookie) ? (setCookie[0] ?? "") : String(setCookie ?? "");
}

function h(token = adminToken) {
  return authHeaders(token, fixture.storeId);
}

describe("Tạo tài khoản", () => {
  it("tạo được, trả mật khẩu tạm đúng luật (>=10 ký tự, có chữ và số)", async () => {
    const response = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "duocsi2", fullName: "Dược sĩ Hai", phone: "0900000000" })
      .expect(201);

    expect(response.body.data.username).toBe("duocsi2");
    expect(response.body.data.mustChangePassword).toBe(true);
    const temp = response.body.data.tempPassword as string;
    expect(temp.length).toBeGreaterThanOrEqual(10);
    expect(temp).toMatch(/[a-zA-Z]/);
    expect(temp).toMatch(/[0-9]/);

    // Mật khẩu tạm phải đăng nhập được thật.
    const loginResponse = await api()
      .post("/api/v1/auth/login")
      .send({ username: "duocsi2", password: temp })
      .expect(200);
    expect(loginResponse.body.data.accessToken).toBeTruthy();
  });

  it("chặn trùng tên đăng nhập", async () => {
    const response = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "admin", fullName: "Trùng tên" })
      .expect(409);
    expect(response.body.error.code).toBe("DUPLICATE");
  });

  it("nhân viên bán hàng không có quyền tạo tài khoản", async () => {
    const response = await api()
      .post("/api/v1/users")
      .set(h(salesToken))
      .send({ username: "abc", fullName: "Ai đó" })
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Đổi vai trò", () => {
  it("gán vai trò mới, thu hồi phiên đăng nhập cũ của người đó", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "khonew", fullName: "Nhân viên kho" })
      .expect(201);
    const userId = created.body.data.id as string;
    const tempPassword = created.body.data.tempPassword as string;

    const firstLogin = await api()
      .post("/api/v1/auth/login")
      .send({ username: "khonew", password: tempPassword })
      .expect(200);

    await api()
      .put(`/api/v1/users/${userId}/roles`)
      .set(h())
      .send([{ roleCode: "warehouse_staff", storeId: fixture.storeId }])
      .expect(200);

    // Refresh cookie cũ đã bị thu hồi — không cấp lại được access token mới.
    const refreshAttempt = await api()
      .post("/api/v1/auth/refresh")
      .set("Cookie", cookieOf(firstLogin))
      .expect(401);
    expect(refreshAttempt.body.error.code).toBe("UNAUTHENTICATED");

    const detail = await api().get(`/api/v1/users/${userId}`).set(h()).expect(200);
    expect(detail.body.data.roles).toEqual([
      {
        roleCode: "warehouse_staff",
        roleName: expect.any(String),
        additionalPermissions: [],
        qualificationReference: null,
        responsibleProfessional: false,
        storeId: fixture.storeId,
        storeName: expect.any(String),
      },
    ]);
  });

  it("không tự đổi vai trò của chính mình", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
    const response = await api()
      .put(`/api/v1/users/${admin.id}/roles`)
      .set(h())
      .send([{ roleCode: "pharmacist", storeId: fixture.storeId }])
      .expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("gỡ được vai trò admin nếu còn admin khác, không gỡ được nếu là người cuối", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
    const otherAdmin = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "admin2", fullName: "Quản trị hai" })
      .expect(201);
    await api()
      .put(`/api/v1/users/${otherAdmin.body.data.id}/roles`)
      .set(h())
      .send([{ roleCode: "admin", storeId: null }])
      .expect(200);

    // Còn 2 admin: gỡ vai trò admin của một trong hai (không phải chính actor) phải được phép.
    await api()
      .put(`/api/v1/users/${otherAdmin.body.data.id}/roles`)
      .set(h())
      .send([{ roleCode: "warehouse_staff", storeId: fixture.storeId }])
      .expect(200);

    // Chỉ còn đúng một admin (tài khoản seed). Luật "không tự đổi vai trò
    // chính mình" khiến người này không bao giờ tự gỡ được — nên để kiểm
    // tra đúng nhánh "admin cuối cùng", gọi thẳng service với một actorId
    // khác (mô phỏng trường hợp permission user.manage được cấp cho vai
    // trò khác trong tương lai, vẫn phải bị chặn).
    const { replaceRoles } = await import("./users.service.js");
    const { AuthContext } = await import("../auth/auth.context.js");
    const actor = new AuthContext({
      userId: otherAdmin.body.data.id,
      username: "khac",
      fullName: "Người quản lý khác",
      sessionId: "test",
      mustChangePassword: false,
      defaultStoreId: null,
      chainPermissions: new Set(["user.manage"]),
      storePermissions: new Map(),
    });
    await expect(
      replaceRoles(admin.id, actor, [
        {
          roleCode: "warehouse_staff",
          storeId: fixture.storeId,
          additionalPermissions: [],
          responsibleProfessional: false,
        },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    const stillAdmin = await prisma.userRole.findFirst({
      where: { userId: admin.id, role: { code: "admin" } },
    });
    expect(stillAdmin).not.toBeNull();
  });

  it("báo lỗi khi roleCode không tồn tại", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "khonew2", fullName: "Nhân viên kho 2" })
      .expect(201);

    const response = await api()
      .put(`/api/v1/users/${created.body.data.id}/roles`)
      .set(h())
      .send([{ roleCode: "khong_ton_tai", storeId: null }])
      .expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Phạm vi người đổi vai trò", () => {
  it("quản lý tại một cửa hàng không giao được vai trò toàn chuỗi hay ở cửa hàng khác", async () => {
    await useTestRole(fixture.salesId, "admin", fixture.storeId);
    const storeManager = (await login("banhang")).token;
    const kho = {
      roleCode: "warehouse_staff",
      additionalPermissions: [],
      responsibleProfessional: false,
    };

    const chain = await api()
      .put(`/api/v1/users/${fixture.pharmacistId}/roles`)
      .set(h(storeManager))
      .send([{ ...kho, storeId: null }])
      .expect(403);
    expect(chain.body.error.message).toMatch(/toàn chuỗi/);

    await api()
      .put(`/api/v1/users/${fixture.pharmacistId}/roles`)
      .set(h(storeManager))
      .send([{ ...kho, storeId: fixture.otherStoreId }])
      .expect(403);
  });

  it("không gỡ được vai trò người khác đang giữ ở phạm vi mình không quản lý", async () => {
    await useTestRole(fixture.salesId, "admin", fixture.storeId);
    const storeManager = (await login("banhang")).token;
    // Admin toàn chuỗi: quản lý NT01 không được thay vai trò của người này.
    await api()
      .put(`/api/v1/users/${fixture.adminId}/roles`)
      .set(h(storeManager))
      .send([{ roleCode: "warehouse_staff", storeId: fixture.storeId }])
      .expect(403);
    expect(
      await prisma.userRole.count({ where: { userId: fixture.adminId, storeId: null } }),
    ).toBeGreaterThan(0);
  });

  it("quản lý cửa hàng vẫn đổi được vai trò trong cửa hàng của mình", async () => {
    await useTestRole(fixture.salesId, "admin", fixture.storeId);
    const storeManager = (await login("banhang")).token;
    await api()
      .put(`/api/v1/users/${fixture.pharmacistId}/roles`)
      .set(h(storeManager))
      .send([{ roleCode: "warehouse_staff", storeId: fixture.storeId }])
      .expect(200);
  });
});

describe("Vô hiệu hóa / kích hoạt lại", () => {
  it("vô hiệu hóa thu hồi phiên, không đăng nhập lại được", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "tam1", fullName: "Tạm thời" })
      .expect(201);
    await api()
      .put(`/api/v1/users/${created.body.data.id}/roles`)
      .set(h())
      .send([{ roleCode: "warehouse_staff", storeId: fixture.storeId }])
      .expect(200);

    const firstLogin = await api()
      .post("/api/v1/auth/login")
      .send({ username: "tam1", password: created.body.data.tempPassword })
      .expect(200);

    await api().post(`/api/v1/users/${created.body.data.id}/deactivate`).set(h()).expect(200);

    await api()
      .post("/api/v1/auth/login")
      .send({ username: "tam1", password: created.body.data.tempPassword })
      .expect(401);

    const refreshAttempt = await api()
      .post("/api/v1/auth/refresh")
      .set("Cookie", cookieOf(firstLogin))
      .expect(401);
    expect(refreshAttempt.body.error.code).toBe("UNAUTHENTICATED");

    await api().post(`/api/v1/users/${created.body.data.id}/activate`).set(h()).expect(200);
    await api()
      .post("/api/v1/auth/login")
      .send({ username: "tam1", password: created.body.data.tempPassword })
      .expect(200);
  });

  it("không vô hiệu hóa được admin cuối cùng", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
    const response = await api().post(`/api/v1/users/${admin.id}/deactivate`).set(h()).expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Đặt lại mật khẩu", () => {
  it("đặt mật khẩu tạm mới, thu hồi phiên cũ, bắt đổi mật khẩu ở lần sau", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "reset1", fullName: "Cần đặt lại" })
      .expect(201);
    await api()
      .put(`/api/v1/users/${created.body.data.id}/roles`)
      .set(h())
      .send([{ roleCode: "warehouse_staff", storeId: fixture.storeId }])
      .expect(200);

    const oldLogin = await api()
      .post("/api/v1/auth/login")
      .send({ username: "reset1", password: created.body.data.tempPassword })
      .expect(200);

    const reset = await api()
      .post(`/api/v1/users/${created.body.data.id}/reset-password`)
      .set(h())
      .expect(200);
    const newTemp = reset.body.data.tempPassword as string;
    expect(newTemp).not.toBe(created.body.data.tempPassword);

    await api()
      .post("/api/v1/auth/login")
      .send({ username: "reset1", password: created.body.data.tempPassword })
      .expect(401);
    await api()
      .post("/api/v1/auth/login")
      .send({ username: "reset1", password: newTemp })
      .expect(200);

    const refreshAttempt = await api()
      .post("/api/v1/auth/refresh")
      .set("Cookie", cookieOf(oldLogin))
      .expect(401);
    expect(refreshAttempt.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("Sửa thông tin cơ bản", () => {
  it("sửa được họ tên, số điện thoại theo đúng version", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "sua1", fullName: "Tên cũ" })
      .expect(201);

    const response = await api()
      .patch(`/api/v1/users/${created.body.data.id}`)
      .set(h())
      .send({ version: created.body.data.version, fullName: "Tên mới", phone: "0911111111" })
      .expect(200);

    expect(response.body.data).toMatchObject({ fullName: "Tên mới", phone: "0911111111" });
  });

  it("chặn khi version không khớp", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(h())
      .send({ username: "sua2", fullName: "Tên cũ" })
      .expect(201);

    const response = await api()
      .patch(`/api/v1/users/${created.body.data.id}`)
      .set(h())
      .send({ version: created.body.data.version + 1, fullName: "Tên mới" })
      .expect(409);
    expect(response.body.error.code).toBe("VERSION_CONFLICT");
  });
});

describe("Danh sách vai trò", () => {
  it("trả đủ vai trò kèm permission", async () => {
    const response = await api().get("/api/v1/roles").set(h()).expect(200);
    const codes = response.body.data.map((item: { code: string }) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining(["admin", "pharmacist", "warehouse_staff", "auditor"]),
    );
    const admin = response.body.data.find((item: { code: string }) => item.code === "admin");
    expect(admin.permissions).toContain("user.manage");
    // Mô tả quyền lấy từ cấu hình, để giao diện tóm tắt quyền mà không viết cứng.
    expect(admin.permissionDetails).toContainEqual({
      code: "user.manage",
      description: "Quản lý tài khoản, vai trò",
    });
    expect(admin.permissionDetails).toHaveLength(admin.permissions.length);
  });
});

describe("Tạo nhân viên kèm mật khẩu và phân quyền trong một giao dịch", () => {
  const PASSWORD = "Khoi2026dau";

  function newStaff(overrides: Record<string, unknown> = {}) {
    return {
      username: "kho01",
      fullName: "Nhân viên kho",
      password: PASSWORD,
      roles: [{ roleCode: "warehouse_staff", storeId: fixture.storeId }],
      ...overrides,
    };
  }

  it("tạo tài khoản, mật khẩu do người tạo đặt và vai trò cùng lúc; không trả lại mật khẩu", async () => {
    const response = await api().post("/api/v1/users").set(h()).send(newStaff()).expect(201);

    expect(response.body.data.tempPassword).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    expect(response.body.data.mustChangePassword).toBe(true);
    expect(response.body.data.roles).toEqual([
      expect.objectContaining({ roleCode: "warehouse_staff", storeId: fixture.storeId }),
    ]);

    const loginResponse = await api()
      .post("/api/v1/auth/login")
      .send({ username: "kho01", password: PASSWORD })
      .expect(200);
    expect(loginResponse.body.data.accessToken).toBeTruthy();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_CREATE", resourceId: response.body.data.id },
    });
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect(audit.after).toMatchObject({ password: "SET_BY_MANAGER", mustChangePassword: true });
  });

  it("tôn trọng lựa chọn không bắt đổi mật khẩu ở lần đăng nhập đầu", async () => {
    const response = await api()
      .post("/api/v1/users")
      .set(h())
      .send(newStaff({ mustChangePassword: false }))
      .expect(201);
    expect(response.body.data.mustChangePassword).toBe(false);
  });

  it("phân quyền không hợp lệ thì không tạo tài khoản nào", async () => {
    // Dược sĩ thiếu căn cứ chuyên môn: bị chặn ở bước phân quyền.
    const response = await api()
      .post("/api/v1/users")
      .set(h())
      .send(newStaff({ roles: [{ roleCode: "pharmacist", storeId: fixture.storeId }] }))
      .expect(422);
    expect(response.body.error.message).toMatch(/căn cứ/);
    expect(await prisma.user.count({ where: { username: "kho01" } })).toBe(0);
  });

  it("chặn cặp cửa hàng / vai trò bị lặp", async () => {
    const role = { roleCode: "warehouse_staff", storeId: fixture.storeId };
    await api()
      .post("/api/v1/users")
      .set(h())
      .send(newStaff({ roles: [role, role] }))
      .expect(422);
    expect(await prisma.user.count({ where: { username: "kho01" } })).toBe(0);
  });

  it("mật khẩu phải đúng chính sách hiện hành", async () => {
    const response = await api()
      .post("/api/v1/users")
      .set(h())
      .send(newStaff({ password: "chuachuso" }))
      .expect(422);
    expect(JSON.stringify(response.body.error)).toMatch(/ít nhất 10 ký tự|phải có số/);
    expect(await prisma.user.count({ where: { username: "kho01" } })).toBe(0);
  });

  it("báo rõ tên đăng nhập đã tồn tại", async () => {
    const response = await api()
      .post("/api/v1/users")
      .set(h())
      .send(newStaff({ username: "ADMIN" }))
      .expect(409);
    expect(response.body.error.message).toBe("Tên đăng nhập đã tồn tại");
  });

  it("quản lý tại một cửa hàng chỉ giao được vai trò trong cửa hàng đó", async () => {
    await useTestRole(fixture.salesId, "admin", fixture.storeId);
    const storeManager = (await login("banhang")).token;

    const chain = await api()
      .post("/api/v1/users")
      .set(h(storeManager))
      .send(newStaff({ roles: [{ roleCode: "auditor", storeId: null }] }))
      .expect(403);
    expect(chain.body.error.message).toMatch(/toàn chuỗi/);

    await api()
      .post("/api/v1/users")
      .set(h(storeManager))
      .send(newStaff({ roles: [{ roleCode: "warehouse_staff", storeId: fixture.otherStoreId }] }))
      .expect(403);
    expect(await prisma.user.count({ where: { username: "kho01" } })).toBe(0);

    await api().post("/api/v1/users").set(h(storeManager)).send(newStaff()).expect(201);
  });
});

describe("Danh sách và tìm kiếm người dùng", () => {
  it("tìm theo tên hoặc username", async () => {
    const response = await api()
      .get("/api/v1/users")
      .query({ search: "duocsi" })
      .set(h())
      .expect(200);
    expect(
      response.body.data.some((item: { username: string }) => item.username === "duocsi"),
    ).toBe(true);
  });
});
