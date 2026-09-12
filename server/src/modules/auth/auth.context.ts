import { prisma } from "../../db/prisma.js";

/**
 * Ngữ cảnh phân quyền của một request.
 * Vai trò được gán theo cửa hàng; storeId để trống nghĩa là vai trò bao
 * toàn chuỗi (contract §4.2, §2.8).
 */
export class AuthContext {
  readonly userId: string;
  readonly username: string;
  readonly fullName: string;
  readonly sessionId: string;
  readonly mustChangePassword: boolean;
  readonly defaultStoreId: string | null;
  readonly chainPermissions: ReadonlySet<string>;
  readonly storePermissions: ReadonlyMap<string, ReadonlySet<string>>;

  /** Cửa hàng của request hiện tại, lấy từ header X-Store-Id. */
  storeId: string | null = null;

  constructor(init: {
    userId: string;
    username: string;
    fullName: string;
    sessionId: string;
    mustChangePassword: boolean;
    defaultStoreId: string | null;
    chainPermissions: Set<string>;
    storePermissions: Map<string, Set<string>>;
  }) {
    this.userId = init.userId;
    this.username = init.username;
    this.fullName = init.fullName;
    this.sessionId = init.sessionId;
    this.mustChangePassword = init.mustChangePassword;
    this.defaultStoreId = init.defaultStoreId;
    this.chainPermissions = init.chainPermissions;
    this.storePermissions = init.storePermissions;
  }

  /** Các cửa hàng người dùng được gán vai trò trực tiếp. */
  get assignedStoreIds(): string[] {
    return [...this.storePermissions.keys()];
  }

  /** Có vai trò bao toàn chuỗi thì vào được mọi cửa hàng. */
  get hasChainRole(): boolean {
    return this.chainPermissions.size > 0;
  }

  /** Quyền hiệu lực bên trong một cửa hàng: quyền toàn chuỗi cộng quyền tại cửa hàng đó. */
  permissionsForStore(storeId: string): Set<string> {
    return new Set([...this.chainPermissions, ...(this.storePermissions.get(storeId) ?? [])]);
  }

  /** Quyền hiệu lực cho endpoint dùng chung toàn chuỗi: hợp của mọi phạm vi. */
  allPermissions(): Set<string> {
    const all = new Set(this.chainPermissions);
    for (const permissions of this.storePermissions.values()) {
      for (const permission of permissions) all.add(permission);
    }
    return all;
  }

  /**
   * Kiểm tra quyền. Nếu request đang ở trong phạm vi một cửa hàng thì chỉ
   * tính quyền hiệu lực tại cửa hàng đó, không tính quyền ở cửa hàng khác.
   */
  can(permission: string): boolean {
    return this.storeId
      ? this.permissionsForStore(this.storeId).has(permission)
      : this.allPermissions().has(permission);
  }

  canAccessStore(storeId: string): boolean {
    return this.hasChainRole || this.storePermissions.has(storeId);
  }
}

/** Đọc vai trò và quyền của người dùng từ CSDL. */
export async function loadAuthContext(
  userId: string,
  sessionId: string,
): Promise<AuthContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      userRoles: { include: { role: { include: { permissions: true } } } },
    },
  });

  if (!user || !user.isActive) return null;

  const chainPermissions = new Set<string>();
  const storePermissions = new Map<string, Set<string>>();

  for (const assignment of user.userRoles) {
    const codes = assignment.role.permissions.map((item) => item.permissionCode);
    if (assignment.storeId === null) {
      for (const code of codes) chainPermissions.add(code);
      continue;
    }
    const bucket = storePermissions.get(assignment.storeId) ?? new Set<string>();
    for (const code of codes) bucket.add(code);
    storePermissions.set(assignment.storeId, bucket);
  }

  return new AuthContext({
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    sessionId,
    mustChangePassword: user.mustChangePassword,
    defaultStoreId: user.defaultStoreId,
    chainPermissions,
    storePermissions,
  });
}
