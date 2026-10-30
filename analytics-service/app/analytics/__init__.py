"""Analytics Engine: tính chỉ số từ dữ liệu đã làm sạch. Không gọi LLM."""

from .breakdown import sales_breakdown, sales_trend
from .kpi import KpiValues, compute_kpis, growth_pct, kpi_summary, prepare_sales
from .periods import Window, period_windows

__all__ = [
    "KpiValues",
    "Window",
    "compute_kpis",
    "growth_pct",
    "kpi_summary",
    "period_windows",
    "prepare_sales",
    "sales_breakdown",
    "sales_trend",
]
