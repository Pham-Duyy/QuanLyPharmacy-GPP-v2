"""Giả lập nhân viên bán hàng: cứ vài giây thêm vài hóa đơn mới vào tệp sales.

Dùng để demo Monitor và đo độ trễ "lưu tệp → Dashboard có số mới".
- sales.csv: nối thêm dòng vào cuối tệp (nhanh, như nhân viên gõ thêm giao dịch).
- sales.xlsx: ghi ra tệp tạm rồi đổi tên đè lên, giống cách Excel lưu; tệp lớn
  thì mỗi lần ghi mất vài giây.

Chạy (để Monitor chạy ở cửa sổ khác):
    python scripts/simulate_sales.py                       # mỗi 10 giây thêm 3 hóa đơn, chạy mãi
    python scripts/simulate_sales.py --every 5 --orders 20 --rounds 3
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import INBOX_DIR, TIMEZONE  # noqa: E402
from app.processor import MEDICINES, SALES  # noqa: E402
from app.processor.service import find_file  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

COLUMNS = [column.name for column in SALES.columns]


def price_list(sales: pd.DataFrame, catalog: set[str] | None) -> dict[str, tuple[float, float]]:
    """Giá bán và giá vốn đang dùng của từng thuốc, lấy từ chính dữ liệu bán.
    Chỉ lấy thuốc có trong danh mục (dữ liệu mẫu cố ý có mã lỗi như XX999)."""
    frame = sales[sales["sale_type"] == "retail"].copy()
    if catalog:
        frame = frame[frame["medicine_code"].isin(catalog)]
    for column in ("selling_price", "purchase_price"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    grouped = frame.groupby("medicine_code")[["selling_price", "purchase_price"]].median().dropna()
    return {code: (round(row.selling_price), round(row.purchase_price, 2)) for code, row in grouped.iterrows()}


def new_rows(rng: random.Random, prices: dict, stores: list[str], orders: int) -> list[dict]:
    now = datetime.now(TIMEZONE).replace(tzinfo=None, microsecond=0)
    codes = list(prices)
    rows = []
    for index in range(orders):
        store = rng.choice(stores)
        sale_id = f"{store}-SIM-{now:%y%m%d%H%M%S}-{index + 1:02d}"
        for line_no, code in enumerate(rng.sample(codes, rng.randint(1, 3)), start=1):
            selling, purchase = prices[code]
            rows.append(
                {
                    "sale_id": sale_id,
                    "line_no": line_no,
                    "sale_datetime": now,
                    "sale_type": "retail",
                    "store_code": store,
                    "medicine_code": code,
                    "batch_code": None,
                    "quantity": rng.randint(1, 20),
                    "selling_price": selling,
                    "purchase_price": purchase,
                    "customer_id": None,
                    "payment_method": rng.choice(["cash", "transfer"]),
                }
            )
    return rows


def append_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        for row in rows:
            writer.writerow({**row, "sale_datetime": row["sale_datetime"].strftime("%d/%m/%Y %H:%M:%S")})


def append_xlsx(path: Path, rows: list[dict]) -> None:
    current = pd.read_excel(path, dtype=object)
    updated = pd.concat([current, pd.DataFrame(rows)], ignore_index=True)
    # Ghi ra tệp tạm (tên bắt đầu bằng dấu chấm nên Monitor bỏ qua) rồi đổi tên:
    # Monitor không bao giờ thấy tệp ghi dở.
    temporary = path.with_name(f".{path.stem}.tmp.xlsx")
    updated.to_excel(temporary, index=False)
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Giả lập thêm hóa đơn mới vào tệp sales")
    parser.add_argument("--folder", type=Path, default=INBOX_DIR, help="Thư mục chứa sales (mặc định data/inbox)")
    parser.add_argument("--every", type=float, default=10, help="Số giây giữa hai lần thêm")
    parser.add_argument("--orders", type=int, default=3, help="Số hóa đơn mỗi lần")
    parser.add_argument("--rounds", type=int, default=0, help="Số lần thêm (0: chạy tới khi Ctrl+C)")
    parser.add_argument("--seed", type=int, default=None, help="Hạt giống ngẫu nhiên")
    args = parser.parse_args()

    path = find_file(args.folder, SALES)
    if path is None:
        sys.exit(f"Không thấy sales.xlsx/sales.csv trong {args.folder}. Sinh dữ liệu trước:\n"
                 f"  python scripts/generate_sample_data.py --out {args.folder} --format csv")
    reader = pd.read_csv if path.suffix == ".csv" else pd.read_excel
    sales = reader(path, dtype=str) if path.suffix == ".csv" else reader(path, dtype=object)
    medicine_file = find_file(args.folder, MEDICINES)
    catalog = None
    if medicine_file:
        medicines = pd.read_csv(medicine_file, dtype=str) if medicine_file.suffix == ".csv" else pd.read_excel(medicine_file, dtype=object)
        catalog = set(medicines["medicine_code"].dropna())
    prices = price_list(sales, catalog)
    stores = sorted(code for code in sales["store_code"].dropna().unique() if not code.startswith("SIM"))
    print(f"Thêm hóa đơn vào {path} (danh mục: {medicine_file.name if medicine_file else 'không có'}). Ctrl+C để dừng.")

    rng = random.Random(args.seed)
    done = 0
    try:
        while args.rounds == 0 or done < args.rounds:
            rows = new_rows(rng, prices, stores, args.orders)
            started = time.perf_counter()
            (append_csv if path.suffix == ".csv" else append_xlsx)(path, rows)
            revenue = sum(row["quantity"] * row["selling_price"] for row in rows)
            done += 1
            money = f"{revenue:,.0f}".replace(",", ".")
            seconds = f"{time.perf_counter() - started:.1f}".replace(".", ",")
            print(f"{datetime.now(TIMEZONE):%H:%M:%S}  +{args.orders} hóa đơn ({len(rows)} dòng, {money} đ) ghi trong {seconds} giây")
            if args.rounds == 0 or done < args.rounds:
                time.sleep(args.every)
    except KeyboardInterrupt:
        print("Đã dừng.")


if __name__ == "__main__":
    main()
