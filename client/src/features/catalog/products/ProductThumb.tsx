import { MedicineBoxOutlined } from "@ant-design/icons";
import { useState } from "react";

type Props = {
  src: string | null | undefined;
  alt: string;
  size?: number;
  className?: string;
};

/**
 * Ảnh thu nhỏ kích thước cố định (không nhảy bố cục), tải lười. Chưa có ảnh
 * hoặc ảnh lỗi thì hiện biểu tượng trung tính — không lấy ảnh từ nguồn khác.
 */
export function ProductThumb({ src, alt, size = 56, className = "" }: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;

  return (
    <span className={`product-thumb ${className}`} style={{ width: size, height: size }}>
      {showImage ? (
        <img src={src!} alt={alt} loading="lazy" decoding="async" width={size} height={size} onError={() => setFailedSrc(src ?? null)} />
      ) : (
        <span className="product-thumb-empty" role="img" aria-label={src ? `Không tải được ảnh ${alt}` : `${alt} chưa có ảnh`}>
          <MedicineBoxOutlined />
        </span>
      )}
    </span>
  );
}
