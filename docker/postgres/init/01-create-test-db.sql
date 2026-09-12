-- Chạy một lần duy nhất khi container tạo dữ liệu lần đầu.
-- Tạo sẵn CSDL riêng cho kiểm thử tích hợp, để test xóa sạch dữ liệu
-- mà không đụng vào CSDL đang phát triển.
CREATE DATABASE pharmacy_gpp_test OWNER gpp;

-- Các extension (unaccent, pg_trgm) và hàm f_unaccent nằm trong
-- migration của ứng dụng, không đặt ở đây, để mọi môi trường đều
-- được tạo bằng cùng một chuỗi migration. Xem docs/erd.md §1.6.
