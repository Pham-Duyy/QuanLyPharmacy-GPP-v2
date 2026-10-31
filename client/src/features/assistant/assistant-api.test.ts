import { describe, expect, it } from "vitest";
import { groupConversations, parseEvents, progressText } from "./assistant-api.js";

/** Trợ lý AI (bước 6.4): đọc luồng sự kiện, nhóm lịch sử, câu tiến trình. */

describe("trợ lý AI", () => {
  it("tách luồng Server-Sent Events, giữ phần chưa trọn cho lần đọc sau", () => {
    const { events, rest } = parseEvents(
      'event: progress\ndata: {"type":"thinking","round":1}\n\nevent: result\ndata: {"status":"answ',
    );
    expect(events).toEqual([{ event: "progress", data: { type: "thinking", round: 1 } }]);
    expect(rest).toBe('event: result\ndata: {"status":"answ');
    expect(parseEvents(`${rest}ered"}\n\n`).events).toEqual([
      { event: "result", data: { status: "answered" } },
    ]);
  });

  it("câu tiến trình dễ đọc", () => {
    expect(progressText({ type: "thinking", round: 1 })).toBe("Đang đọc câu hỏi");
    expect(progressText({ type: "thinking", round: 2 })).toBe("Đang tổng hợp câu trả lời");
    expect(
      progressText({
        type: "tool_start",
        round: 1,
        name: "get_revenue",
        input: { store: "ALL", period: "day" },
      }),
    ).toBe("Đang tra: Doanh thu · toàn chuỗi · hôm nay");
    expect(progressText({ type: "verifying", round: 2 })).toBe("Đang đối chiếu số liệu");
  });

  it("nhóm lịch sử: Hôm nay, Hôm qua, 7 ngày qua, 30 ngày qua; bỏ nhóm trống", () => {
    const now = new Date(2026, 9, 31, 15, 0);
    const at = (days: number) => {
      const date = new Date(now);
      date.setDate(date.getDate() - days);
      return date.toISOString();
    };
    const item = (id: string, days: number) => ({
      id,
      title: id,
      turns: 1,
      maxTurns: 20,
      updatedAt: at(days),
      expiresAt: at(-30),
    });
    const groups = groupConversations(
      [item("a", 0), item("b", 1), item("c", 3), item("d", 20)],
      now,
    );
    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.id)])).toEqual([
      ["Hôm nay", ["a"]],
      ["Hôm qua", ["b"]],
      ["7 ngày qua", ["c"]],
      ["30 ngày qua", ["d"]],
    ]);
    expect(groupConversations([item("a", 0)], now).map((group) => group.label)).toEqual([
      "Hôm nay",
    ]);
  });
});
