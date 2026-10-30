/**
 * Theo dõi trực tiếp một tệp Excel/CSV trên máy người dùng bằng File System
 * Access API: chọn tệp một lần, trang tự đọc lại khi tệp được lưu. Chỉ có
 * trên Chrome, Edge bản máy tính; trình duyệt khác vẫn tải tệp lên như thường.
 *
 * Handle của tệp được nhớ trong IndexedDB để tải lại trang vẫn tiếp tục được,
 * nhưng trình duyệt luôn hỏi lại quyền đọc sau khi tải lại trang.
 */

type PermissionMode = { mode: "read" };

/** Phần API chưa có trong lib.dom của TypeScript. */
export type WatchedFileHandle = FileSystemFileHandle & {
  queryPermission?: (descriptor: PermissionMode) => Promise<PermissionState>;
  requestPermission?: (descriptor: PermissionMode) => Promise<PermissionState>;
};

type OpenFilePicker = (options: {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<WatchedFileHandle[]>;

function picker(): OpenFilePicker | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { showOpenFilePicker?: OpenFilePicker })
    .showOpenFilePicker;
  return typeof candidate === "function" ? candidate.bind(window) : null;
}

export const canWatchFiles = picker() !== null;

/** Mở hộp chọn tệp; người dùng bấm Hủy thì trả null. */
export async function pickWatchedFile(): Promise<WatchedFileHandle | null> {
  const open = picker();
  if (!open) return null;
  try {
    const [handle] = await open({
      multiple: false,
      types: [
        {
          description: "Bảng tính Excel hoặc CSV",
          accept: {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
            "text/csv": [".csv"],
          },
        },
      ],
    });
    return handle ?? null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/** Sau khi tải lại trang phải xin lại quyền, và chỉ xin được trong lúc người dùng bấm. */
export async function ensureReadPermission(handle: WatchedFileHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

/** Dấu nhận biết tệp đã được lưu lại: đổi giờ sửa hoặc dung lượng. */
export function fileSignature(file: File): string {
  return `${file.lastModified}:${file.size}`;
}

// --- Nhớ tệp đang theo dõi ---------------------------------------------------

const DB_NAME = "gpp-analytics";
const STORE = "watched-file";
const KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Lưu không được (chế độ ẩn danh, chặn bộ nhớ trang) thì bỏ qua: chỉ mất tiện ích nhớ tệp. */
export async function rememberWatchedFile(handle: WatchedFileHandle | null): Promise<void> {
  try {
    if (handle) await withStore("readwrite", (store) => store.put(handle, KEY));
    else await withStore("readwrite", (store) => store.delete(KEY));
  } catch {
    // Bỏ qua.
  }
}

export async function recallWatchedFile(): Promise<WatchedFileHandle | null> {
  if (!canWatchFiles) return null;
  try {
    return ((await withStore("readonly", (store) => store.get(KEY))) as WatchedFileHandle) ?? null;
  } catch {
    return null;
  }
}
