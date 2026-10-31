import { describe, expect, it } from "vitest";
import { groupSecret, recoveryCodesText } from "./mfa-api";

describe("Xác thực hai lớp", () => {
  it("chia khóa thành nhóm 4 ký tự", () => {
    expect(groupSecret("ABCDEFGHIJKLMNOPQR")).toBe("ABCD EFGH IJKL MNOP QR");
  });

  it("tệp mã dự phòng có tên tài khoản và đủ mã, đánh số", () => {
    const text = recoveryCodesText("demochu", ["AAAAA-BBBBB", "CCCCC-DDDDD"]);
    expect(text).toContain("demochu");
    expect(text).toContain(" 1. AAAAA-BBBBB");
    expect(text).toContain(" 2. CCCCC-DDDDD");
  });
});
