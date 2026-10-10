import { describe, expect, it } from "vitest";
import { assertTestDatabaseName, testDatabaseUrl } from "./test-database.js";

describe("Chốt chặn CSDL kiểm thử", () => {
  it("chỉ nhận CSDL có tên kết thúc bằng _test", () => {
    expect(() => assertTestDatabaseName("pharmacy_gpp")).toThrow(/_test/);
    expect(() => assertTestDatabaseName("")).toThrow(/_test/);
    expect(() => assertTestDatabaseName("pharmacy_gpp_test")).not.toThrow();
  });

  it("đọc tên CSDL ngay trong chuỗi kết nối", () => {
    const saved = process.env["DATABASE_URL_TEST"];
    try {
      process.env["DATABASE_URL_TEST"] =
        "postgresql://gpp:mat-khau@localhost:5432/pharmacy_gpp?schema=public";
      expect(() => testDatabaseUrl()).toThrow(/"pharmacy_gpp"/);
      process.env["DATABASE_URL_TEST"] =
        "postgresql://gpp:mat-khau@localhost:5432/pharmacy_gpp_test";
      expect(testDatabaseUrl()).toMatch(/pharmacy_gpp_test$/);
    } finally {
      process.env["DATABASE_URL_TEST"] = saved;
    }
  });
});
