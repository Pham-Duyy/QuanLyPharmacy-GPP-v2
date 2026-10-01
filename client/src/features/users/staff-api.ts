import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "../../api/http.js";
import type { Envelope, RoleItem, StoreDetail, UserDetail, UserListItem } from "../../api/types.js";

/**
 * Adapter API thật của phân mục Nhân viên (contract §21). Chỉ có tài khoản và
 * phân quyền; lịch làm, chấm công, thưởng, lương, đánh giá chưa có API — các
 * phần đó nằm trong bản xem trước ở ./preview, không đi qua file này.
 */

export type NewRoleAssignment = {
  roleCode: string;
  /** null = toàn chuỗi, phải được chọn rõ trong form. */
  storeId: string | null;
  qualificationReference?: string | null;
};

export type CreateStaffInput = {
  username: string;
  fullName: string;
  phone?: string | null;
  practiceCertificateNumber?: string | null;
  defaultStoreId?: string | null;
  password: string;
  mustChangePassword: boolean;
  roles: NewRoleAssignment[];
};

export const staffKeys = {
  list: ["users"] as const,
  detail: (id: string) => ["user", id] as const,
  roles: ["all-roles"] as const,
  stores: ["all-stores"] as const,
};

export function useStaffList() {
  return useQuery({
    queryKey: staffKeys.list,
    queryFn: async () => (await http.get<Envelope<UserListItem[]>>("/users")).data.data,
  });
}

export function useStaffDetail(id: string | null) {
  return useQuery({
    queryKey: id ? staffKeys.detail(id) : ["user", "none"],
    enabled: id !== null,
    queryFn: async () => (await http.get<Envelope<UserDetail>>(`/users/${id}`)).data.data,
  });
}

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: staffKeys.roles,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => (await http.get<Envelope<RoleItem[]>>("/roles")).data.data,
  });
}

/** Các cửa hàng người dùng hiện tại được phép làm việc (đã lọc phía máy chủ). */
export function useStores(enabled = true) {
  return useQuery({
    queryKey: staffKeys.stores,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (await http.get<Envelope<{ items: StoreDetail[] }>>("/stores")).data.data.items,
  });
}

/**
 * Tạo tài khoản, mật khẩu và phân quyền trong MỘT yêu cầu; máy chủ làm trong
 * một giao dịch nên không có trạng thái "tạo được tài khoản nhưng gán quyền lỗi".
 */
export function useCreateStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStaffInput) =>
      (await http.post<Envelope<UserDetail>>("/users", input)).data.data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: staffKeys.list });
    },
  });
}
