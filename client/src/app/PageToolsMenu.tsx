import { DownOutlined, ToolOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";
import { useNavigate } from "react-router";
import { useAuth } from "../features/auth/AuthProvider.js";
import { findPage, pageAccess } from "./access.js";
import { confirmLeave } from "./leave-guard.js";
import type { PagePath } from "./pages.js";

type Props = {
  /** Các trang công cụ gắn với màn hình này, theo thứ tự hiển thị. */
  paths: readonly PagePath[];
  label?: string;
};

/**
 * Lối vào các công cụ phụ ngay tại màn nghiệp vụ, thay cho việc đặt chúng
 * ngang hàng trên sidebar. Nhãn, biểu tượng và quyền lấy từ danh sách đăng ký
 * trang: công cụ nào không được phép thì không hiện, không còn công cụ nào
 * thì ẩn luôn cả nút.
 */
export function PageToolsMenu({ paths, label = "Công cụ" }: Props) {
  const { can } = useAuth();
  const navigate = useNavigate();

  const items = paths
    .filter((path) => pageAccess(path, can) === "allowed")
    .map((path) => findPage(path)!)
    .map((page) => ({ key: page.path, icon: page.icon, label: page.label }));

  if (items.length === 0) return null;

  return (
    <Dropdown
      trigger={["click"]}
      menu={{ items, onClick: ({ key }) => confirmLeave(() => void navigate(key)) }}
    >
      <Button icon={<ToolOutlined />}>
        {label} <DownOutlined />
      </Button>
    </Dropdown>
  );
}
