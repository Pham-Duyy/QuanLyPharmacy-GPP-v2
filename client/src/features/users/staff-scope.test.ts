import { describe, expect, it } from "vitest";
import { canManageAccount } from "./staff-scope.js";

describe("phạm vi quản lý tài khoản", () => {
  const nt01 = { canChain: false, stores: [{ id: "nt01" }] };

  it("quản lý toàn chuỗi thao tác được mọi tài khoản", () => {
    expect(canManageAccount({ canChain: true, stores: [] }, [{ storeId: null }])).toBe(true);
  });

  it("quản lý một cửa hàng chỉ thao tác được người chỉ làm ở đó hoặc chưa có vai trò", () => {
    expect(canManageAccount(nt01, [{ storeId: "nt01" }])).toBe(true);
    expect(canManageAccount(nt01, [])).toBe(true);
    expect(canManageAccount(nt01, [{ storeId: null }])).toBe(false);
    expect(canManageAccount(nt01, [{ storeId: "nt01" }, { storeId: "nt02" }])).toBe(false);
  });
});
