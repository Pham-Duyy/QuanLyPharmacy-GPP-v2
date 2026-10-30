-- Nguồn dữ liệu PostgreSQL cho analytics-service (Pharmacy Intelligent Analytics, Phase 5
-- bước 5.5; quyết định D22). Bốn view chỉ đọc, cột trùng schema tệp medicines / sales /
-- inventory (docs/analytics/data-schema.md), để analytics-service đọc thẳng dữ liệu phần mềm
-- thay cho tệp Excel. Không lộ thông tin khách hàng: không có cột khách, người bán.
-- Tài khoản chỉ đọc: server/prisma/sql/analytics-reader.sql (quản trị tự chạy, tự đặt mật khẩu).

CREATE SCHEMA IF NOT EXISTS analytics_src;

-- Danh mục: đơn vị bán nhỏ nhất (quy đổi 1); quy cách và nhà cung cấp theo phiếu nhập đã kiểm gần nhất.
CREATE VIEW analytics_src.medicines AS
SELECT
  p.code AS medicine_code,
  p.name AS medicine_name,
  c.name AS category,
  base_unit.name AS unit,
  CASE WHEN p.drug_class IN ('RX', 'CONTROLLED') THEN 'Y' ELSE 'N' END AS is_prescription,
  NULLIF(p.min_stock_base_quantity, 0) AS min_stock,
  NULL::integer AS max_stock,
  last_receipt.conversion_to_base AS pack_size,
  NULL::integer AS lead_time_days,
  last_receipt.supplier AS supplier
FROM products p
JOIN categories c ON c.id = p.category_id
LEFT JOIN LATERAL (
  SELECT u.name FROM product_units u
  WHERE u.product_id = p.id AND u.conversion_to_base = 1
  ORDER BY u.is_default_sale_unit DESC, u.created_at
  LIMIT 1
) base_unit ON TRUE
LEFT JOIN LATERAL (
  SELECT u.conversion_to_base, s.name AS supplier
  FROM goods_receipt_lines l
  JOIN goods_receipts r ON r.id = l.goods_receipt_id AND r.status = 'CONFIRMED'
  JOIN product_units u ON u.id = l.product_unit_id
  LEFT JOIN suppliers s ON s.id = r.supplier_id
  WHERE l.product_id = p.id
  ORDER BY r.received_at DESC, l.line_no
  LIMIT 1
) last_receipt ON TRUE
WHERE p.is_active;

-- Bán hàng: hóa đơn hoàn tất (bỏ hóa đơn hủy), số lượng đã trừ phần khách trả lại, tính theo
-- đơn vị nhỏ nhất. Giá bán một đơn vị = thành tiền dòng / số lượng; thành tiền dòng đã gồm phần
-- giảm giá cả hóa đơn và tiền đổi điểm được phân bổ về dòng (invoices.service). Giá vốn = bình quân giá vốn các lô đã xuất (trống nếu có lô chưa rõ giá).
-- Giờ bán theo giờ Việt Nam, không múi giờ (cùng kiểu với tệp Excel).
CREATE VIEW analytics_src.sales AS
SELECT
  i.code AS sale_id,
  l.line_no,
  (i.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS sale_datetime,
  'retail'::text AS sale_type,
  s.code AS store_code,
  p.code AS medicine_code,
  alloc.batch_code,
  (l.base_quantity - COALESCE(alloc.returned, 0))::integer AS quantity,
  round(l.line_total::numeric / l.base_quantity, 2) AS selling_price,
  CASE WHEN alloc.quantity > 0 AND alloc.costed = alloc.quantity
    THEN round(alloc.cost / alloc.quantity, 2) END AS purchase_price,
  CASE i.payment_method WHEN 'CASH' THEN 'cash' WHEN 'BANK_TRANSFER' THEN 'transfer' WHEN 'CARD' THEN 'card' END
    AS payment_method
FROM invoices i
JOIN stores s ON s.id = i.store_id
JOIN invoice_lines l ON l.invoice_id = i.id
JOIN products p ON p.id = l.product_id
LEFT JOIN LATERAL (
  SELECT
    sum(a.base_quantity) AS quantity,
    sum(a.returned_base_quantity) AS returned,
    sum(a.base_quantity) FILTER (WHERE a.unit_cost IS NOT NULL) AS costed,
    sum(a.base_quantity * a.unit_cost) AS cost,
    CASE WHEN count(*) = 1 THEN max(b.batch_number) END AS batch_code
  FROM invoice_allocations a
  JOIN batches b ON b.id = a.batch_id
  WHERE a.invoice_line_id = l.id
) alloc ON TRUE
WHERE i.status = 'COMPLETED'
  AND l.base_quantity > 0
  AND l.base_quantity - COALESCE(alloc.returned, 0) > 0;

-- Tồn kho theo lô: chỉ lô đang bán được (bỏ lô biệt trữ, thu hồi) và còn hàng. Ngày nhập,
-- nhà cung cấp lấy từ phiếu nhập tạo ra lô (nếu có).
CREATE VIEW analytics_src.inventory AS
SELECT
  s.code AS store_code,
  p.code AS medicine_code,
  b.batch_number AS batch_code,
  b.quantity_on_hand AS quantity,
  b.expiry_date,
  b.unit_cost AS purchase_price,
  COALESCE(r.received_at, b.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh' AS received_date,
  sp.name AS supplier
FROM batches b
JOIN stores s ON s.id = b.store_id
JOIN products p ON p.id = b.product_id
LEFT JOIN goods_receipts r ON b.source_type = 'GOODS_RECEIPT' AND r.id = b.source_id
LEFT JOIN suppliers sp ON sp.id = r.supplier_id
WHERE b.status = 'AVAILABLE' AND b.quantity_on_hand > 0;

-- Mốc thay đổi: analytics-service hỏi ~30 giây một lần; đổi thì mới đọc lại bộ dữ liệu đó.
-- Mỗi mốc là vài phép đếm/max trên chỉ mục, rẻ hơn nhiều so với đọc cả view.
CREATE VIEW analytics_src.change_marker AS
SELECT
  md5(concat_ws('|',
    (SELECT count(*) FROM products), (SELECT max(updated_at) FROM products),
    (SELECT max(updated_at) FROM categories), (SELECT count(*) FROM product_units),
    (SELECT count(*) FROM goods_receipts WHERE status = 'CONFIRMED')
  )) AS medicines,
  md5(concat_ws('|',
    (SELECT count(*) FROM invoices), (SELECT max(created_at) FROM invoices),
    (SELECT max(voided_at) FROM invoices), (SELECT count(*) FROM returns)
  )) AS sales,
  md5(concat_ws('|',
    (SELECT count(*) FROM batches), (SELECT max(updated_at) FROM batches),
    (SELECT sum(quantity_on_hand) FROM batches)
  )) AS inventory;
