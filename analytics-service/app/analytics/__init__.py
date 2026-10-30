"""Analytics Engine: tính chỉ số từ dữ liệu đã làm sạch. Không gọi LLM."""

from .breakdown import sales_breakdown, sales_trend
from .kpi import KpiValues, compute_kpis, growth_pct, kpi_summary, prepare_sales
from .periods import Window, period_windows
from .products import product_analysis
from .stock import sellable_stock

__all__ = [
    "KpiValues",
    "Window",
    "compute_kpis",
    "growth_pct",
    "kpi_summary",
    "period_windows",
    "prepare_sales",
    "product_analysis",
    "sales_breakdown",
    "sales_trend",
    "sellable_stock",
]
