type StoreAccess = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  permissions: string[];
  /** Chức năng đã bật ở cửa hàng này. */
  features?: { einvoice: boolean; nationalSync: boolean };
};

export type Me = {
  user: {
    id: string;
    username: string;
    fullName: string;
    mustChangePassword: boolean;
    defaultStoreId: string | null;
    /** Đã bật xác thực hai lớp (Phase 7, D31). */
    mfaEnabled?: boolean;
    /** Quản lý chưa bật MFA trong khi chủ nhà thuốc bắt buộc: phải bật trước khi dùng. */
    mfaSetupRequired?: boolean;
  };
  chainPermissions: string[];
  /** storeId rỗng nghĩa là vai trò bao toàn chuỗi. */
  roles: Array<{ code: string; name: string; storeId: string | null }>;
  stores: StoreAccess[];
};
