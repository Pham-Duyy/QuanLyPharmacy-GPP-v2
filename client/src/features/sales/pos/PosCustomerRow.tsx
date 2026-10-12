import { EditOutlined, UserAddOutlined, UserOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { AutoComplete, Button, Input } from "antd";
import { http } from "../../../api/http.js";
import type { CustomerSearchItem, Envelope } from "../../../api/types.js";
import { useDebounced } from "../../../ui/useDebounced.js";

import type { Customer } from "./sale-cart.js";

/** Che bớt số điện thoại khi hiển thị ở quầy (kết quả tìm kiếm đã che sẵn từ máy chủ). */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.includes("*") || phone.length < 8) return phone;
  return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
}

/** Khách của đơn: tìm theo tên hoặc số điện thoại, hoặc thêm khách mới. */
export function PosCustomerRow({
  customer,
  onChange,
  search,
  onSearchChange,
  onAddNew,
}: {
  customer: Customer | null;
  onChange: (customer: Customer | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onAddNew?: () => void;
}) {
  const customerTerm = useDebounced(search.trim(), 250);

  // Chỉ tìm khi gõ đủ 3 ký tự, khớp đúng quy tắc GET /customers (contract §11).
  const customerSearchResults = useQuery({
    queryKey: ["customer-search", customerTerm],
    enabled: customerTerm.length >= 3,
    queryFn: async () =>
      (
        await http.get<Envelope<CustomerSearchItem[]>>("/customers", {
          params: { search: customerTerm },
        })
      ).data.data,
  });

  return (
    <div className="pos-attach-row">
      {customer ? (
        <div className="pos-field">
          <UserOutlined />
          <strong>{customer.fullName ?? "Khách chưa có tên"}</strong>
          <span className="muted">{maskPhone(customer.phone) ?? "Không có SĐT"}</span>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            aria-label="Đổi khách hàng"
            onClick={() => onChange(null)}
          />
        </div>
      ) : (
        <AutoComplete
          className="pos-field-input"
          value={search}
          onChange={onSearchChange}
          options={(customerSearchResults.data ?? []).map((item) => ({
            value: item.id,
            label: `${item.fullName ?? "Chưa rõ tên"}${item.phone ? ` · ${item.phone}` : ""}`,
          }))}
          onSelect={(id) => {
            const found = customerSearchResults.data?.find((item) => item.id === id);
            if (found) onChange(found);
            onSearchChange("");
          }}
          notFoundContent={
            customerTerm.length >= 3 && !customerSearchResults.isFetching
              ? "Không tìm thấy khách"
              : null
          }
        >
          <Input
            prefix={<UserOutlined />}
            placeholder="Khách lẻ · tìm tên hoặc SĐT (≥ 3 ký tự)"
            allowClear
            aria-label="Tìm khách hàng"
          />
        </AutoComplete>
      )}
      {onAddNew ? (
        <Button icon={<UserAddOutlined />} onClick={onAddNew}>
          Thêm khách hàng
        </Button>
      ) : null}
    </div>
  );
}
