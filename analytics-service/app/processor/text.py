"""Chuẩn hóa chữ tiếng Việt để so khớp tên cột và giá trị."""

from __future__ import annotations

import re
import unicodedata


def normalize_text(value: object) -> str:
    """'Mã Thuốc ' -> 'ma thuoc'; 'Bán_lẻ' -> 'ban le'.

    Bỏ dấu, viết thường, mọi ký tự không phải chữ/số thành một khoảng trắng.
    """
    text = unicodedata.normalize("NFD", str(value))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = text.replace("đ", "d").replace("Đ", "d").lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()
