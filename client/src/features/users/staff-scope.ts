import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider.js";

/** Giá trị đại diện cho phạm vi toàn chuỗi trong các ô chọn (máy chủ nhận null). */
export const CHAIN_SCOPE = "__chain__";

/**
 * Phạm vi người dùng hiện tại được phép giao vai trò. Chỉ dùng để hiển thị
 * lựa chọn; máy chủ kiểm tra lại đúng luật này ở POST /users và
 * PUT /users/{id}/roles.
 */
export function useManagedScopes() {
  const { me } = useAuth();
  return useMemo(() => {
    const canChain = me?.chainPermissions.includes("user.manage") ?? false;
    const stores = (me?.stores ?? []).filter(
      (store) => canChain || store.permissions.includes("user.manage"),
    );
    return { canChain, stores };
  }, [me]);
}

export function scopeToStoreId(scope: string): string | null {
  return scope === CHAIN_SCOPE ? null : scope;
}

export function storeIdToScope(storeId: string | null): string {
  return storeId ?? CHAIN_SCOPE;
}
