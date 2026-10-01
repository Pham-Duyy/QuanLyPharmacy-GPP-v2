import { describe, expect, it } from "vitest";
import { initials } from "./staff-format.js";
import { generatePassword, passwordProblem, USERNAME_PATTERN } from "./staff-password.js";

describe("mật khẩu khi tạo nhân viên", () => {
  it("mật khẩu sinh ngẫu nhiên luôn đạt luật máy chủ và không lặp", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const value = generatePassword();
      expect(passwordProblem(value)).toBeNull();
      seen.add(value);
    }
    expect(seen.size).toBe(200);
  });

  it("báo đúng lỗi theo chính sách hiện hành", () => {
    expect(passwordProblem("Ab1")).toMatch(/Tối thiểu 10/);
    expect(passwordProblem("chuachusoxx")).toMatch(/chữ số/);
    expect(passwordProblem("1234567890")).toMatch(/chữ cái/);
    expect(passwordProblem("Khoi2026dau")).toBeNull();
  });

  it("tên đăng nhập theo đúng quy tắc máy chủ", () => {
    expect(USERNAME_PATTERN.test("minh.anh_01")).toBe(true);
    expect(USERNAME_PATTERN.test("ab")).toBe(false);
    expect(USERNAME_PATTERN.test("minh anh")).toBe(false);
    expect(USERNAME_PATTERN.test("trần")).toBe(false);
  });
});

describe("avatar viết tắt", () => {
  it("lấy hai chữ đầu của hai từ cuối, bỏ phần trong ngoặc", () => {
    expect(initials("Trần Minh Anh")).toBe("MA");
    expect(initials("Chủ nhà thuốc (demo)")).toBe("NT");
    expect(initials("Đỗ Đức")).toBe("ĐĐ");
    expect(initials("  ")).toBe("?");
  });
});
