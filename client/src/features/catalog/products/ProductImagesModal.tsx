import { DeleteOutlined, StarFilled, StarOutlined, UploadOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Button, Image, Modal, Popconfirm, Tag, Tooltip, Upload } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../../api/http.js";
import type { ProductImage } from "../../../api/types.js";
import { IMAGE_FALLBACK } from "./product-labels.js";
import { IMAGE_ACCEPT, MAX_IMAGES_PER_PRODUCT, uploadProductImage } from "./product-image-upload.js";
import { ProductThumb } from "./ProductThumb.js";

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
  const [progress, setProgress] = useState<{ name: string; done: number; total: number } | null>(null);
  const room = MAX_IMAGES_PER_PRODUCT - images.length;
  const full = room <= 0;

  const upload = useMutation({
    /**
     * Tải lần lượt từng ảnh: mỗi ảnh là một yêu cầu riêng, gửi song song dễ
     * tranh nhau suất "ảnh chính" và bị server trả 409.
     */
    mutationFn: async (files: File[]) => {
      const picked = files.slice(0, Math.max(0, room));
      const failed: string[] = [];
      for (const [index, file] of picked.entries()) {
        setProgress({ name: file.name, done: index, total: picked.length });
        try {
          await uploadProductImage(productId, file);
        } catch (error) {
          const reason =
            error instanceof Error && !("isAxiosError" in error)
              ? error.message
              : getErrorMessage(error, "Không tải được ảnh");
          failed.push(`${file.name}: ${reason}`);
        }
      }
      return { uploaded: picked.length - failed.length, skipped: files.length - picked.length, failed };
    },
    onMutate: () => setUploadError(null),
    onSuccess: async ({ uploaded, skipped, failed }) => {
      if (uploaded > 0) void message.success(uploaded === 1 ? "Đã tải ảnh lên" : `Đã tải lên ${uploaded} ảnh`);
      const notes = [
        ...failed,
        ...(skipped > 0 ? [`Bỏ qua ${skipped} ảnh vì mỗi sản phẩm tối đa ${MAX_IMAGES_PER_PRODUCT} ảnh.`] : []),
      ];
      if (notes.length > 0) setUploadError(notes.join("\n"));
      await onChanged();
    },
    onError: (error) => setUploadError(getErrorMessage(error, "Không tải được ảnh")),
    onSettled: () => setProgress(null),
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

  function dropzoneText(): string {
    if (progress) return `Đang tải ${progress.name} (${progress.done + 1}/${progress.total})…`;
    if (full) return `Đã đủ ${MAX_IMAGES_PER_PRODUCT} ảnh — gỡ bớt để thêm ảnh mới`;
    return "Bấm hoặc kéo ảnh vào đây để tải lên — chọn được nhiều ảnh một lượt";
  }

  return (
    <Modal open={open} onCancel={onClose} title={`Quản lý ảnh — ${productName}`} width={640} footer={<Button onClick={onClose}>Xong</Button>} destroyOnHidden>
      <p className="image-rules">
        JPG, PNG hoặc WEBP, tối đa 15 MB mỗi ảnh; hệ thống tự thu nhỏ trước khi lưu. Tối đa {MAX_IMAGES_PER_PRODUCT} ảnh. Chỉ dùng ảnh chụp đúng sản phẩm thật.
      </p>
      {uploadError ? <Alert type="error" showIcon closable title="Có ảnh chưa tải được" description={<span style={{ whiteSpace: "pre-line" }}>{uploadError}</span>} onClose={() => setUploadError(null)} className="image-alert" /> : null}

      <Upload.Dragger
        accept={IMAGE_ACCEPT.join(",")}
        multiple
        showUploadList={false}
        disabled={full || busy}
        beforeUpload={(file, fileList) => {
          // antd gọi beforeUpload cho từng tệp; gom cả lượt chọn vào một hàng đợi.
          if (file === fileList[0]) upload.mutate(fileList);
          return false;
        }}
        className="image-dropzone"
      >
        <p className="image-dropzone-icon">
          <UploadOutlined />
        </p>
        <p className="image-dropzone-text">{dropzoneText()}</p>
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
