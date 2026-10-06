import { ClearOutlined, CloudUploadOutlined, PictureOutlined, UploadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Progress, Skeleton, Space, Table, Tag, Tooltip, Upload } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, Paged, ProductListItem } from "../../api/types.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import { matchImageFiles, type FileMatch, type MatchTarget } from "./products/match-image-files.js";
import { IMAGE_ACCEPT, MAX_IMAGES_PER_PRODUCT, uploadProductImage } from "./products/product-image-upload.js";
import { ProductThumb } from "./products/ProductThumb.js";

type RowStatus = "pending" | "uploading" | "done" | "error" | "skipped";

type Row = FileMatch & {
  previewUrl: string;
  hadImage: boolean;
  status: RowStatus;
  note: string | null;
};

const STATUS_TAG: Record<RowStatus, { color: string; label: string }> = {
  pending: { color: "default", label: "Chờ tải" },
  uploading: { color: "processing", label: "Đang tải" },
  done: { color: "success", label: "Đã tải" },
  error: { color: "error", label: "Lỗi" },
  skipped: { color: "warning", label: "Bỏ qua" },
};

/**
 * Tải ảnh cho nhiều sản phẩm trong một lượt: thả cả thư mục ảnh vào, phần
 * mềm ghép tên tệp với mã (hoặc tên) sản phẩm rồi tải lần lượt từng ảnh.
 *
 * Tải tuần tự chứ không song song: mỗi ảnh là một yêu cầu multipart vài trăm
 * KB, gửi ồ ạt vừa nghẽn đường truyền vừa dễ tranh nhau suất "ảnh chính".
 */
export function ProductImagesBulkPage() {
  const { storeId } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [directory, setDirectory] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Địa chỉ ảnh xem trước phải được thu hồi, nếu không trình duyệt giữ luôn tệp trong bộ nhớ.
  const previews = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const products = useQuery({
    queryKey: ["products", "bulk-images", storeId],
    queryFn: async ({ signal }) => {
      const all: ProductListItem[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          signal,
          params: { page, limit: 100, isActive: true, sortBy: "code", order: "asc" },
        });
        const { items, pagination } = response.data.data;
        all.push(...items);
        if (items.length === 0 || all.length >= pagination.total) break;
      }
      return all;
    },
  });

  const targets: MatchTarget[] = useMemo(
    () => (products.data ?? []).map((item) => ({ id: item.id, code: item.code, name: item.name })),
    [products.data],
  );
  const hasImage = useMemo(
    () => new Set((products.data ?? []).filter((item) => item.primaryImage).map((item) => item.id)),
    [products.data],
  );

  function pickFiles(files: File[]): void {
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current = [];
    const next = matchImageFiles(files, targets).map((match) => {
      const previewUrl = URL.createObjectURL(match.file);
      previews.current.push(previewUrl);
      return {
        ...match,
        previewUrl,
        hadImage: match.product ? hasImage.has(match.product.id) : false,
        status: (match.product ? "pending" : "skipped") as RowStatus,
        note: match.product ? null : "Tên tệp không trùng mã hay tên sản phẩm nào",
      };
    });
    setRows(next);
    setProgress(null);
  }

  function update(key: string, patch: Partial<Row>): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function runUpload(): Promise<void> {
    const queue = rows.filter((row) => row.product && row.status !== "done");
    if (queue.length === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: queue.length });

    // Ảnh đã có sẵn cũng tính vào trần 8 ảnh; server chặn lần nữa nếu lệch.
    const used = new Map<string, number>();
    let finished = 0;

    for (const row of queue) {
      const product = row.product!;
      const already = used.get(product.id) ?? (row.hadImage ? 1 : 0);
      if (already >= MAX_IMAGES_PER_PRODUCT) {
        update(row.key, { status: "skipped", note: `Mỗi sản phẩm tối đa ${MAX_IMAGES_PER_PRODUCT} ảnh` });
      } else {
        update(row.key, { status: "uploading", note: null });
        try {
          await uploadProductImage(product.id, row.file);
          used.set(product.id, already + 1);
          update(row.key, { status: "done", note: null });
        } catch (error) {
          const reason =
            error instanceof Error && !("isAxiosError" in error)
              ? error.message
              : getErrorMessage(error, "Không tải được ảnh");
          update(row.key, { status: "error", note: reason });
        }
      }
      finished += 1;
      setProgress({ done: finished, total: queue.length });
    }

    setRunning(false);
    await products.refetch();
  }

  function clearAll(): void {
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current = [];
    setRows([]);
    setProgress(null);
  }

  const matched = rows.filter((row) => row.product);
  const unmatched = rows.length - matched.length;
  const pending = matched.filter((row) => row.status !== "done").length;
  const uploaded = rows.filter((row) => row.status === "done").length;
  const failed = rows.filter((row) => row.status === "error").length;
  const withoutImage = (products.data ?? []).filter((item) => !item.primaryImage).length;

  return (
    <div>
      <PageHeader
        icon={<PictureOutlined />}
        title="Tải ảnh sản phẩm hàng loạt"
        extra={
          <Space wrap>
            <Button icon={<ClearOutlined />} onClick={clearAll} disabled={running || rows.length === 0}>
              Xóa danh sách
            </Button>
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => void runUpload()} loading={running} disabled={pending === 0}>
              Tải lên {pending > 0 ? `${pending} ảnh` : ""}
            </Button>
          </Space>
        }
      />

      <Alert
        type="info"
        showIcon
        title="Cách đặt tên tệp"
        description={
          <>
            Một ảnh cho mỗi mặt hàng: đặt tên tệp bằng <b>mã sản phẩm</b> — ví dụ <code>TH0019.jpg</code> — hoặc bằng{" "}
            <b>đúng tên sản phẩm</b> — <code>Amlodipin 5mg.jpg</code>. Muốn nhiều ảnh cho cùng một mặt hàng thì thêm số ở cuối:{" "}
            <code>TH0019-2.jpg</code>, <code>TH0019-3.jpg</code>. Nhận JPG, PNG, WEBP tối đa 15 MB mỗi ảnh; phần mềm tự thu nhỏ và xóa
            thông tin vị trí trong ảnh trước khi lưu. Ảnh đầu tiên của mỗi mặt hàng trở thành ảnh chính.
          </>
        }
        className="image-alert"
      />

      {products.isLoading ? <Skeleton active /> : null}
      {products.isError ? <Alert type="error" showIcon title="Không tải được danh mục sản phẩm" description={getErrorMessage(products.error, "Hãy thử lại")} /> : null}

      {products.data ? (
        <p className="image-rules">
          Danh mục có {products.data.length} mặt hàng đang kinh doanh, trong đó <b>{withoutImage}</b> mặt hàng chưa có ảnh nào.
        </p>
      ) : null}

      <Checkbox className="image-bulk-pick" checked={directory} disabled={running} onChange={(event) => setDirectory(event.target.checked)}>
        Chọn nguyên một thư mục ảnh (bỏ dấu nếu muốn chọn từng tệp)
      </Checkbox>

      <Upload.Dragger
        // Đổi kiểu chọn phải dựng lại ô thả: thuộc tính thư mục nằm trên thẻ input.
        key={directory ? "dir" : "files"}
        accept={IMAGE_ACCEPT.join(",")}
        multiple
        directory={directory}
        showUploadList={false}
        disabled={running || !products.data}
        beforeUpload={(file, fileList) => {
          if (file === fileList[0]) pickFiles(fileList);
          return false;
        }}
        className="image-dropzone"
      >
        <p className="image-dropzone-icon">
          <UploadOutlined />
        </p>
        <p className="image-dropzone-text">
          {directory ? "Bấm để chọn một thư mục ảnh, hoặc kéo thư mục vào đây" : "Bấm để chọn nhiều ảnh, hoặc kéo cả nhóm ảnh vào đây"}
        </p>
      </Upload.Dragger>

      {progress ? (
        <Progress
          percent={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
          status={running ? "active" : failed > 0 ? "exception" : "success"}
          format={() => `${uploaded}/${progress.total} ảnh${failed > 0 ? `, ${failed} lỗi` : ""}`}
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <p className="image-rules">
            Đã chọn {rows.length} tệp: ghép được {matched.length} ảnh
            {unmatched > 0 ? `, ${unmatched} tệp không khớp mặt hàng nào` : ""}.
          </p>
          <Table<Row>
            dataSource={rows}
            rowKey="key"
            size="small"
            pagination={rows.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
            columns={[
              {
                title: "Ảnh",
                dataIndex: "previewUrl",
                width: 72,
                render: (_value, row) => <ProductThumb src={row.previewUrl} alt={row.file.name} size={48} />,
              },
              {
                title: "Tệp",
                dataIndex: "key",
                render: (_value, row) => (
                  <>
                    <div>{row.file.name}</div>
                    <span className="muted">{Math.round(row.file.size / 1024)} KB</span>
                  </>
                ),
              },
              {
                title: "Ghép với mặt hàng",
                dataIndex: "product",
                render: (_value, row) =>
                  row.product ? (
                    <>
                      <div>
                        <b>{row.product.code}</b> — {row.product.name}
                      </div>
                      <Space size={4} wrap>
                        <Tag color={row.matchedBy === "code" ? "blue" : "purple"}>
                          {row.matchedBy === "code" ? "khớp theo mã" : "khớp theo tên"}
                        </Tag>
                        {row.hadImage ? (
                          <Tooltip title="Mặt hàng này đã có ảnh; ảnh mới được thêm vào, ảnh chính giữ nguyên">
                            <Tag>đã có ảnh</Tag>
                          </Tooltip>
                        ) : null}
                      </Space>
                    </>
                  ) : (
                    <span className="image-nomatch">Không khớp mặt hàng nào</span>
                  ),
              },
              {
                title: "Trạng thái",
                dataIndex: "status",
                width: 220,
                render: (_value, row) => (
                  <>
                    <Tag color={STATUS_TAG[row.status].color}>{STATUS_TAG[row.status].label}</Tag>
                    {row.note ? <div className="muted">{row.note}</div> : null}
                  </>
                ),
              },
            ]}
          />
        </>
      ) : null}

      {!running && progress && uploaded > 0 ? (
        <Alert
          type={failed > 0 ? "warning" : "success"}
          showIcon
          title={failed > 0 ? `Đã tải ${uploaded} ảnh, ${failed} ảnh lỗi` : `Đã tải xong ${uploaded} ảnh`}
          description="Ảnh hiện ngay trong danh mục và ở quầy bán hàng."
          action={
            <Link to="/san-pham">
              <Button size="small">Xem danh mục</Button>
            </Link>
          }
          className="image-alert"
        />
      ) : null}
    </div>
  );
}
