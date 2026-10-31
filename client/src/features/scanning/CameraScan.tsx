import { CameraOutlined, LoadingOutlined, PictureOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Space, Tooltip } from "antd";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  cameraPermission,
  detectPlatform,
  explainCameraError,
  type CameraProblem,
} from "./camera-errors.js";

/** Trình duyệt chỉ cho mở camera trực tiếp trên https hoặc localhost. */
function liveCameraAvailable(): boolean {
  return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
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
 *
 * Không mở được camera trực tiếp (bị chặn quyền, mở bằng http từ máy khác)
 * vẫn đọc được mã từ ảnh chụp: trên điện thoại, máy tính bảng ô chọn ảnh mở
 * thẳng ứng dụng camera và không cần cấp quyền cho trang.
 */
export function CameraScanButton({
  type = "default",
  ...props
}: ScanProps & { type?: "default" | "text" }) {
  const [open, setOpen] = useState(false);
  // Nút thường nằm trong ô nhập (suffix): phím bấm trong hộp thoại vẫn nổi lên
  // theo cây React dù hộp thoại vẽ ở chỗ khác, nên chặn lại để Enter không làm
  // ô nhập tra mã. Chừa Esc: antd bắt Esc ở window để đóng hộp thoại.
  const isolate = (event: KeyboardEvent) => {
    if (event.key !== "Escape") event.stopPropagation();
  };
  return (
    <span onKeyDown={isolate}>
      <Tooltip title={props.title}>
        <Button
          type={type}
          icon={<CameraOutlined />}
          aria-label={props.title}
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
  const live = liveCameraAvailable();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [wrongCode, setWrongCode] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  // Camera chỉ mở một lần mỗi lượt thử; các hàm của nơi gọi lấy bản mới nhất qua ref.
  const handlers = useRef({ accept, onDetected, onClose });
  useEffect(() => {
    handlers.current = { accept, onDetected, onClose };
  });

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    /** Tắt camera (đèn camera tắt theo). */
    const release = () => {
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    const stop = () => {
      stopped = true;
      release();
    };
    const report = async (cause: unknown) => {
      const permission = await cameraPermission();
      if (!stopped) setProblem(explainCameraError(cause, permission, detectPlatform(navigator.userAgent)));
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
          release();
          if (cause instanceof DOMException && cause.name !== "NotSupportedError") void report(cause);
          else
            setProblem({
              title: "Không tải được bộ đọc mã.",
              steps: ["Tải lại trang (F5) rồi thử lại."],
              retry: false,
            });
        };
        await tick().catch(fail);
      } catch (cause) {
        release();
        // Lỗi xảy ra sau khi đã đóng hộp thoại thì bỏ qua.
        if (!stopped) await report(cause);
      }
    })();
    return stop;
  }, [live, attempt]);

  const retry = () => {
    setProblem(null);
    setReady(false);
    setWrongCode(false);
    setAttempt((n) => n + 1);
  };

  // Người dùng vừa cho phép camera trong trình duyệt: tự thử lại, khỏi bấm.
  useEffect(() => {
    if (!problem?.retry) return;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (status?.state === "granted") retry();
    };
    navigator.permissions
      ?.query({ name: "camera" as PermissionName })
      .then((result) => {
        status = result;
        result.addEventListener("change", onChange);
      })
      .catch(() => {});
    return () => status?.removeEventListener("change", onChange);
  }, [problem]);

  const readPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoBusy(true);
    setPhotoMessage(null);
    try {
      const { createBarcodeReader } = await import("./barcode-reader.js");
      const found = await createBarcodeReader().detect(file);
      for (const item of found) {
        const code = handlers.current.accept(item.rawValue);
        if (code) {
          handlers.current.onDetected(code);
          handlers.current.onClose();
          return;
        }
      }
      setPhotoMessage(
        found.length > 0 && wrongCodeMessage
          ? wrongCodeMessage
          : "Không đọc được mã trong ảnh. Chụp lại gần hơn, đủ sáng, mã nằm ngang và không bị lóa.",
      );
    } catch {
      setPhotoMessage("Không đọc được ảnh này. Thử chụp lại hoặc chọn ảnh khác.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const photoButton = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label="Ảnh có mã"
        onChange={(event) => void readPhoto(event)}
      />
      <Button
        icon={<PictureOutlined />}
        loading={photoBusy}
        onClick={() => fileRef.current?.click()}
      >
        Chụp ảnh mã
      </Button>
    </>
  );

  return (
    <Modal open title={title} footer={null} onCancel={onClose} width={560}>
      {!live ? (
        <Alert
          type="info"
          showIcon
          title="Camera trực tiếp chỉ dùng được khi mở phần mềm bằng https hoặc trên chính máy chủ (localhost)."
          description="Bấm Chụp ảnh mã: điện thoại, máy tính bảng sẽ mở camera để chụp; máy tính chọn một ảnh có sẵn."
        />
      ) : problem ? (
        <Alert
          type="error"
          showIcon
          title={problem.title}
          description={
            <ol className="camera-scan-steps">
              {problem.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          }
        />
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
      <Space wrap className="camera-scan-actions">
        {live && problem?.retry ? (
          <Button type="primary" icon={<ReloadOutlined />} onClick={retry}>
            Thử lại
          </Button>
        ) : null}
        {photoButton}
      </Space>
      {photoMessage ? <Alert type="warning" showIcon title={photoMessage} /> : null}
    </Modal>
  );
}
