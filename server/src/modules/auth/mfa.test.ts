import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { totp, TOTP_STEP_SECONDS } from "../../lib/totp.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  TEST_PASSWORD,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

/** Xác thực hai lớp (Phase 7, D31). */

let f: Fixture;

beforeEach(async () => {
  await truncateAll();
  f = await seedFixture();
});
afterAll(() => prisma.$disconnect());

const post = (path: string, token: string | null, body: object = {}) => {
  const request = api().post(`/api/v1${path}`);
  if (token) request.set(authHeaders(token));
  return request.send(body);
};

/** Bật MFA cho một tài khoản; trả khóa bí mật và mã dự phòng. */
async function enableMfa(username: string) {
  const { token } = await login(username);
  const setup = await post("/auth/mfa/setup", token).expect(200);
  const secret = setup.body.data.secret as string;
  expect(setup.body.data.otpauthUrl).toContain(`Pharmacy%20GPP%3A${username}`);
  const enabled = await post("/auth/mfa/enable", token, { code: totp(secret) }).expect(200);
  return { token, secret, recoveryCodes: enabled.body.data.recoveryCodes as string[] };
}

/** Mã của bước kế tiếp: mã vừa dùng để bật không dùng lại được. */
const nextCode = (secret: string) => totp(secret, Date.now() + TOTP_STEP_SECONDS * 1000);

const passwordStep = (username: string) =>
  post("/auth/login", null, { username, password: TEST_PASSWORD });

describe("Bật xác thực hai lớp", () => {
  it("mã sai không bật được; mã đúng bật và trả 10 mã dự phòng", async () => {
    const { token } = await login("duocsi");
    await post("/auth/mfa/setup", token).expect(200);
    await post("/auth/mfa/enable", token, { code: "000000" }).expect(422);

    const { recoveryCodes } = await enableMfa("banhang");
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const user = await prisma.user.findUniqueOrThrow({ where: { username: "banhang" } });
    expect(user.mfaEnabledAt).not.toBeNull();
    // Không lưu khóa thô, không lưu mã dự phòng thô.
    expect(user.mfaSecretEnc).not.toMatch(/^[A-Z2-7]{32}$/);
    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored.map((row) => row.codeHash)).not.toContain(recoveryCodes[0]);
    expect(await prisma.auditLog.count({ where: { action: "MFA_ENABLE" } })).toBe(1);
  });
});

describe("Đăng nhập hai bước", () => {
  it("đúng mật khẩu chỉ nhận vé; vé + mã đúng mới có phiên", async () => {
    const { secret } = await enableMfa("duocsi");
    const step1 = await passwordStep("duocsi").expect(200);
    expect(step1.body.data.mfaRequired).toBe(true);
    expect(step1.body.data.accessToken).toBeUndefined();
    expect(step1.headers["set-cookie"]).toBeUndefined();

    // Vé không dùng thay access token được.
    await api()
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${step1.body.data.mfaToken}`)
      .expect(401);

    await post("/auth/login/mfa", null, {
      mfaToken: step1.body.data.mfaToken,
      code: "123456",
    }).expect(401);
    const step2 = await post("/auth/login/mfa", null, {
      mfaToken: step1.body.data.mfaToken,
      code: nextCode(secret),
    }).expect(200);
    expect(step2.body.data.accessToken).toBeTruthy();
    expect(step2.headers["set-cookie"]?.[0]).toContain("gpp_refresh");
  });

  it("một mã 6 số không dùng được hai lần", async () => {
    const { secret } = await enableMfa("duocsi");
    const code = nextCode(secret);
    const first = await passwordStep("duocsi").expect(200);
    await post("/auth/login/mfa", null, { mfaToken: first.body.data.mfaToken, code }).expect(200);
    const second = await passwordStep("duocsi").expect(200);
    await post("/auth/login/mfa", null, { mfaToken: second.body.data.mfaToken, code }).expect(401);
  });

  it("mã dự phòng dùng được một lần, có ghi nhật ký", async () => {
    const { recoveryCodes } = await enableMfa("duocsi");
    const code = recoveryCodes[3]!.toLowerCase();
    const first = await passwordStep("duocsi").expect(200);
    const ok = await post("/auth/login/mfa", null, {
      mfaToken: first.body.data.mfaToken,
      code,
    }).expect(200);
    expect(ok.body.data.usedRecoveryCode).toBe(true);
    const second = await passwordStep("duocsi").expect(200);
    await post("/auth/login/mfa", null, { mfaToken: second.body.data.mfaToken, code }).expect(401);
    expect(await prisma.auditLog.count({ where: { action: "MFA_RECOVERY_USED" } })).toBe(1);
  });

  it("sai mã nhiều lần thì phải chờ, nhập lại mật khẩu đúng không xóa được bộ đếm", async () => {
    await enableMfa("duocsi");
    for (let i = 0; i < 5; i++) {
      const step = await passwordStep("duocsi").expect(200);
      await post("/auth/login/mfa", null, { mfaToken: step.body.data.mfaToken, code: "000000" });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "duocsi" } });
    expect(user.failedLoginCount).toBe(5);
    await passwordStep("duocsi").expect(429);
  });
});

describe("Tắt, đặt lại, bắt buộc", () => {
  it("tắt cần cả mật khẩu và mã", async () => {
    const { token, secret } = await enableMfa("duocsi");
    await post("/auth/mfa/disable", token, { password: "sai", code: nextCode(secret) }).expect(422);
    await post("/auth/mfa/disable", token, {
      password: TEST_PASSWORD,
      code: nextCode(secret),
    }).expect(200);
    const step = await passwordStep("duocsi").expect(200);
    expect(step.body.data.accessToken).toBeTruthy();
  });

  it("quản lý đặt lại MFA cho nhân viên: thu hồi phiên, ghi nhật ký; không tự đặt lại cho mình", async () => {
    const { token: staffToken } = await enableMfa("duocsi");
    const { token: adminToken } = await login("admin");
    await post(`/users/${f.pharmacistId}/mfa/reset`, adminToken).expect(200);
    await api().get("/api/v1/auth/me").set(authHeaders(staffToken)).expect(401);
    const step = await passwordStep("duocsi").expect(200);
    expect(step.body.data.accessToken).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { action: "MFA_RESET" } })).toBe(1);

    await post(`/users/${f.adminId}/mfa/reset`, adminToken).expect(422);
  });

  it("bắt buộc với Quản lý: quản lý chưa bật bị chặn tới khi bật xong; dược sĩ không bị ảnh hưởng", async () => {
    const { token: adminToken } = await login("admin");
    await api()
      .put("/api/v1/security/mfa-policy")
      .set(authHeaders(adminToken))
      .send({ requiredForManagers: true })
      .expect(200);

    const blocked = await api().get("/api/v1/users").set(authHeaders(adminToken)).expect(403);
    expect(blocked.body.error.code).toBe("MFA_SETUP_REQUIRED");
    const me = await api().get("/api/v1/auth/me").set(authHeaders(adminToken)).expect(200);
    expect(me.body.data.user.mfaSetupRequired).toBe(true);

    const { token: pharmacistToken } = await login("duocsi");
    await api().get("/api/v1/auth/me").set(authHeaders(pharmacistToken, f.storeId)).expect(200);
    await api().get("/api/v1/customers").set(authHeaders(pharmacistToken, f.storeId)).expect(200);

    // Bật xong thì dùng tiếp được; đang bắt buộc thì không tắt được.
    const setup = await post("/auth/mfa/setup", adminToken).expect(200);
    await post("/auth/mfa/enable", adminToken, { code: totp(setup.body.data.secret) }).expect(200);
    await api().get("/api/v1/users").set(authHeaders(adminToken)).expect(200);
    await post("/auth/mfa/disable", adminToken, {
      password: TEST_PASSWORD,
      code: nextCode(setup.body.data.secret),
    }).expect(409);
  });

  it("chỉ quản lý toàn chuỗi đổi được chính sách", async () => {
    const { token } = await login("duocsi");
    await api()
      .put("/api/v1/security/mfa-policy")
      .set(authHeaders(token))
      .send({ requiredForManagers: true })
      .expect(403);
  });
});
