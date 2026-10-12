import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../test/helpers.js";

/**
 * Mã sai định dạng trên đường dẫn từng đi thẳng tới CSDL và trả 500 kèm thông
 * báo lỗi của Prisma (phát hiện khi robot mô phỏng gọi `/stock-counts/undefined`).
 */
let fixture: Fixture;
let token: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("admin")).token;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Mã sai định dạng trên đường dẫn", () => {
  it.each(["/api/v1/invoices", "/api/v1/stock-counts", "/api/v1/goods-receipts"])(
    "GET %s/khong-phai-ma trả 404, không phải 500",
    async (path) => {
      const response = await api()
        .get(`${path}/khong-phai-ma`)
        .set(authHeaders(token, fixture.storeId))
        .expect(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.body.error.message).not.toContain("prisma");
    },
  );

  it("thao tác ghi (hủy hóa đơn) với mã sai định dạng cũng trả 404", async () => {
    const response = await api()
      .post("/api/v1/invoices/khong-phai-ma/void")
      .set({ ...authHeaders(token, fixture.storeId), "Idempotency-Key": randomUUID() })
      .send({ reason: "Thử mã sai" })
      .expect(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
