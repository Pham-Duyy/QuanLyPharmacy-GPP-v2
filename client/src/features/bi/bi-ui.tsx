import type { UseQueryResult } from "@tanstack/react-query";
import { Alert, Skeleton } from "antd";
import type { ReactNode } from "react";
import { getErrorMessage } from "../../api/http.js";

/** Dùng chung cho các khối Bảng điều hành (tách riêng để fast refresh chạy đúng). */

/** Bảng cuộn ngang trong khung trên màn hẹp thay vì làm tràn cả trang. */
export const TABLE_SCROLL = { x: 680 };

/** Đang tải hoặc lỗi: cùng một kiểu cho mọi khối. Trả null khi đã có dữ liệu. */
export function queryState(query: UseQueryResult<unknown>): ReactNode {
  if (query.isError) return <Alert type="warning" showIcon title={getErrorMessage(query.error)} />;
  if (!query.data) return <Skeleton active paragraph={{ rows: 4 }} />;
  return null;
}
