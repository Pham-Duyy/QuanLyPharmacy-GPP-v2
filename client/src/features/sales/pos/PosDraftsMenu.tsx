import { DeleteOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";
import { formatDateTime } from "../../../ui/format.js";

import type { SaleDraft as SaleDraftType } from "./drafts.js";

/** Danh sách đơn nháp lưu trên máy: bấm để mở lại, nút thùng rác để xóa. */
export function PosDraftsMenu({
  drafts,
  loading,
  onOpen,
  onRemove,
}: {
  drafts: SaleDraftType[];
  loading: boolean;
  onOpen: (draft: SaleDraftType) => void;
  onRemove: (id: string) => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      menu={{
        items: drafts.map((draft) => ({
          key: draft.id,
          label: (
            <span className="pos-draft-item">
              <strong>{draft.customer?.fullName ?? "Khách lẻ"}</strong>
              <small>
                {draft.lines.length} sản phẩm · {formatDateTime(draft.savedAt)}
              </small>
            </span>
          ),
          extra: (
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label="Xóa đơn nháp"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(draft.id);
              }}
            />
          ),
        })),
        onClick: ({ key }) => {
          const draft = drafts.find((item) => item.id === key);
          if (draft) onOpen(draft);
        },
      }}
    >
      <Button type="text" icon={<FileTextOutlined />} loading={loading}>
        Đơn nháp ({drafts.length})
      </Button>
    </Dropdown>
  );
}
