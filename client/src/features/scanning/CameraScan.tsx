import { CameraOutlined, LoadingOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Tooltip } from "antd";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** Trình duyệt chỉ cho mở camera trên https hoặc localhost. */
function cameraAvailable(): boolean {
  return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
}

function cameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Trình duyệt chưa cho dùng camera. Bấm biểu tượng camera trên thanh địa chỉ để cho phép rồi mở lại.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "Không tìm thấy camera trên máy này.";
  if (name === "NotReadableError" || name === "AbortError")
    return "Camera đang được ứng dụng khác dùng. Đóng ứng dụng đó rồi mở lại.";
  return "Không mở được camera.";
}

type ScanProps = {
  title: string;
  /** Lấy phần dùng được từ nội dung vừa đọc; trả null là mã không đúng loại. */
  accept: (raw: string) => string | null;
  /** Câu báo khi đọc được mã nhưng không đúng loại. */
  wrongCodeMessage?: string;
  onDetected: (code: string) => void;
};

/**
 * Nút mở camera để quét mã, cho máy không có máy quét cầm tay. Đọc được một
 * mã đúng loại là đóng ngay: mỗi lần mở chỉ một thao tác, tránh để hộp thuốc
 * nằm trước camera bị tính nhiều lần.
 */
export function CameraScanButton({
  type = "default",
  ...props
}: ScanProps & { type?: "default" | "text" }) {
  const [open, setOpen] = useState(false);
  const available = cameraAvailable();
  // Nút thường nằm trong ô nhập (suffix): phím bấm trong hộp thoại vẫn nổi lên
  // theo cây React dù hộp thoại vẽ ở chỗ khác, nên chặn lại để Enter không làm
  // ô nhập tra mã. Chừa Esc: antd bắt Esc ở window để đóng hộp thoại.
  const isolate = (event: KeyboardEvent) => {
    if (event.key !== "Escape") event.stopPropagation();
  };
  return (
    <span onKeyDown={isolate}>
      <Tooltip
        title={
          available
            ? props.title
            : "Camera chỉ dùng được khi mở phần mềm bằng https hoặc trên chính máy chủ (localhost)"
        }
      >
        <Button
          type={type}
          icon={<CameraOutlined />}
          aria-label={props.title}
          disabled={!available}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      {open ? <CameraScanModal {...props} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function CameraScanModal({
  title,
  accept,
  wrongCodeMessage,
  onDetected,
  onClose,
}: ScanProps & { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrongCode, setWrongCode] = useState(false);
  // Camera chỉ mở một lần khi hiện hộp thoại; các hàm của nơi gọi lấy bản mới nhất qua ref.
  const handlers = useRef({ accept, onDetected, onClose });
  useEffect(() => {
    handlers.current = { accept, onDetected, onClose };
  });

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const stop = () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    void (async () => {
      try {
        const [media, { createBarcodeReader }] = await Promise.all([
          navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          }),
          import("./barcode-reader.js"),
        ]);
        stream = media;
        const video = videoRef.current;
        if (stopped || !video) {
          stop();
          return;
        }
        video.srcObject = media;
        await video.play();
        const reader = createBarcodeReader();
        setReady(true);
        const tick = async () => {
          if (stopped) return;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const found = await reader.detect(video);
            for (const item of found) {
              const code = handlers.current.accept(item.rawValue);
              if (code && !stopped) {
                stop();
                handlers.current.onDetected(code);
                handlers.current.onClose();
                return;
              }
            }
            if (found.length > 0) setWrongCode(true);
          }
          if (!stopped) timer = window.setTimeout(() => void tick().catch(fail), 150);
        };
        const fail = (cause: unknown) => {
          if (stopped) return;
          stop();
          setError(
            cause instanceof DOMException && cause.name !== "NotSupportedError"
              ? cameraError(cause)
              : "Không tải được bộ đọc mã. Tải lại trang rồi thử lại.",
          );
        };
        await tick().catch(fail);
      } catch (cause) {
        if (!stopped) {
          stop();
          setError(cameraError(cause));
        }
      }
    })();
    return stop;
  }, []);

  return (
    <Modal open title={title} footer={null} onCancel={onClose} width={560}>
      {error ? (
        <Alert type="error" showIcon title={error} />
      ) : (
        <>
          <div className="camera-scan">
            <video ref={videoRef} muted playsInline aria-label="Hình từ camera" />
            <div className="camera-scan-frame" aria-hidden />
            {!ready ? (
              <div className="camera-scan-loading">
                <LoadingOutlined /> Đang mở camera…
              </div>
            ) : null}
          </div>
          <p className="camera-scan-hint">
            Đưa mã vào giữa khung, giữ yên và đủ sáng. Mã vạch nhỏ trên hộp thuốc nên đưa lại gần.
          </p>
          {wrongCode && wrongCodeMessage ? (
            <Alert type="warning" showIcon title={wrongCodeMessage} />
          ) : null}
        </>
      )}
    </Modal>
  );
}
