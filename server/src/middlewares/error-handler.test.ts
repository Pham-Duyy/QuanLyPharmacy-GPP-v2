import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
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

  it.each([
    ["truy vấn thường", "P2007"],
    ["truy vấn raw", "P2010"],
  ])("chuỗi không phải UUID tới CSDL (%s) thì trả 404", async (_label, code) => {
    const error = new Prisma.PrismaClientKnownRequestError("Invalid input value", {
      code,
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: "22P02",
            originalMessage: 'invalid input syntax for type uuid: "abc"',
          },
        },
      },
    });
    const response = await request(appThrowing(error)).get("/thu").expect(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("lỗi khác vẫn là 500", async () => {
    const response = await request(appThrowing(new Error("lỗi bất ngờ")))
      .get("/thu")
      .expect(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
  });
});
