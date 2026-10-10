import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { httpLogger } from "./http-logger.js";

describe("Log HTTP", () => {
  it("che access token, cookie refresh gửi lên và cookie mới trả về", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = express();
    app.use(httpLogger({ level: "info", pretty: false }, sink));
    app.post("/auth/refresh", (_req, res) => {
      res.cookie("gpp_refresh", "refresh-moi-bi-mat");
      res.json({ ok: true });
    });

    await request(app)
      .post("/auth/refresh")
      .set("Authorization", "Bearer access-bi-mat")
      .set("Cookie", "gpp_refresh=refresh-cu-bi-mat")
      .expect(200);
    // Dòng log được ghi khi response kết thúc, có thể sau khi client đã nhận xong.
    await new Promise((resolve) => setImmediate(resolve));

    const log = lines.join("");
    expect(log).toContain("[đã che]");
    expect(log).not.toContain("bi-mat");
  });
});
