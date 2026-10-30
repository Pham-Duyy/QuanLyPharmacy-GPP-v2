"""Sinh bộ dữ liệu mẫu: medicines.xlsx, sales.xlsx và inventory.xlsx.

Dữ liệu giả lập 3 cửa hàng, 60 mặt hàng, 90 ngày bán, có sẵn vài "câu chuyện"
để các bước phân tích sau có thứ để phát hiện:
- CH02 Thủ Đức tăng trưởng đều (+25% sau 90 ngày).
- CH03 Bình Thạnh sụt khoảng 35% trong 21 ngày cuối.
- Nhóm Hô hấp – ho cảm tăng mạnh trong 30 ngày cuối (mùa cảm cúm).
- Cuối tuần đông khách hơn ngày thường.

Tồn kho theo lô (inventory.xlsx, Phase 2) tính từ tốc độ bán thật của từng
thuốc ở từng cửa hàng, kèm các tình huống cố ý (xem STORY_LOTS):
lô đã hết hạn còn trong kho, lô sắp hết hạn mà bán không kịp, thuốc sắp hết,
hết hàng, tồn quá nhiều, và máy xông TB010 chưa bán được cái nào (tồn chết).

Mặc định chèn thêm 12 dòng lỗi vào sales.xlsx, 2 dòng vào medicines.xlsx và 7 dòng vào inventory.xlsx
để kiểm tra bộ xử lý dữ liệu. Dùng --errors 0 để có dữ liệu sạch.

Chạy:  python scripts/generate_sample_data.py
       python scripts/generate_sample_data.py --days 120 --end-date 2026-10-30 --errors 0
       python scripts/generate_sample_data.py --out data/inbox --format csv   (thư mục Monitor theo dõi)
"""

from __future__ import annotations

import argparse
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import SAMPLES_DIR, TIMEZONE  # noqa: E402

# (mã, tên, nhóm, đơn vị, giá vốn, biên lãi, độ phổ biến, số lượng mỗi lần mua (min, max), kê đơn)
MEDICINES = [
    ("KS001", "Amoxicillin 500mg", "Kháng sinh", "Viên", 1_450, 0.35, 8, (10, 21), True),
    ("KS002", "Amoxicillin + Acid clavulanic 1g", "Kháng sinh", "Viên", 9_100, 0.35, 6, (10, 14), True),
    ("KS003", "Cefuroxim 500mg", "Kháng sinh", "Viên", 6_200, 0.32, 4, (10, 14), True),
    ("KS004", "Cefixim 200mg", "Kháng sinh", "Viên", 5_000, 0.30, 4, (10, 14), True),
    ("KS005", "Azithromycin 500mg", "Kháng sinh", "Viên", 7_800, 0.33, 4, (3, 6), True),
    ("KS006", "Ciprofloxacin 500mg", "Kháng sinh", "Viên", 1_900, 0.38, 3, (10, 14), True),
    ("KS007", "Metronidazol 250mg", "Kháng sinh", "Viên", 600, 0.40, 2, (10, 21), True),
    ("GD001", "Paracetamol 500mg", "Giảm đau, hạ sốt", "Viên", 800, 0.40, 30, (10, 20), False),
    ("GD002", "Panadol Extra", "Giảm đau, hạ sốt", "Viên", 1_750, 0.20, 18, (10, 12), False),
    ("GD003", "Efferalgan 500mg viên sủi", "Giảm đau, hạ sốt", "Viên", 2_900, 0.25, 10, (4, 8), False),
    ("GD004", "Ibuprofen 400mg", "Giảm đau, hạ sốt", "Viên", 1_100, 0.38, 9, (10, 20), False),
    ("GD005", "Alaxan", "Giảm đau, hạ sốt", "Viên", 2_600, 0.30, 7, (4, 10), False),
    ("GD006", "Meloxicam 7,5mg", "Giảm đau, hạ sốt", "Viên", 900, 0.45, 4, (10, 20), True),
    ("GD007", "Diclofenac 50mg", "Giảm đau, hạ sốt", "Viên", 500, 0.45, 4, (10, 20), True),
    ("TM001", "Amlodipin 5mg", "Tim mạch, huyết áp", "Viên", 1_100, 0.40, 10, (28, 60), True),
    ("TM002", "Losartan 50mg", "Tim mạch, huyết áp", "Viên", 1_550, 0.38, 8, (28, 60), True),
    ("TM003", "Telmisartan 40mg", "Tim mạch, huyết áp", "Viên", 2_000, 0.35, 6, (28, 30), True),
    ("TM004", "Atorvastatin 20mg", "Tim mạch, huyết áp", "Viên", 2_800, 0.36, 7, (28, 30), True),
    ("TM005", "Rosuvastatin 10mg", "Tim mạch, huyết áp", "Viên", 3_850, 0.30, 6, (28, 30), True),
    ("TM006", "Bisoprolol 5mg", "Tim mạch, huyết áp", "Viên", 1_300, 0.40, 5, (28, 30), True),
    ("TM007", "Aspirin 81mg", "Tim mạch, huyết áp", "Viên", 400, 0.50, 6, (30, 60), False),
    ("TD001", "Metformin 500mg", "Tiểu đường", "Viên", 850, 0.40, 9, (56, 90), True),
    ("TD002", "Gliclazid MR 30mg", "Tiểu đường", "Viên", 1_350, 0.38, 6, (30, 60), True),
    ("TD003", "Sitagliptin 100mg", "Tiểu đường", "Viên", 9_900, 0.28, 2, (28, 30), True),
    ("TD004", "Que thử đường huyết", "Tiểu đường", "Que", 6_500, 0.30, 3, (25, 50), False),
    ("TH001", "Omeprazol 20mg", "Tiêu hóa", "Viên", 700, 0.45, 9, (14, 28), False),
    ("TH002", "Esomeprazol 40mg", "Tiêu hóa", "Viên", 2_300, 0.38, 6, (14, 28), True),
    ("TH003", "Smecta", "Tiêu hóa", "Gói", 3_400, 0.30, 7, (6, 12), False),
    ("TH004", "Men vi sinh Enterogermina", "Tiêu hóa", "Ống", 5_600, 0.28, 8, (10, 20), False),
    ("TH005", "Loperamid 2mg", "Tiêu hóa", "Viên", 450, 0.50, 4, (6, 10), False),
    ("TH006", "Domperidon 10mg", "Tiêu hóa", "Viên", 600, 0.45, 4, (10, 20), False),
    ("HH001", "Siro ho Prospan 100ml", "Hô hấp, ho cảm", "Chai", 72_000, 0.30, 7, (1, 2), False),
    ("HH002", "Acetylcystein 200mg", "Hô hấp, ho cảm", "Gói", 1_800, 0.40, 9, (10, 20), False),
    ("HH003", "Ambroxol 30mg", "Hô hấp, ho cảm", "Viên", 700, 0.45, 8, (10, 20), False),
    ("HH004", "Bromhexin 8mg", "Hô hấp, ho cảm", "Viên", 400, 0.50, 6, (10, 20), False),
    ("HH005", "Loratadin 10mg", "Hô hấp, ho cảm", "Viên", 800, 0.45, 8, (10, 20), False),
    ("HH006", "Cetirizin 10mg", "Hô hấp, ho cảm", "Viên", 600, 0.45, 7, (10, 20), False),
    ("HH007", "Xịt mũi Xylometazolin 0,05%", "Hô hấp, ho cảm", "Lọ", 28_000, 0.30, 5, (1, 2), False),
    ("HH008", "Viên ngậm Strepsils", "Hô hấp, ho cảm", "Viên", 1_900, 0.30, 6, (8, 16), False),
    ("VT001", "Vitamin C 500mg", "Vitamin, TPCN", "Viên", 1_050, 0.40, 12, (20, 60), False),
    ("VT002", "Vitamin tổng hợp Centrum", "Vitamin, TPCN", "Viên", 5_200, 0.30, 5, (30, 30), False),
    ("VT003", "Canxi D3 viên sủi", "Vitamin, TPCN", "Viên", 3_000, 0.35, 6, (10, 20), False),
    ("VT004", "Dầu cá Omega-3 1000mg", "Vitamin, TPCN", "Viên", 2_650, 0.18, 7, (30, 100), False),
    ("VT005", "Hoạt huyết dưỡng não", "Vitamin, TPCN", "Viên", 990, 0.18, 6, (30, 100), False),
    ("VT006", "Kẽm Zinc 10mg", "Vitamin, TPCN", "Viên", 1_200, 0.40, 4, (20, 30), False),
    ("VT007", "Sắt Ferrovit", "Vitamin, TPCN", "Viên", 1_600, 0.38, 4, (30, 30), False),
    ("DL001", "Kem Hydrocortison 1% 15g", "Da liễu", "Tuýp", 15_000, 0.35, 3, (1, 2), True),
    ("DL002", "Gel Adapalen 0,1% 15g", "Da liễu", "Tuýp", 88_000, 0.30, 2, (1, 1), True),
    ("DL003", "Kem trị nấm Clotrimazol 1%", "Da liễu", "Tuýp", 18_000, 0.35, 3, (1, 2), False),
    ("DL004", "Dung dịch sát khuẩn Povidine 90ml", "Da liễu", "Chai", 21_000, 0.30, 4, (1, 2), False),
    ("DL005", "Nước muối sinh lý 0,9% 500ml", "Da liễu", "Chai", 4_200, 0.40, 12, (1, 4), False),
    ("TB001", "Khẩu trang y tế 4 lớp", "Thiết bị y tế", "Cái", 950, 0.18, 12, (10, 50), False),
    ("TB002", "Nhiệt kế điện tử", "Thiết bị y tế", "Cái", 62_000, 0.40, 2, (1, 1), False),
    ("TB003", "Nhiệt kế hồng ngoại đo trán", "Thiết bị y tế", "Cái", 280_000, 0.38, 1, (1, 1), False),
    ("TB004", "Máy đo huyết áp bắp tay Omron", "Thiết bị y tế", "Cái", 815_000, 0.20, 1, (1, 1), False),
    ("TB005", "Bông y tế 50g", "Thiết bị y tế", "Gói", 8_000, 0.40, 4, (1, 3), False),
    ("TB006", "Băng gạc vô trùng 10x10cm", "Thiết bị y tế", "Miếng", 2_600, 0.45, 4, (5, 10), False),
    ("TB007", "Găng tay y tế", "Thiết bị y tế", "Đôi", 1_000, 0.50, 2, (5, 20), False),
    ("TB008", "Băng keo cá nhân", "Thiết bị y tế", "Miếng", 360, 0.65, 5, (5, 20), False),
    ("TB009", "Que test nhanh COVID-19", "Thiết bị y tế", "Que", 32_000, 0.30, 2, (1, 3), False),
    # Độ phổ biến 0: có trong danh mục, có tồn, nhưng không ai mua (tồn chết).
    ("TB010", "Máy xông mũi họng", "Thiết bị y tế", "Cái", 650_000, 0.25, 0, (1, 1), False),
]

MANUFACTURERS = ["DHG Pharma", "Imexpharm", "Traphaco", "Stada", "Sanofi", "Pymepharco", "Domesco", "OPV"]

# (mã, tên, số đơn trung bình/ngày, tăng trưởng cả kỳ, mức sụt trong 21 ngày cuối)
STORES = [
    ("CH01", "Quận 1", 70, 0.00, 0.00),
    ("CH02", "Thủ Đức", 55, 0.25, 0.00),
    ("CH03", "Bình Thạnh", 60, 0.00, 0.35),
]
WEEKDAY_FACTOR = [0.95, 0.95, 1.0, 1.0, 1.05, 1.15, 1.2]  # thứ Hai .. Chủ nhật
LINES_PER_ORDER = ([1, 2, 3, 4], [45, 30, 17, 8])
PAYMENTS = (["cash", "transfer", "card", "debt"], [55, 35, 8, 2])


def build_medicines(rng: random.Random) -> pd.DataFrame:
    rows = []
    for code, name, category, unit, cost, _margin, popularity, (low, high), rx in MEDICINES:
        min_stock = max(int(popularity * (low + high) / 2 * 1.5), 5)
        rows.append(
            {
                "medicine_code": code,
                "medicine_name": name,
                "category": category,
                "unit": unit,
                "manufacturer": rng.choice(MANUFACTURERS),
                "is_prescription": "Y" if rx else "N",
                "min_stock": min_stock,
                "max_stock": min_stock * 6,
            }
        )
    return pd.DataFrame(rows)


def _price(value: float) -> int:
    """Giá lẻ làm tròn tới 100 đồng như nhà thuốc vẫn niêm yết."""
    return int(round(value / 100) * 100) or 100


def build_sales(rng: random.Random, days: int, end: date, now: datetime) -> pd.DataFrame:
    """Không sinh giờ bán sau thời điểm `now`: ngày cuối là hôm nay thì chỉ tới giờ hiện tại."""
    start = end - timedelta(days=days - 1)
    weights = [item[6] for item in MEDICINES]
    rows = []
    for store_code, _name, base_orders, growth, recent_drop in STORES:
        order_seq = 0
        for offset in range(days):
            day = start + timedelta(days=offset)
            progress = offset / max(days - 1, 1)
            factor = WEEKDAY_FACTOR[day.weekday()] * (1 + growth * progress)
            if recent_drop and offset >= days - 21:
                factor *= 1 - recent_drop
            orders = max(int(rng.gauss(base_orders * factor, base_orders * 0.08)), 0)
            # Mùa cảm cúm: nhóm hô hấp được chọn nhiều hơn trong 30 ngày cuối.
            flu = offset >= days - 30
            day_weights = [
                weight * (1.6 if flu and item[2] == "Hô hấp, ho cảm" else 1.0)
                for weight, item in zip(weights, MEDICINES)
            ]
            for _ in range(orders):
                order_seq += 1
                sale_id = f"{store_code}-{day:%y%m%d}-{order_seq:05d}"
                # Giờ mở cửa 7h–22h, đông nhất buổi chiều tối.
                minute = int(min(max(rng.gauss(17 * 60, 3 * 60), 7 * 60), 22 * 60 - 1))
                moment = datetime(day.year, day.month, day.day, minute // 60, minute % 60, rng.randrange(60))
                if moment > now:
                    continue
                wholesale = rng.random() < 0.03
                payment = rng.choices(*PAYMENTS)[0]
                if wholesale:
                    payment = rng.choice(["transfer", "debt"])
                customer = f"KH{rng.randrange(1, 800):04d}" if wholesale or rng.random() < 0.4 else None
                count = rng.choices(*LINES_PER_ORDER)[0]
                picked: set[str] = set()
                for _ in range(count):
                    item = rng.choices(MEDICINES, weights=day_weights)[0]
                    if item[0] in picked:
                        continue
                    picked.add(item[0])
                    line_no = len(picked)
                    code, _n, _c, _u, cost, margin, _p, (low, high), _rx = item
                    quantity = rng.randint(low, high) * (10 if wholesale else 1)
                    batch_no = 1 if offset < days // 2 else 2
                    purchase = round(cost * (1 + rng.uniform(-0.02, 0.02)), 2)
                    selling = _price(cost * (1 + margin) * (0.9 if wholesale else 1.0))
                    rows.append(
                        {
                            "sale_id": sale_id,
                            "line_no": line_no,
                            "sale_datetime": moment,
                            "sale_type": "wholesale" if wholesale else "retail",
                            "store_code": store_code,
                            "medicine_code": code,
                            "batch_code": f"{code}-{(end.year % 100):02d}{batch_no:02d}",
                            "quantity": quantity,
                            "selling_price": selling,
                            "purchase_price": purchase,
                            "customer_id": customer,
                            "payment_method": payment,
                        }
                    )
    return pd.DataFrame(rows)


SUPPLIERS = ["Phano", "Dược Sài Gòn", "Zuellig Pharma", "DKSH", "Vimedimex"]

# Lô cố ý, ghi đè tồn tính tự động của đúng thuốc đó ở đúng cửa hàng.
# (cửa hàng, mã thuốc, [(số ngày còn hạn, số ngày bán của lô)]): số lượng = số ngày bán × tốc độ bán.
# Số ngày còn hạn âm là lô đã hết hạn.
STORY_LOTS = {
    ("CH01", "KS007"): [(-5, 6), (300, 25)],  # một lô đã hết hạn 5 ngày vẫn nằm trong kho
    ("CH03", "TH005"): [(-20, 10), (250, 30)],  # lô hết hạn 20 ngày
    ("CH02", "HH001"): [(5, 15), (400, 20)],  # Siro Prospan: lô còn 5 ngày, cần 15 ngày mới bán hết → nguy cơ
    ("CH03", "HH002"): [(20, 45), (500, 20)],  # Acetylcystein: lô còn 20 ngày, cần 45 ngày → nguy cơ
    ("CH01", "GD001"): [(6, 3), (420, 40)],  # Paracetamol: lô còn 6 ngày nhưng 3 ngày là bán hết → an toàn
    ("CH02", "GD001"): [(380, 2)],  # Paracetamol CH02: chỉ đủ bán 2 ngày → sắp hết
    ("CH01", "TM001"): [(450, 4)],  # Amlodipin: sắp hết
    ("CH01", "VT004"): [(200, 140), (600, 80)],  # Omega-3: đủ bán hơn 200 ngày → tồn cao
    ("CH03", "VT001"): [],  # Vitamin C CH03: hết hàng
}
DEAD_STOCK = {"CH01": 3, "CH02": 2, "CH03": 4}  # TB010 tồn ở cả ba cửa hàng


def build_inventory(rng: random.Random, sales: pd.DataFrame, end: date) -> pd.DataFrame:
    """Tồn hiện tại theo lô, suy ra từ tốc độ bán 30 ngày cuối (ADS) của sales sạch."""
    recent = sales[pd.to_datetime(sales["sale_datetime"]) >= pd.Timestamp(end - timedelta(days=29))]
    ads = recent.groupby(["store_code", "medicine_code"])["quantity"].sum() / 30
    costs = {item[0]: item[4] for item in MEDICINES}
    rows = []

    def lot(store: str, code: str, days_left: int, quantity: float, number: int) -> None:
        quantity = int(round(quantity))
        if quantity <= 0:
            return
        expiry = end + timedelta(days=days_left)
        # Thuốc thường có hạn 2–3 năm kể từ khi sản xuất; nhập kho sau sản xuất vài tháng.
        received = min(expiry - timedelta(days=rng.randint(540, 900)), end - timedelta(days=rng.randint(5, 120)))
        rows.append(
            {
                "store_code": store,
                "medicine_code": code,
                "batch_code": f"{code}-{expiry:%y%m}{number:02d}",
                "quantity": quantity,
                "expiry_date": expiry,
                "purchase_price": round(costs[code] * (1 + rng.uniform(-0.02, 0.02)), 2),
                "received_date": received,
                "supplier": rng.choice(SUPPLIERS),
            }
        )

    for store, *_ in STORES:
        for code, *_ in MEDICINES:
            rate = float(ads.get((store, code), 0.0))
            if (store, code) in STORY_LOTS:
                for number, (days_left, days_of_sale) in enumerate(STORY_LOTS[store, code], start=1):
                    lot(store, code, days_left, max(rate, 1) * days_of_sale, number)
                continue
            if code == "TB010":
                lot(store, code, rng.randint(700, 900), DEAD_STOCK[store], 1)
                continue
            if rate == 0:
                continue  # 30 ngày không bán và không nhập: không có trong kho
            cover = rng.uniform(20, 60)  # đủ bán 20–60 ngày: mức bình thường
            # Phần lớn còn hạn xa; khoảng 1/8 có lô cũ hạn 8–90 ngày (mức cảnh báo, theo dõi).
            if rng.random() < 0.125:
                lot(store, code, rng.randint(8, 90), rate * cover * 0.3, 1)
                lot(store, code, rng.randint(360, 800), rate * cover * 0.7, 2)
            else:
                lot(store, code, rng.randint(150, 800), rate * cover, 1)
    return pd.DataFrame(rows)


def inject_inventory_errors(inventory: pd.DataFrame) -> pd.DataFrame:
    """Mỗi luật kiểm tra tồn kho một dòng lỗi cố ý."""
    inventory = inventory.astype(object).copy()
    picks = iter(range(10, 10 + 7 * 13, 13))
    duplicate = inventory.iloc[[next(picks)]].copy()  # nhập trùng lô
    inventory.at[next(picks), "quantity"] = -10  # tồn âm
    row = next(picks)
    inventory.at[row, "expiry_date"] = inventory.at[row, "received_date"] - timedelta(days=10)  # hạn trước ngày nhập
    inventory.at[next(picks), "medicine_code"] = "XX999"  # thuốc không có trong danh mục
    inventory.at[next(picks), "quantity"] = 0  # tồn 0 (cảnh báo, bỏ qua dòng)
    row = next(picks)
    inventory.at[row, "expiry_date"] = inventory.at[row, "expiry_date"].replace(year=2099)  # gõ nhầm năm (cảnh báo)
    inventory.at[next(picks), "store_code"] = "CH09"  # cửa hàng không có trong sales (cảnh báo)
    return pd.concat([inventory, duplicate], ignore_index=True)


def inject_errors(sales: pd.DataFrame, medicines: pd.DataFrame, end: date) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Chèn lỗi cố ý, mỗi loại một dòng, để kiểm tra Processor bắt được hết."""
    sales = sales.astype(object).copy()
    picks = iter(range(100, 100 + 12 * 37, 37))  # các dòng cách đều nhau, cố định

    def row() -> int:
        return next(picks)

    sales.at[row(), "medicine_code"] = None  # thiếu mã thuốc
    sales.at[row(), "medicine_code"] = "XX999"  # mã không có trong danh mục
    sales.at[row(), "quantity"] = 0  # số lượng 0
    sales.at[row(), "quantity"] = -2  # số lượng âm
    sales.at[row(), "selling_price"] = "-5.000"  # giá âm
    sales.at[row(), "sale_datetime"] = "31/02/2026"  # ngày không tồn tại
    sales.at[row(), "sale_datetime"] = datetime.combine(end + timedelta(days=10), datetime.min.time())  # tương lai
    sales.at[row(), "sale_type"] = "bán thử"  # loại bán không hợp lệ
    below = row()
    sales.at[below, "selling_price"] = int(float(sales.at[below, "purchase_price"]) * 0.8)  # bán dưới giá vốn (cảnh báo)
    sales.at[row(), "batch_code"] = "LÔ#12@!"  # số lô lạ (cảnh báo)
    sales.at[row(), "store_code"] = None  # thiếu cửa hàng
    duplicate = sales.iloc[[row()]].copy()  # nhập trùng một dòng
    sales = pd.concat([sales, duplicate], ignore_index=True)

    medicines = medicines.astype(object).copy()
    medicines = pd.concat([medicines, medicines.iloc[[0]]], ignore_index=True)  # trùng mã thuốc
    medicines.at[5, "min_stock"] = 999_999  # tồn tối thiểu > tối đa (cảnh báo)
    return sales, medicines


def main() -> None:
    parser = argparse.ArgumentParser(description="Sinh dữ liệu mẫu medicines.xlsx, sales.xlsx, inventory.xlsx")
    parser.add_argument("--days", type=int, default=90, help="Số ngày bán hàng (mặc định 90)")
    parser.add_argument("--end-date", type=date.fromisoformat, default=date.today(), help="Ngày cuối, YYYY-MM-DD")
    parser.add_argument("--errors", type=int, choices=[0, 1], default=1, help="1: chèn dòng lỗi mẫu; 0: dữ liệu sạch")
    parser.add_argument("--seed", type=int, default=2026, help="Hạt giống ngẫu nhiên: cùng seed ra cùng dữ liệu")
    parser.add_argument("--out", type=Path, default=SAMPLES_DIR, help="Thư mục ghi tệp")
    parser.add_argument("--format", choices=["xlsx", "csv"], default="xlsx", help="xlsx (mặc định) hoặc csv")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    medicines = build_medicines(rng)
    now = datetime.now(TIMEZONE).replace(tzinfo=None)
    sales = build_sales(rng, args.days, args.end_date, now)
    # Tồn kho tính từ sales SẠCH, trước khi chèn lỗi; dùng nguồn ngẫu nhiên riêng
    # để thêm tồn kho không làm đổi dữ liệu bán hàng của cùng một seed.
    inventory = build_inventory(random.Random(args.seed + 1), sales, args.end_date)
    if args.errors:
        sales, medicines = inject_errors(sales, medicines, args.end_date)
        inventory = inject_inventory_errors(inventory)

    args.out.mkdir(parents=True, exist_ok=True)
    # Không để cùng lúc sales.xlsx và sales.csv: hệ thống ưu tiên .xlsx, dễ nhầm tệp đang dùng.
    names = ("medicines", "sales", "inventory")
    for name in names:
        other = args.out / f"{name}.{'csv' if args.format == 'xlsx' else 'xlsx'}"
        if other.exists():
            other.unlink()
    paths = {name: args.out / f"{name}.{args.format}" for name in names}
    if args.format == "csv":
        # Ngày giờ ghi kiểu dd/mm/yyyy HH:MM:SS như Excel Việt Nam xuất CSV.
        medicines.to_csv(paths["medicines"], index=False, encoding="utf-8-sig")
        sales.to_csv(paths["sales"], index=False, encoding="utf-8-sig", date_format="%d/%m/%Y %H:%M:%S")
        inventory.to_csv(paths["inventory"], index=False, encoding="utf-8-sig", date_format="%d/%m/%Y")
    else:
        medicines.to_excel(paths["medicines"], index=False, sheet_name="medicines")
        sales.to_excel(paths["sales"], index=False, sheet_name="sales")
        inventory.to_excel(paths["inventory"], index=False, sheet_name="inventory")
    print(f"Đã ghi {len(medicines)} mặt hàng -> {paths['medicines']}")
    print(f"Đã ghi {len(sales):,} dòng bán hàng ({args.days} ngày đến {args.end_date}) -> {paths['sales']}")
    print(f"Đã ghi {len(inventory):,} lô tồn kho -> {paths['inventory']}")


if __name__ == "__main__":
    main()
