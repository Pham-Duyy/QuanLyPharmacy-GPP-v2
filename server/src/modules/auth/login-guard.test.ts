import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  TEST_PASSWORD,
} from "../../test/helpers.js";
import { createLoginGuard } from "./login-guard.js";

describe("Chặn dò mật khẩu theo IP", () => {
  it("quá 20 lần sai trong 15 phút thì chặn, hết 15 phút thì cho lại", () => {
    let now = 0;
    const guard = createLoginGuard(() => now);
    for (let i = 0; i < 20; i++) {
      guard.assertAllowed("10.0.0.1");
      guard.recordFailure("10.0.0.1");
      now += 1000;
    }
    expect(() => guard.assertAllowed("10.0.0.1")).toThrow(/thử lại sau 15 phút/);
    // Máy khác không bị ảnh hưởng.
    expect(() => guard.assertAllowed("10.0.0.2")).not.toThrow();

    now = 15 * 60_000 + 500;
    expect(() => guard.assertAllowed("10.0.0.1")).not.toThrow();
  });
});

describe("Đăng nhập qua API", () => {
  beforeAll(async () => {
    await truncateAll();
    await seedFixture();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("mật khẩu mới dài quá 72 byte (bcrypt bỏ phần dư) thì bị từ chối", async () => {
    const { token } = await login("duocsi");
    const response = await api()
      .post("/api/v1/auth/change-password")
      .set(authHeaders(token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: `Mậtkhẩu1${"đ".repeat(35)}` })
      .expect(422);
    expect(JSON.stringify(response.body)).toContain("72 ký tự");
  });

  it("dò nhiều tài khoản từ một máy: lần thứ 21 bị chặn kể cả đúng mật khẩu", async () => {
    for (let i = 0; i < 20; i++) {
      await api()
        .post("/api/v1/auth/login")
        .send({ username: `khong-co-${i}`, password: "sai-mat-khau" })
        .expect(401);
    }
    const blocked = await api()
      .post("/api/v1/auth/login")
      .send({ username: "admin", password: TEST_PASSWORD })
      .expect(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });
});
