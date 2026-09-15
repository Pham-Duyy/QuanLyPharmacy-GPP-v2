export type StoreAccess = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  permissions: string[];
};

export type Me = {
  user: {
    id: string;
    username: string;
    fullName: string;
    mustChangePassword: boolean;
    defaultStoreId: string | null;
  };
  chainPermissions: string[];
  /** storeId rỗng nghĩa là vai trò bao toàn chuỗi. */
  roles: Array<{ code: string; name: string; storeId: string | null }>;
  stores: StoreAccess[];
};
