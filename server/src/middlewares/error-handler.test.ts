import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "./error-handler.js";

function appThrowing(error: Error) {
  const app = express();
  app.get("/thu", () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe("Khung lỗi chung", () => {
  it("bể kết nối CSDL đầy thì trả 503 để người dùng gửi lại, không phải 500", async () => {
    const response = await request(
      appThrowing(new Error("timeout exceeded when trying to connect")),
    )
      .get("/thu")
      .expect(503);
    expect(response.body.error.code).toBe("SERVICE_BUSY");
    expect(response.body.error.message).toContain("thử lại");
  });

  it("lỗi khác vẫn là 500", async () => {
    const response = await request(appThrowing(new Error("lỗi bất ngờ")))
      .get("/thu")
      .expect(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
  });
});
