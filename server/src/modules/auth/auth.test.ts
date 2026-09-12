import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  TEST_PASSWORD,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Đăng nhập", () => {
  it("từ chối mật khẩu sai, không nói rõ tài khoản có tồn tại hay không", async () => {
    const sai = await api()
      .post("/api/v1/auth/login")
      .send({ username: "admin", password: "sai-mat-khau" })
      .expect(401);

    const khongCo = await api()
      .post("/api/v1/auth/login")
      .send({ username: "khong-ton-tai", password: "sai-mat-khau" })
      .expect(401);

    expect(sai.body.error.code).toBe("UNAUTHENTICATED");
    expect(sai.body.error.message).toBe(khongCo.body.error.message);
  });

  it("đăng nhập đúng trả access token và đặt refresh token trong cookie HttpOnly", async () => {
    const response = await api()
      .post("/api/v1/auth/login")
      .send({ username: "admin", password: TEST_PASSWORD })
      .expect(200);

    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.body.data.expiresInSeconds).toBe(900);

    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("gpp_refresh=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("chặn request thiếu token", async () => {
    const response = await api().get("/api/v1/auth/me").expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("trả về cửa hàng vào được và quyền hiệu lực tại từng nơi", async () => {
    const { token } = await login("duocsi");
    const response = await api().get("/api/v1/auth/me").set(authHeaders(token)).expect(200);

    expect(response.body.data.user.username).toBe("duocsi");
    expect(response.body.data.chainPermissions).toEqual([]);
    expect(response.body.data.stores).toHaveLength(1);
    expect(response.body.data.stores[0].permissions).toContain("sale.prescription_drug");
  });
});

describe("Phiên đăng nhập", () => {
  it("xoay vòng refresh token mỗi lần làm mới", async () => {
    const { cookie } = await login("admin");

    const first = await api().post("/api/v1/auth/refresh").set("Cookie", cookie).expect(200);
    expect(first.body.data.accessToken).toBeTruthy();

    const sessions = await prisma.refreshSession.findMany({ orderBy: { issuedAt: "asc" } });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.revokedReason).toBe("ROTATED");
    expect(sessions[1]?.revokedAt).toBeNull();
  });

  it("dùng lại refresh token cũ thì thu hồi cả chuỗi phiên", async () => {
    const { cookie } = await login("admin");
    const rotated = await api().post("/api/v1/auth/refresh").set("Cookie", cookie).expect(200);
    const newCookie = String(rotated.headers["set-cookie"]);

    // Token cũ bị gửi lại: coi như bị đánh cắp.
    const reused = await api().post("/api/v1/auth/refresh").set("Cookie", cookie).expect(401);
    expect(reused.body.error.code).toBe("UNAUTHENTICATED");

    // Token mới cũng hết hiệu lực vì cả chuỗi đã bị thu hồi.
    await api().post("/api/v1/auth/refresh").set("Cookie", newCookie).expect(401);

    const revoked = await prisma.refreshSession.findMany({
      where: { revokedReason: "REUSE_DETECTED" },
    });
    expect(revoked.length).toBeGreaterThan(0);
  });

  it("đăng xuất làm access token hết hiệu lực ngay, không phải chờ hết hạn", async () => {
    const { token } = await login("admin");
    await api().get("/api/v1/auth/me").set(authHeaders(token)).expect(200);

    await api().post("/api/v1/auth/logout").set(authHeaders(token)).expect(200);
    await api().get("/api/v1/auth/me").set(authHeaders(token)).expect(401);
  });
});

describe("Phạm vi cửa hàng", () => {
  it("người chỉ thuộc NT01 không làm việc được ở NT02", async () => {
    const { token } = await login("duocsi");
    const response = await api()
      .get("/api/v1/products")
      .set(authHeaders(token, fixture.otherStoreId))
      .expect(403);

    expect(response.body.error.code).toBe("STORE_FORBIDDEN");
  });

  it("vai trò bao toàn chuỗi vào được mọi cửa hàng", async () => {
    const { token } = await login("admin");
    await api().get("/api/v1/products").set(authHeaders(token, fixture.storeId)).expect(200);
    await api().get("/api/v1/products").set(authHeaders(token, fixture.otherStoreId)).expect(200);
  });

  it("X-Store-Id sai định dạng bị chặn", async () => {
    const { token } = await login("admin");
    const response = await api()
      .get("/api/v1/products")
      .set(authHeaders(token, "khong-phai-uuid"))
      .expect(400);

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});
