/**
 * Giải thích vì sao không mở được camera và người dùng phải làm gì.
 *
 * Trình duyệt trả cùng một lỗi NotAllowedError cho ba trường hợp khác nhau,
 * mỗi trường hợp sửa ở một chỗ khác: trang bị chặn camera (sửa trong trình
 * duyệt), hệ điều hành chặn trình duyệt dùng camera (sửa trong Cài đặt của
 * Windows/macOS), hoặc người dùng đóng câu hỏi xin quyền (chỉ cần thử lại).
 * Phân biệt bằng trạng thái quyền của trang và nội dung lỗi.
 */

export type CameraPermission = "granted" | "denied" | "prompt" | "unknown";

export type CameraProblem = {
  title: string;
  steps: string[];
  /** Thử lại ngay có ích (không phải lỗi phần cứng cố định). */
  retry: boolean;
};

export type Platform = "windows" | "mac" | "other";

export function detectPlatform(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent) && !/iPhone|iPad/i.test(userAgent)) return "mac";
  return "other";
}

const SITE_STEPS = [
  "Bấm biểu tượng bên trái địa chỉ trang (ổ khóa hoặc biểu tượng điều chỉnh) trên thanh địa chỉ.",
  "Chọn Quyền cho trang web (Site settings), tìm mục Camera, chọn Cho phép (Allow).",
  "Quay lại đây bấm Thử lại. Nếu vẫn báo lỗi, tải lại trang (F5).",
];

function systemSteps(platform: Platform): string[] {
  if (platform === "windows")
    return [
      "Mở Cài đặt Windows (phím Windows + I) → Quyền riêng tư và bảo mật → Camera.",
      "Bật Truy cập camera, bật Cho phép ứng dụng truy cập camera và Cho phép ứng dụng máy tính truy cập camera.",
      "Đóng hẳn trình duyệt rồi mở lại, vào lại trang này bấm Thử lại.",
    ];
  if (platform === "mac")
    return [
      "Mở Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Camera.",
      "Bật công tắc cho trình duyệt đang dùng (Chrome, Edge…).",
      "Đóng hẳn trình duyệt rồi mở lại, vào lại trang này bấm Thử lại.",
    ];
  return [
    "Mở cài đặt quyền riêng tư của thiết bị, cho phép trình duyệt dùng camera.",
    "Mở lại trình duyệt rồi bấm Thử lại.",
  ];
}

export function explainCameraError(
  error: unknown,
  permission: CameraPermission,
  platform: Platform,
): CameraProblem {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    // Chrome, Edge: "Permission denied by system" khi Windows/macOS chặn.
    const bySystem = /system/i.test(message) || permission === "granted";
    if (bySystem)
      return {
        title: "Máy tính đang chặn trình duyệt dùng camera.",
        steps: systemSteps(platform),
        retry: true,
      };
    if (permission === "denied")
      return { title: "Trang này đang bị chặn dùng camera.", steps: SITE_STEPS, retry: true };
    if (permission === "prompt")
      return {
        title: "Chưa cho phép dùng camera.",
        steps: ["Bấm Thử lại, rồi chọn Cho phép (Allow) khi trình duyệt hỏi quyền dùng camera."],
        retry: true,
      };
    // Trình duyệt không cho biết trạng thái quyền (Firefox): nêu cả hai chỗ.
    return {
      title: "Trình duyệt hoặc máy tính chưa cho dùng camera.",
      steps: [...SITE_STEPS.slice(0, 2), ...systemSteps(platform).slice(0, 2), "Bấm Thử lại."],
      retry: true,
    };
  }
  if (name === "SecurityError")
    return {
      title: "Camera chỉ dùng được khi mở phần mềm bằng https hoặc trên chính máy chủ (localhost).",
      steps: ["Dùng nút Chụp ảnh mã bên dưới, hoặc dùng máy quét mã vạch cầm tay."],
      retry: false,
    };
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return {
      title: "Không tìm thấy camera trên máy này.",
      steps: ["Cắm webcam rồi bấm Thử lại, hoặc dùng nút Chụp ảnh mã / máy quét mã vạch cầm tay."],
      retry: true,
    };
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return {
      title: "Camera đang được ứng dụng khác dùng hoặc bị máy tính chặn.",
      steps: [
        "Đóng các ứng dụng đang dùng camera (Zalo, Zoom, Teams, Camera…) rồi bấm Thử lại.",
        ...(platform === "windows" ? [systemSteps(platform)[0]!] : []),
      ],
      retry: true,
    };
  return { title: "Không mở được camera.", steps: ["Bấm Thử lại, hoặc tải lại trang."], retry: true };
}

/** Trạng thái quyền camera của trang; trình duyệt không hỗ trợ thì "unknown". */
export async function cameraPermission(): Promise<CameraPermission> {
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
}
