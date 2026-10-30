"""Tồn bán được: lô còn hạn trong tệp tồn kho (quyết định D7).

Lô đã hết hạn không được bán nên không tính vào tồn; bước 2.4 xử lý riêng
các lô đó. Phân tích sản phẩm (2.2) và tồn kho (2.3) cùng dùng hàm này.
"""

from __future__ import annotations

import pandas as pd


def sellable_stock(inventory: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """Mỗi (cửa hàng, thuốc) một dòng: stock_quantity, stock_value (theo giá nhập; thiếu giá nhập thì NaN).

    Hạn dùng là ngày cuối còn dùng được: lô hạn đúng hôm nay vẫn tính.
    """
    columns = ["store_code", "medicine_code", "stock_quantity", "stock_value"]
    if inventory is None or inventory.empty:
        return pd.DataFrame(columns=columns)
    alive = inventory[inventory["expiry_date"] >= as_of.normalize()]
    value = alive["quantity"] * alive["purchase_price"]
    grouped = (
        alive.assign(stock_value=value)
        .groupby(["store_code", "medicine_code"], as_index=False)
        .agg(stock_quantity=("quantity", "sum"), stock_value=("stock_value", lambda values: values.sum(min_count=len(values))))
    )
    return grouped[columns]
