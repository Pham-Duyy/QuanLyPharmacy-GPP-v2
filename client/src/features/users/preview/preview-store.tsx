import { useMemo, useReducer, type ReactNode } from "react";
import { PreviewContext } from "./preview-context.js";
import { initialPreviewState } from "./preview-fixtures.js";
import { previewReducer } from "./preview-reducer.js";

/**
 * Trạng thái của bản xem trước, sống trong bộ nhớ trang. Đặt phía trên các
 * tab nên đổi tab không mất thao tác; tải lại trang thì về dữ liệu mẫu ban
 * đầu. Không ghi localStorage, không gọi API, không giữ mật khẩu.
 */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(previewReducer, undefined, initialPreviewState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}
