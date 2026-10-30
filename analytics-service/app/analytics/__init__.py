"""Analytics Engine: tính chỉ số từ dữ liệu đã làm sạch. Không gọi LLM."""

from .breakdown import sales_breakdown, sales_trend
from .expiry import expiry_analysis
from .inventory import inventory_analysis
from .kpi import KpiValues, compute_kpis, growth_pct, kpi_summary, prepare_sales
from .periods import Window, period_windows
from .products import product_analysis
from .series import history_status, revenue_series, units_table
from .stock import sellable_stock

__all__ = [
    "KpiValues",
    "Window",
    "compute_kpis",
    "expiry_analysis",
    "growth_pct",
    "history_status",
    "inventory_analysis",
    "kpi_summary",
    "period_windows",
    "prepare_sales",
    "product_analysis",
    "revenue_series",
    "sales_breakdown",
    "sales_trend",
    "sellable_stock",
    "units_table",
]
