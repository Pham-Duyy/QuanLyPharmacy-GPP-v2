"""KPI Engine: các chỉ số kinh doanh cốt lõi.

Công thức (docs/analytics/kpi.md):
- Doanh thu (revenue)      = Σ số lượng × giá bán
- Giá vốn (COGS)           = Σ số lượng × giá vốn
- Lợi nhuận gộp (profit)   = Doanh thu − Giá vốn
- Biên lợi nhuận (margin)  = Lợi nhuận / Doanh thu × 100
- Số đơn (orders)          = số mã hóa đơn khác nhau
- Số lượng bán (units)     = Σ số lượng
- Giá trị đơn trung bình   = Doanh thu / Số đơn
- Tăng trưởng (growth)     = (Kỳ này − Kỳ trước) / Kỳ trước × 100; kỳ trước = 0 thì không tính

Toàn bộ là phép tính tất định trên pandas, không gọi LLM.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd

from .periods import PERIOD_LABELS, PeriodName, Window, period_windows

UNCATEGORIZED = "Chưa phân loại"


def prepare_sales(sales: pd.DataFrame, medicines: pd.DataFrame | None = None) -> pd.DataFrame:
    """Thêm các cột tính sẵn cho mọi phép tổng hợp phía sau.

    - revenue, cogs của từng dòng; dòng thiếu giá vốn thì cogs để trống (NaN),
      không coi là 0, để không thổi phồng lợi nhuận.
    - medicine_name, category lấy từ danh mục thuốc.
    """
    frame = sales.copy()
    frame["revenue"] = frame["quantity"] * frame["selling_price"]
    frame["cogs"] = frame["quantity"] * frame["purchase_price"]
    if medicines is not None and not medicines.empty:
        catalog = medicines[["medicine_code", "medicine_name", "category"]].drop_duplicates("medicine_code")
        frame = frame.merge(catalog, on="medicine_code", how="left")
    else:
        frame["medicine_name"] = None
        frame["category"] = None
    frame["category"] = frame["category"].fillna(UNCATEGORIZED)
    return frame


@dataclass(frozen=True)
class KpiValues:
    revenue: float
    cogs: float
    profit: float
    margin_pct: float | None
    orders: int
    units: float
    lines: int
    avg_order_value: float | None
    # % doanh thu có giá vốn. Dưới 100% thì giá vốn và lợi nhuận chỉ tính trên phần có giá vốn.
    cost_coverage_pct: float | None

    def to_dict(self) -> dict:
        return asdict(self)


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def compute_kpis(frame: pd.DataFrame) -> KpiValues:
    """Chỉ số của một tập dòng bán hàng (đã qua prepare_sales)."""
    revenue = frame["revenue"].sum()
    with_cost = frame["cogs"].notna()
    revenue_with_cost = frame.loc[with_cost, "revenue"].sum()
    cogs = frame.loc[with_cost, "cogs"].sum()
    # Lợi nhuận chỉ trên phần có giá vốn: so cùng một nhóm dòng ở cả hai vế.
    profit = revenue_with_cost - cogs
    orders = frame["sale_id"].nunique()
    return KpiValues(
        revenue=_round(revenue),
        cogs=_round(cogs),
        profit=_round(profit),
        margin_pct=_round(profit / revenue_with_cost * 100) if revenue_with_cost else None,
        orders=int(orders),
        units=_round(frame["quantity"].sum()),
        lines=int(len(frame)),
        avg_order_value=_round(revenue / orders) if orders else None,
        cost_coverage_pct=_round(revenue_with_cost / revenue * 100) if revenue else None,
    )


def growth_pct(current: float | None, previous: float | None) -> float | None:
    """(Kỳ này − Kỳ trước) / Kỳ trước × 100. Kỳ trước 0 hoặc không có: trả None, không chia."""
    if current is None or previous is None or previous == 0:
        return None
    return _round((current - previous) / abs(previous) * 100, 1)


GROWTH_FIELDS = ("revenue", "profit", "orders", "units", "avg_order_value")


@dataclass(frozen=True)
class PeriodKpi:
    period: PeriodName
    label: str
    previous_label: str
    current_window: Window
    previous_window: Window
    current: KpiValues
    # Kỳ trước cùng độ dài: cơ sở để tính growth.
    previous_same_span: KpiValues
    previous_full: KpiValues
    growth: dict[str, float | None]

    def to_dict(self) -> dict:
        return {
            "period": self.period,
            "label": self.label,
            "previous_label": self.previous_label,
            "current_window": self.current_window.to_dict(),
            "previous_window": self.previous_window.to_dict(),
            "current": self.current.to_dict(),
            "previous_same_span": self.previous_same_span.to_dict(),
            "previous_full": self.previous_full.to_dict(),
            "growth": self.growth,
        }


def period_kpi(frame: pd.DataFrame, as_of: pd.Timestamp, period: PeriodName) -> PeriodKpi:
    windows = period_windows(as_of, period)
    moments = frame["sale_datetime"]
    current = compute_kpis(frame[windows.current.contains(moments)])
    same_span = compute_kpis(frame[windows.previous_same_span.contains(moments)])
    full = compute_kpis(frame[windows.previous_full.contains(moments)])
    label, previous_label = PERIOD_LABELS[period]
    return PeriodKpi(
        period=period,
        label=label,
        previous_label=previous_label,
        current_window=windows.current,
        previous_window=windows.previous_same_span,
        current=current,
        previous_same_span=same_span,
        previous_full=full,
        growth={name: growth_pct(getattr(current, name), getattr(same_span, name)) for name in GROWTH_FIELDS},
    )


def kpi_summary(frame: pd.DataFrame, as_of: pd.Timestamp, store_code: str | None = None) -> dict:
    """Bộ KPI cho Dashboard: hôm nay, tuần này, tháng này, kèm so sánh kỳ trước.

    Dữ liệu sau thời điểm as_of không được tính (xem lại quá khứ cho đúng).
    """
    scoped = frame if store_code is None else frame[frame["store_code"] == store_code]
    scoped = scoped[scoped["sale_datetime"] < as_of]
    return {
        "as_of": as_of.isoformat(),
        "store_code": store_code,
        "periods": {name: period_kpi(scoped, as_of, name).to_dict() for name in ("day", "week", "month")},
        "all_time": compute_kpis(scoped).to_dict(),
    }
