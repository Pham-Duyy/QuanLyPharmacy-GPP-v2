export type StoreAccess = {
  id: string;
  code: string;
  name: string;
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
  stores: StoreAccess[];
};
