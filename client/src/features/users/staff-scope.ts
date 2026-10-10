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

/**
 * Khóa, đặt lại mật khẩu, sửa thông tin tác động lên cả tài khoản, nên chỉ
 * làm được khi quản lý nhân sự ở mọi nơi người đó có vai trò. Máy chủ kiểm
 * lại đúng luật này; ở đây chỉ để không hiện nút bấm vào sẽ bị từ chối.
 */
export function canManageAccount(
  scopes: { canChain: boolean; stores: ReadonlyArray<{ id: string }> },
  roles: ReadonlyArray<{ storeId: string | null }>,
): boolean {
  return (
    scopes.canChain ||
    roles.every(
      (role) => role.storeId !== null && scopes.stores.some((store) => store.id === role.storeId),
    )
  );
}

export function scopeToStoreId(scope: string): string | null {
  return scope === CHAIN_SCOPE ? null : scope;
}

export function storeIdToScope(storeId: string | null): string {
  return storeId ?? CHAIN_SCOPE;
}
