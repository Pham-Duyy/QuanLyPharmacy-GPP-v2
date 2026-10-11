import { EnvironmentOutlined } from "@ant-design/icons";
import { AutoComplete, Input } from "antd";

/**
 * Ô nhập vị trí tủ–kệ–ngăn, gõ tự do kiểu A-02-03, gợi ý từ các vị trí cửa
 * hàng đang dùng để mọi người ghi giống nhau. Máy chủ tự viết hoa, bỏ khoảng
 * trắng thừa.
 */
export function ShelfLocationInput({
  value,
  onChange,
  locations,
  size,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  locations: string[];
  size?: "small" | "middle";
  autoFocus?: boolean;
}) {
  const query = value.trim().toUpperCase();
  return (
    <AutoComplete
      value={value}
      onChange={onChange}
      options={locations
        .filter((location) => !query || location.includes(query))
        .slice(0, 12)
        .map((location) => ({ value: location }))}
      style={{ width: "100%" }}
    >
      <Input
        size={size}
        autoFocus={autoFocus}
        maxLength={30}
        prefix={<EnvironmentOutlined />}
        placeholder="Tủ–kệ–ngăn, ví dụ A-02-03"
        aria-label="Vị trí tủ kệ ngăn"
      />
    </AutoComplete>
  );
}
