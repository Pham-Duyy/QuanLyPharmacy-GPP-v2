import { describe, expect, it } from "vitest";
import { detectPlatform, explainCameraError } from "./camera-errors.js";

const denied = (message = "Permission denied") => new DOMException(message, "NotAllowedError");
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

describe("detectPlatform", () => {
  it("nhận Windows, macOS; iPad không tính là macOS", () => {
    expect(detectPlatform(WIN)).toBe("windows");
    expect(detectPlatform(MAC)).toBe("mac");
    expect(detectPlatform(IPAD)).toBe("other");
  });
});

describe("explainCameraError", () => {
  it("trang bị chặn: hướng dẫn mở quyền trong trình duyệt", () => {
    const p = explainCameraError(denied(), "denied", "windows");
    expect(p.title).toMatch(/Trang này đang bị chặn/);
    expect(p.steps.join(" ")).toMatch(/Camera, chọn Cho phép/);
    expect(p.retry).toBe(true);
  });

  it("Windows chặn trình duyệt: lỗi 'by system' hướng dẫn Cài đặt Windows", () => {
    const p = explainCameraError(denied("Permission denied by system"), "prompt", "windows");
    expect(p.title).toMatch(/Máy tính đang chặn/);
    expect(p.steps[0]).toMatch(/Cài đặt Windows/);
  });

  it("trang đã được cho phép mà vẫn bị từ chối: lỗi ở hệ điều hành", () => {
    const p = explainCameraError(denied(), "granted", "mac");
    expect(p.title).toMatch(/Máy tính đang chặn/);
    expect(p.steps[0]).toMatch(/Cài đặt hệ thống/);
  });

  it("đóng câu hỏi xin quyền: chỉ cần thử lại", () => {
    const p = explainCameraError(denied(), "prompt", "windows");
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatch(/Thử lại/);
  });

  it("trình duyệt không cho biết trạng thái quyền: nêu cả trình duyệt và hệ điều hành", () => {
    const text = explainCameraError(denied(), "unknown", "windows").steps.join(" ");
    expect(text).toMatch(/Site settings/);
    expect(text).toMatch(/Cài đặt Windows/);
  });

  it("không có camera, camera bận, trang không an toàn", () => {
    expect(explainCameraError(new DOMException("", "NotFoundError"), "unknown", "other").title).toMatch(/Không tìm thấy camera/);
    expect(explainCameraError(new DOMException("", "NotReadableError"), "granted", "windows").steps[0]).toMatch(/Zalo/);
    const insecure = explainCameraError(new DOMException("", "SecurityError"), "unknown", "other");
    expect(insecure.retry).toBe(false);
    expect(insecure.steps[0]).toMatch(/Chụp ảnh mã/);
  });

  it("lỗi lạ vẫn có câu báo", () => {
    expect(explainCameraError(new Error("x"), "unknown", "other").title).toBe("Không mở được camera.");
  });
});
