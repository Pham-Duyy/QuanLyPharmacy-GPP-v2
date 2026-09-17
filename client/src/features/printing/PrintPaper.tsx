import { Spin } from "antd";
import { useEffect, useRef, useState } from "react";
import type { PaperSize } from "../../api/types.js";

/** Bề rộng khổ giấy theo px CSS (96dpi): 1mm = 3.7795px. */
const PAPER_PX: Record<PaperSize, number> = { K80: 302, K58: 219, A5: 559, A4: 794 };

type PrintPaperProps = {
  html: string | undefined;
  paperSize: PaperSize;
  loading?: boolean;
  title?: string;
};

/**
 * Hiển thị trang in do server dựng trong một iframe cô lập, trông như tờ
 * giấy in. `sandbox` không cho chạy script; chỉ giữ cùng origin để đo chiều
 * cao nội dung, nhờ vậy tờ giấy dài đúng bằng hóa đơn thật. Khung hẹp hơn
 * khổ giấy (A5 trên điện thoại) thì thu nhỏ cả tờ thay vì cắt bớt nội dung.
 */
export function PrintPaper({ html, paperSize, loading, title = "Xem trước bản in" }: PrintPaperProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    // Khung đang ẩn (tab "Xem trước" trên điện thoại) thì không đo được chiều cao;
    // đo lại khi khung hiện ra và có bề rộng thật.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0) return;
      setAvailable(entry.contentRect.width);
      const doc = frameRef.current?.contentDocument?.body;
      if (doc && doc.scrollHeight > 0) setHeight(Math.max(240, doc.scrollHeight + 4));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const width = PAPER_PX[paperSize];
  const scale = available === null ? 1 : Math.min(1, available / width);

  return (
    <div ref={stageRef} className={`print-paper-stage paper-${paperSize.toLowerCase()}`}>
      <Spin spinning={Boolean(loading)}>
        <div className="print-paper-frame" style={{ width: width * scale, height: height * scale }}>
          <div className="print-paper" style={{ width, transform: scale < 1 ? `scale(${scale})` : undefined }}>
            {html ? (
              <iframe
                ref={frameRef}
                title={title}
                sandbox="allow-same-origin"
                srcDoc={html}
                style={{ height }}
                onLoad={(event) => {
                  const doc = event.currentTarget.contentDocument?.body;
                  if (doc && doc.scrollHeight > 0) setHeight(Math.max(240, doc.scrollHeight + 4));
                }}
              />
            ) : (
              <div className="print-paper-empty" style={{ height }} />
            )}
          </div>
        </div>
      </Spin>
    </div>
  );
}
