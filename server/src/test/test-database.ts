/**
 * Test xóa sạch mọi bảng trước mỗi ca, nên chỉ chạy trên CSDL có tên kết thúc
 * bằng `_test`. Trỏ nhầm sang CSDL demo hay CSDL thật thì dừng ngay, không
 * test nào chạy và không bảng nào bị xóa.
 */
export function assertTestDatabaseName(name: string): void {
  if (!name.endsWith("_test")) {
    throw new Error(
      `CSDL kiểm thử phải có tên kết thúc bằng _test (đang trỏ tới "${name}"); test sẽ xóa sạch dữ liệu của nó`,
    );
  }
}

/** Chuỗi kết nối CSDL kiểm thử lấy từ DATABASE_URL_TEST, đã kiểm tên. */
export function testDatabaseUrl(): string {
  const url = process.env["DATABASE_URL_TEST"];
  if (!url) throw new Error("Thiếu DATABASE_URL_TEST trong server/.env");
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    // Chuỗi kết nối hỏng: để tên rỗng, phần kiểm bên dưới báo lỗi.
  }
  assertTestDatabaseName(name);
  return url;
}
