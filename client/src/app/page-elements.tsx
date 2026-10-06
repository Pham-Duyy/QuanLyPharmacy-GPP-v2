import { lazy } from "react";
import type { ComponentType, ReactNode } from "react";
import type { PagePath } from "./pages.js";

/** Tải từng trang khi cần để lần mở đầu tiên nhẹ hơn. */
function page<K extends string>(loader: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(async () => ({ default: (await loader())[name] }));
}

const DashboardPage = page(() => import("../features/dashboard/DashboardPage.js"), "DashboardPage");
const SalePage = page(() => import("../features/sales/SalePage.js"), "SalePage");
const InvoicesPage = page(() => import("../features/sales/InvoicesPage.js"), "InvoicesPage");
const ReturnsPage = page(() => import("../features/sales/ReturnsPage.js"), "ReturnsPage");
const PrescriptionsPage = page(() => import("../features/prescriptions/PrescriptionsPage.js"), "PrescriptionsPage");
const EInvoicesPage = page(() => import("../features/einvoice/EInvoicesPage.js"), "EInvoicesPage");
const CustomersPage = page(() => import("../features/customers/CustomersPage.js"), "CustomersPage");
const ProductsPage = page(() => import("../features/catalog/ProductsPage.js"), "ProductsPage");
const CatalogDataPage = page(() => import("../features/catalog/CatalogDataPage.js"), "CatalogDataPage");
const ProductImagesBulkPage = page(() => import("../features/catalog/ProductImagesBulkPage.js"), "ProductImagesBulkPage");
const SuppliersPage = page(() => import("../features/catalog/SuppliersPage.js"), "SuppliersPage");
const GoodsReceiptsPage = page(() => import("../features/inventory/GoodsReceiptsPage.js"), "GoodsReceiptsPage");
const BatchesPage = page(() => import("../features/inventory/BatchesPage.js"), "BatchesPage");
const AlertsPage = page(() => import("../features/inventory/AlertsPage.js"), "AlertsPage");
const StockAdjustmentsPage = page(() => import("../features/inventory/StockAdjustmentsPage.js"), "StockAdjustmentsPage");
const StorageLogsPage = page(() => import("../features/inventory/StorageLogsPage.js"), "StorageLogsPage");
const UsersPage = page(() => import("../features/users/UsersPage.js"), "UsersPage");
const StoresPage = page(() => import("../features/stores/StoresPage.js"), "StoresPage");
const AuditLogPage = page(() => import("../features/audit/AuditLogPage.js"), "AuditLogPage");
const SettingsPage = page(() => import("../features/settings/SettingsPage.js"), "SettingsPage");
const ControlledDrugsPage = page(() => import("../features/controlled/ControlledDrugsPage.js"), "ControlledDrugsPage");
const LabelsPage = page(() => import("../features/printing/LabelsPage.js"), "LabelsPage");
const SupplierReturnsPage = page(() => import("../features/inventory/SupplierReturnsPage.js"), "SupplierReturnsPage");
const SupplierDebtsPage = page(() => import("../features/inventory/SupplierDebtsPage.js"), "SupplierDebtsPage");
const ExpiryAlertsPage = page(() => import("../features/inventory/ExpiryAlertsPage.js"), "ExpiryAlertsPage");
const PurchaseSuggestionsPage = page(() => import("../features/inventory/PurchaseSuggestionsPage.js"), "PurchaseSuggestionsPage");
const StockCountsPage = page(() => import("../features/inventory/stock-counts/StockCountsPage.js"), "StockCountsPage");
const ExcelHubPage = page(() => import("../features/excel/ExcelHubPage.js"), "ExcelHubPage");
const NationalSyncPage = page(() => import("../features/national-sync/NationalSyncPage.js"), "NationalSyncPage");
const RecallsPage = page(() => import("../features/recalls/RecallsPage.js"), "RecallsPage");
const ReportsPage = page(() => import("../features/reports/ReportsPage.js"), "ReportsPage");

/**
 * Thành phần của từng trang đã đăng ký. Kiểu `Record<PagePath, …>` bắt buộc
 * đủ và đúng: thiếu một trang đã đăng ký hay thêm một đường dẫn chưa đăng ký
 * đều là lỗi biên dịch, nên route và danh sách đăng ký không thể lệch nhau.
 */
export const PAGE_ELEMENTS: Record<PagePath, ReactNode> = {
  "/tai-khoan": <DashboardPage />,
  "/ban-hang": <SalePage />,
  "/khach-hang": <CustomersPage />,
  "/bao-cao": <ReportsPage />,
  "/hoa-don": <InvoicesPage />,
  "/tra-hang": <ReturnsPage />,
  "/hoa-don-dien-tu": <EInvoicesPage />,
  "/don-thuoc": <PrescriptionsPage />,
  "/san-pham": <ProductsPage />,
  "/ton-kho": <BatchesPage />,
  "/kiem-ke": <StockCountsPage />,
  "/dieu-chinh-ton": <StockAdjustmentsPage />,
  "/can-han": <ExpiryAlertsPage />,
  "/canh-bao": <AlertsPage />,
  "/anh-san-pham": <ProductImagesBulkPage />,
  "/in-tem": <LabelsPage />,
  "/danh-muc": <CatalogDataPage />,
  "/phieu-nhap": <GoodsReceiptsPage />,
  "/de-xuat-dat-hang": <PurchaseSuggestionsPage />,
  "/tra-hang-ncc": <SupplierReturnsPage />,
  "/cong-no-ncc": <SupplierDebtsPage />,
  "/nha-cung-cap": <SuppliersPage />,
  "/kiem-soat-dac-biet": <ControlledDrugsPage />,
  "/so-nhiet-do": <StorageLogsPage />,
  "/thu-hoi": <RecallsPage />,
  "/lien-thong-duoc": <NationalSyncPage />,
  "/nhan-vien": <UsersPage />,
  "/cua-hang": <StoresPage />,
  "/cai-dat": <SettingsPage />,
  "/audit-log": <AuditLogPage />,
  "/excel": <ExcelHubPage />,
};
