"""Schema chuẩn của các tệp dữ liệu (docs/analytics/data-schema.md).

Schema là "hợp đồng" giữa nhà thuốc và hệ thống: tệp phải có những cột nào,
mỗi cột kiểu gì, cột nào bắt buộc. Mỗi cột có thêm vài tên gọi khác (alias)
để tệp ghi tiêu đề tiếng Việt như "Mã thuốc" vẫn đọc được.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ColumnType = Literal["code", "text", "int", "number", "datetime", "bool", "choice"]


@dataclass(frozen=True)
class ColumnSpec:
    name: str
    type: ColumnType
    required: bool
    description: str
    aliases: tuple[str, ...] = ()
    # Với type="choice": giá trị chuẩn -> các cách viết được chấp nhận.
    choices: dict[str, tuple[str, ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class DatasetSchema:
    name: str
    file_stem: str
    columns: tuple[ColumnSpec, ...]
    # Bộ cột xác định một dòng duy nhất; trùng là lỗi nhập trùng.
    key: tuple[str, ...]

    def column(self, name: str) -> ColumnSpec:
        return next(column for column in self.columns if column.name == name)


MEDICINES = DatasetSchema(
    name="medicines",
    file_stem="medicines",
    key=("medicine_code",),
    columns=(
        ColumnSpec("medicine_code", "code", True, "Mã thuốc, duy nhất", ("ma thuoc", "ma san pham", "ma")),
        ColumnSpec("medicine_name", "text", True, "Tên thuốc", ("ten thuoc", "ten san pham", "ten")),
        ColumnSpec("category", "text", True, "Nhóm thuốc", ("nhom thuoc", "nhom hang", "nhom", "danh muc")),
        ColumnSpec("unit", "text", True, "Đơn vị bán nhỏ nhất", ("don vi", "don vi tinh", "dvt")),
        ColumnSpec("manufacturer", "text", False, "Nhà sản xuất", ("nha san xuat", "hang san xuat")),
        ColumnSpec("is_prescription", "bool", False, "Thuốc kê đơn (Y/N)", ("ke don", "thuoc ke don")),
        ColumnSpec("min_stock", "int", False, "Tồn tối thiểu", ("ton toi thieu", "ton min")),
        ColumnSpec("max_stock", "int", False, "Tồn tối đa", ("ton toi da", "ton max")),
    ),
)

SALES = DatasetSchema(
    name="sales",
    file_stem="sales",
    key=("sale_id", "line_no"),
    columns=(
        ColumnSpec("sale_id", "code", True, "Mã hóa đơn", ("ma hoa don", "so hoa don", "hoa don")),
        ColumnSpec("line_no", "int", True, "Số thứ tự dòng trong hóa đơn", ("stt", "dong", "so dong")),
        ColumnSpec("sale_datetime", "datetime", True, "Ngày giờ bán", ("ngay ban", "thoi gian", "ngay gio ban", "ngay")),
        ColumnSpec(
            "sale_type",
            "choice",
            True,
            "Bán lẻ (retail) hay bán buôn (wholesale)",
            ("loai ban", "hinh thuc ban"),
            choices={
                "retail": ("retail", "ban le", "le"),
                "wholesale": ("wholesale", "ban buon", "buon", "ban si", "si"),
            },
        ),
        ColumnSpec("store_code", "code", True, "Mã cửa hàng", ("ma cua hang", "cua hang", "chi nhanh")),
        ColumnSpec("medicine_code", "code", True, "Mã thuốc", ("ma thuoc", "ma san pham")),
        ColumnSpec("batch_code", "code", False, "Số lô", ("so lo", "lo", "ma lo")),
        ColumnSpec("quantity", "number", True, "Số lượng (đơn vị nhỏ nhất)", ("so luong", "sl")),
        ColumnSpec("selling_price", "number", True, "Đơn giá bán sau giảm", ("don gia", "gia ban", "don gia ban")),
        ColumnSpec("purchase_price", "number", False, "Giá vốn một đơn vị", ("gia von", "gia nhap")),
        ColumnSpec("customer_id", "code", False, "Mã khách hàng", ("ma khach hang", "khach hang")),
        ColumnSpec(
            "payment_method",
            "choice",
            False,
            "Hình thức thanh toán",
            ("thanh toan", "hinh thuc thanh toan"),
            choices={
                "cash": ("cash", "tien mat", "tm"),
                "transfer": ("transfer", "chuyen khoan", "ck", "qr"),
                "card": ("card", "the", "quet the"),
                "debt": ("debt", "no", "cong no", "ghi no"),
            },
        ),
    ),
)

SCHEMAS = {schema.name: schema for schema in (MEDICINES, SALES)}
