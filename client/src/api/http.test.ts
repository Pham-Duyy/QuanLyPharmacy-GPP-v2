import { afterEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: {
    create: () => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }),
    post,
  },
  AxiosError: class {},
}));

const { refreshAccessToken } = await import("./http.js");

afterEach(() => {
  vi.unstubAllGlobals();
  post.mockReset();
});

describe("làm mới phiên đăng nhập", () => {
  it("đi qua khóa chung giữa các tab, và trong một tab chỉ gửi một lần", async () => {
    const order: string[] = [];
    const request = vi.fn(async (_name: string, run: () => Promise<unknown>) => {
      order.push("giữ khóa");
      const result = await run();
      order.push("nhả khóa");
      return result;
    });
    vi.stubGlobal("navigator", { locks: { request } });
    post.mockImplementation(async () => {
      order.push("gửi refresh");
      return { data: { data: { accessToken: "token-moi" } } };
    });

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);

    expect([a, b]).toEqual(["token-moi", "token-moi"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("gpp-auth-refresh");
    expect(post).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["giữ khóa", "gửi refresh", "nhả khóa"]);
  });

  it("trình duyệt không có Web Locks thì vẫn làm mới được", async () => {
    vi.stubGlobal("navigator", {});
    post.mockResolvedValue({ data: { data: { accessToken: "token-moi" } } });
    await expect(refreshAccessToken()).resolves.toBe("token-moi");
  });
});
