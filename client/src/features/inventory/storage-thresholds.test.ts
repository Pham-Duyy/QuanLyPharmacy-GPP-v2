import { describe, expect, it } from "vitest";
import { thresholdText } from "./storage-thresholds.js";

describe("ngưỡng khu vực bảo quản", () => {
  it("ghi đúng dạng theo ngưỡng đã đặt", () => {
    expect(thresholdText(2, 8, "°C")).toBe("2 – 8 °C");
    expect(thresholdText(null, 30, "°C")).toBe("≤ 30 °C");
    expect(thresholdText(15, null, "°C")).toBe("≥ 15 °C");
    expect(thresholdText(null, null, "%")).toBe("Không đặt");
  });
});
