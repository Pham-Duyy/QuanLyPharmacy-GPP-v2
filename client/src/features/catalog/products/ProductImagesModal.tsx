import { DeleteOutlined, StarFilled, StarOutlined, UploadOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Button, Image, Modal, Popconfirm, Tag, Tooltip, Upload } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../../api/http.js";
import type { Envelope, ProductImage } from "../../../api/types.js";
import { IMAGE_FALLBACK } from "./product-labels.js";
import { ProductThumb } from "./ProductThumb.js";

const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 8;
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

/**
 * Thu nhỏ ảnh ngay trên trình duyệt: ảnh chụp điện thoại thường vài MB,
 * danh sách chỉ cần vài chục KB. Vẽ lại qua canvas cũng bỏ luôn EXIF.
 */
async function resize(file: File, maxSide: number, keepPng: boolean): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Tệp không phải ảnh hợp lệ hoặc đã hỏng");
  });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Trình duyệt không xử lý được ảnh");
    const type = keepPng ? "image/png" : "image/jpeg";
    if (!keepPng) {
      // JPEG không có nền trong suốt: tô trắng để ảnh PNG/WEBP trong suốt không thành nền đen.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Không nén được ảnh"))), type, 0.86),
    );
  } finally {
    bitmap.close();
  }
}

type Props = {
  productId: string;
  productName: string;
  images: ProductImage[];
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
};

/** Tải, đặt ảnh chính, gỡ ảnh sản phẩm (quyền `catalog.manage`, server kiểm tra lại). */
export function ProductImagesModal({ productId, productName, images, open, onClose, onChanged }: Props) {
  const { message } = App.useApp();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const full = images.length >= MAX_IMAGES;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!ACCEPT.includes(file.type)) throw new Error("Chỉ nhận ảnh JPG, PNG hoặc WEBP");
      if (file.size > MAX_INPUT_BYTES) throw new Error("Ảnh lớn hơn 15 MB, hãy chọn ảnh khác");
      const keepPng = file.type === "image/png";
      let main = await resize(file, 1600, keepPng);
      if (main.size > 4.5 * 1024 * 1024) main = await resize(file, 1600, false);
      const thumb = await resize(file, 320, false);
      const form = new FormData();
      form.append("file", main, keepPng && main.type === "image/png" ? "anh.png" : "anh.jpg");
      form.append("thumb", thumb, "thumb.jpg");
      await http.post<Envelope<ProductImage>>(`/products/${productId}/images`, form);
    },
    onMutate: (file) => {
      setUploadError(null);
      setUploadingName(file.name);
    },
    onSuccess: async () => {
      void message.success("Đã tải ảnh lên");
      await onChanged();
    },
    onError: (error) => setUploadError(error instanceof Error && !("isAxiosError" in error) ? error.message : getErrorMessage(error, "Không tải được ảnh")),
    onSettled: () => setUploadingName(null),
  });

  const setPrimary = useMutation({
    mutationFn: (imageId: string) => http.post(`/products/${productId}/images/${imageId}/primary`),
    onSuccess: async () => {
      void message.success("Đã đặt ảnh chính");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đặt được ảnh chính")),
  });

  const remove = useMutation({
    mutationFn: (imageId: string) => http.delete(`/products/${productId}/images/${imageId}`),
    onSuccess: async () => {
      void message.success("Đã gỡ ảnh");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không gỡ được ảnh")),
  });

  const busy = upload.isPending || setPrimary.isPending || remove.isPending;

  return (
    <Modal open={open} onCancel={onClose} title={`Quản lý ảnh — ${productName}`} width={640} footer={<Button onClick={onClose}>Xong</Button>} destroyOnHidden>
      <p className="image-rules">
        JPG, PNG hoặc WEBP, tối đa 15 MB mỗi ảnh; hệ thống tự thu nhỏ trước khi lưu. Tối đa {MAX_IMAGES} ảnh. Chỉ dùng ảnh chụp đúng sản phẩm thật.
      </p>
      {uploadError ? <Alert type="error" showIcon closable title="Tải ảnh thất bại" description={uploadError} onClose={() => setUploadError(null)} className="image-alert" /> : null}

      <Upload.Dragger
        accept={ACCEPT.join(",")}
        multiple={false}
        showUploadList={false}
        disabled={full || busy}
        beforeUpload={(file) => {
          upload.mutate(file);
          return false;
        }}
        className="image-dropzone"
      >
        <p className="image-dropzone-icon">
          <UploadOutlined />
        </p>
        <p className="image-dropzone-text">{upload.isPending ? `Đang tải ${uploadingName ?? "ảnh"}…` : full ? `Đã đủ ${MAX_IMAGES} ảnh — gỡ bớt để thêm ảnh mới` : "Bấm hoặc kéo ảnh vào đây để tải lên"}</p>
      </Upload.Dragger>

      {images.length === 0 ? (
        <p className="image-empty">Sản phẩm chưa có ảnh. Ảnh đầu tiên tải lên sẽ là ảnh chính.</p>
      ) : (
        <Image.PreviewGroup>
          <ul className="image-manage-grid">
            {images.map((image, index) => (
              <li key={image.id} className={image.isPrimary ? "is-primary" : undefined}>
                <Image src={image.thumbUrl} preview={{ src: image.url }} alt={`Ảnh ${index + 1} của ${productName}`} width="100%" height={120} fallback={IMAGE_FALLBACK} placeholder={<ProductThumb src={null} alt={productName} size={120} />} />
                <div className="image-manage-actions">
                  {image.isPrimary ? (
                    <Tag color="blue" icon={<StarFilled />}>
                      Ảnh chính
                    </Tag>
                  ) : (
                    <Tooltip title="Đặt làm ảnh chính">
                      <Button size="small" icon={<StarOutlined />} aria-label={`Đặt ảnh ${index + 1} làm ảnh chính`} loading={setPrimary.isPending && setPrimary.variables === image.id} disabled={busy} onClick={() => setPrimary.mutate(image.id)} />
                    </Tooltip>
                  )}
                  <Popconfirm
                    title="Gỡ ảnh này?"
                    description={image.isPrimary && images.length > 1 ? "Ảnh kế tiếp sẽ thành ảnh chính." : undefined}
                    okText="Gỡ ảnh"
                    okButtonProps={{ danger: true }}
                    cancelText="Không"
                    onConfirm={() => remove.mutate(image.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} aria-label={`Gỡ ảnh ${index + 1}`} loading={remove.isPending && remove.variables === image.id} disabled={busy} />
                  </Popconfirm>
                </div>
              </li>
            ))}
          </ul>
        </Image.PreviewGroup>
      )}
    </Modal>
  );
}
