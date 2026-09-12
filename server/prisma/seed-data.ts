/**
 * Dữ liệu nền: danh sách permission và ma trận vai trò.
 * Nguồn duy nhất là docs/api-contract.md §4.1 và §4.2.
 * Sửa ma trận ở đây rồi chạy lại seed, không viết cứng quyền trong mã nghiệp vụ.
 */

export const PERMISSIONS: Array<{ code: string; description: string }> = [
  { code: "store.manage", description: "Tạo, sửa, ngừng hoạt động cửa hàng trong chuỗi" },
  { code: "user.manage", description: "Quản lý tài khoản, vai trò" },
  { code: "report.chain", description: "Xem báo cáo hợp nhất toàn chuỗi" },
  { code: "catalog.read", description: "Xem danh mục sản phẩm, nhóm, đơn vị, hoạt chất, nhà cung cấp" },
  { code: "catalog.manage", description: "Tạo, sửa, ngừng dùng danh mục" },
  { code: "price.manage", description: "Tạo phiên bản giá mới" },
  { code: "stock.read", description: "Xem tồn kho, lô, thẻ kho" },
  { code: "stock.cost.read", description: "Xem giá vốn" },
  { code: "goods_receipt.read", description: "Xem phiếu nhập" },
  { code: "goods_receipt.create", description: "Tạo, sửa phiếu nhập nháp" },
  { code: "goods_receipt.confirm", description: "Xác nhận phiếu nhập, hủy phiếu nháp" },
  { code: "stock.adjust.create", description: "Lập phiếu điều chỉnh tồn" },
  { code: "stock.adjust.approve", description: "Duyệt, từ chối phiếu điều chỉnh" },
  { code: "stock.opening_balance", description: "Nhập tồn đầu kỳ" },
  { code: "batch.quarantine", description: "Biệt trữ, mở khóa lô" },
  { code: "recall.manage", description: "Tạo, đóng thông báo thu hồi" },
  { code: "invoice.read", description: "Xem hóa đơn, phiếu trả" },
  { code: "invoice.create", description: "Bán hàng, chạy kiểm tra an toàn" },
  { code: "invoice.void", description: "Hủy hóa đơn" },
  { code: "sale.prescription_drug", description: "Bán thuốc kê đơn và thuốc kiểm soát đặc biệt" },
  { code: "sale.batch_override", description: "Chỉ định lô khác thứ tự FEFO" },
  { code: "sale.discount", description: "Giảm giá trong hạn mức của vai trò" },
  { code: "sale.discount.override", description: "Giảm giá vượt hạn mức" },
  { code: "safety.ack", description: "Ghi nhận cảnh báo an toàn mức cao để tiếp tục bán" },
  { code: "return.create", description: "Nhận trả hàng" },
  { code: "prescription.read", description: "Xem đơn thuốc" },
  { code: "prescription.create", description: "Tạo, sửa đơn thuốc nháp, tải ảnh đơn" },
  { code: "prescription.verify", description: "Xác nhận hoặc từ chối đơn thuốc" },
  { code: "customer.read", description: "Xem thông tin cơ bản của khách" },
  { code: "customer.manage", description: "Tạo, sửa thông tin cơ bản của khách" },
  { code: "customer.sensitive", description: "Đọc, ghi hồ sơ sức khỏe và lịch sử mua của khách" },
  { code: "storage_log.read", description: "Xem sổ nhiệt độ và độ ẩm" },
  { code: "storage_log.write", description: "Ghi sổ nhiệt độ và độ ẩm" },
  { code: "report.sales", description: "Báo cáo doanh thu, bán chạy" },
  { code: "report.inventory", description: "Báo cáo xuất nhập tồn, hạn dùng" },
  { code: "audit.read", description: "Đọc audit log" },
  { code: "ai.use", description: "Dùng tính năng AI" },
];

export const ROLES: Array<{ code: string; name: string; permissions: string[] }> = [
  {
    code: "admin",
    name: "Chủ nhà thuốc, quản lý",
    permissions: [
      "store.manage", "user.manage", "report.chain", "catalog.read", "catalog.manage",
      "price.manage", "stock.read", "stock.cost.read", "goods_receipt.read",
      "goods_receipt.create", "goods_receipt.confirm", "stock.adjust.create",
      "stock.adjust.approve", "stock.opening_balance", "batch.quarantine", "recall.manage",
      "invoice.read", "invoice.create", "invoice.void", "sale.discount",
      "sale.discount.override", "return.create", "customer.read", "customer.manage",
      "storage_log.read", "report.sales", "report.inventory", "audit.read",
    ],
  },
  {
    code: "pharmacist",
    name: "Dược sĩ phụ trách chuyên môn",
    permissions: [
      "catalog.read", "catalog.manage", "stock.read", "goods_receipt.read",
      "goods_receipt.create", "goods_receipt.confirm", "stock.adjust.create",
      "stock.adjust.approve", "batch.quarantine", "recall.manage", "invoice.read",
      "invoice.create", "invoice.void", "sale.prescription_drug", "sale.batch_override",
      "sale.discount", "safety.ack", "return.create", "prescription.read",
      "prescription.create", "prescription.verify", "customer.read", "customer.manage",
      "customer.sensitive", "storage_log.read", "storage_log.write", "report.inventory",
      "ai.use",
    ],
  },
  {
    code: "sales_staff",
    name: "Nhân viên bán hàng",
    permissions: [
      "catalog.read", "stock.read", "invoice.read", "invoice.create", "sale.discount",
      "prescription.read", "prescription.create", "customer.read", "customer.manage",
      "ai.use",
    ],
  },
  {
    code: "warehouse_staff",
    name: "Nhân viên kho",
    permissions: [
      "catalog.read", "stock.read", "goods_receipt.read", "goods_receipt.create",
      "stock.adjust.create", "storage_log.read", "storage_log.write",
    ],
  },
  {
    code: "auditor",
    name: "Kiểm toán, chỉ đọc",
    permissions: [
      "catalog.read", "stock.read", "stock.cost.read", "goods_receipt.read",
      "invoice.read", "storage_log.read", "report.sales", "report.inventory",
      "report.chain", "audit.read",
    ],
  },
];
