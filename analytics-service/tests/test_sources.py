"""Kiểm thử nguồn dữ liệu (bước 5.5).

Phần PostgreSQL chạy khi có biến ANALYTICS_TEST_PG_DSN (một CSDL PostgreSQL dùng thử): test tạo
schema tạm có cùng cột với 4 view analytics_src, đọc qua đúng PostgresSource, rồi xóa schema.
Ý nghĩa từng view (bỏ hóa đơn hủy, trừ hàng trả...) đã kiểm ở server/src/modules/bi/analytics-src.test.ts.
"""

from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta

import pandas as pd
import pytest

from app.pipeline import Pipeline
from app.processor.loader import LoadError
from app.sources import FolderSource, PostgresSource, make_source
from app.store import AnalyticsStore

PG_DSN = os.environ.get("ANALYTICS_TEST_PG_DSN")
AS_OF = pd.Timestamp("2026-10-29 12:00")


def test_make_source_and_password_is_never_printed(tmp_path):
    assert isinstance(make_source("files", tmp_path, None), FolderSource)
    with pytest.raises(SystemExit):
        make_source("postgres", tmp_path, None)
    source = make_source("postgres", tmp_path, "postgresql://analytics_reader:bi-mat@db.local:5433/gpp")
    assert source.describe() == "postgres://db.local:5433/gpp (analytics_src)"
    assert "bi-mat" not in source.describe()


def test_folder_without_sales_file(tmp_path):
    with pytest.raises(LoadError, match="sales"):
        FolderSource(tmp_path).fingerprints({})


def test_unreachable_database_keeps_last_snapshot(tmp_path):
    store = AnalyticsStore(tmp_path / "analytics.db")
    source = PostgresSource("postgresql://nobody:x@127.0.0.1:1/none", timeout_seconds=1)
    pipeline = Pipeline(tmp_path, store, source=source)
    first = pipeline.run(trigger="refresh", as_of=AS_OF)
    assert first.status == "failed" and "Không kết nối được PostgreSQL" in first.message
    assert "nobody:x" not in first.message
    # Polling gặp lại đúng lỗi đó: không ghi thêm lần chạy thất bại mỗi 30 giây.
    assert pipeline.run(trigger="refresh", as_of=AS_OF).status == "unchanged"
    assert len(store.recent_runs(10)) == 1


# --- PostgreSQL thật ---------------------------------------------------------------------------

pg = pytest.mark.skipif(not PG_DSN, reason="đặt ANALYTICS_TEST_PG_DSN để chạy với PostgreSQL thật")


@pytest.fixture
def schema():
    import psycopg

    name = f"analytics_src_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(PG_DSN, autocommit=True) as connection:
        connection.execute(f"CREATE SCHEMA {name}")
        connection.execute(
            f"""
            CREATE TABLE {name}.medicines (medicine_code text, medicine_name text, category text, unit text,
              is_prescription text, min_stock int, max_stock int, pack_size int, lead_time_days int, supplier text);
            CREATE TABLE {name}.sales (sale_id text, line_no int, sale_datetime timestamp, sale_type text,
              store_code text, medicine_code text, batch_code text, quantity int, selling_price numeric(14,2),
              purchase_price numeric(14,2), payment_method text);
            CREATE TABLE {name}.inventory (store_code text, medicine_code text, batch_code text, quantity int,
              expiry_date date, purchase_price numeric(18,4), received_date timestamp, supplier text);
            CREATE TABLE {name}.change_marker (medicines text, sales text, inventory text);
            INSERT INTO {name}.change_marker VALUES ('m1', 's1', 'i1');
            INSERT INTO {name}.medicines VALUES
              ('TH0001', 'Paracetamol 500mg', 'Giảm đau', 'Viên', 'N', 50, NULL, 10, NULL, 'DKSH'),
              ('TH0002', 'Amoxicillin 500mg', 'Kháng sinh', 'Viên', 'Y', NULL, NULL, 100, 3, NULL);
            """
        )
        rows = []
        for day in range(1, 61):
            at = datetime(2026, 10, 29, 9) - timedelta(days=day)
            rows.append((f"HD{day}", 1, at, "retail", "NT01", "TH0001", "L1", 20, 1000, 600, "cash"))
            rows.append((f"HD{day}", 2, at, "retail", "NT02", "TH0002", None, 5, 3000, None, "transfer"))
        with connection.cursor() as cursor:
            cursor.executemany(f"INSERT INTO {name}.sales VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)
            cursor.execute(
                f"INSERT INTO {name}.inventory VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                ("NT01", "TH0001", "L1", 40, date(2027, 6, 1), 600, datetime(2026, 9, 1, 8), "DKSH"),
            )
    yield name
    with psycopg.connect(PG_DSN, autocommit=True) as connection:
        connection.execute(f"DROP SCHEMA {name} CASCADE")


@pg
def test_reads_views_with_postgres_types(schema):
    source = PostgresSource(PG_DSN, schema)
    marks = source.fingerprints({})
    assert [marks[name].sha256 for name in ("medicines", "sales", "inventory")] == ["m1", "s1", "i1"]
    assert marks["sales"].name == f"{schema}.sales"
    # Mốc không đổi: giữ đúng dấu cũ (kể cả thời điểm).
    assert source.fingerprints(marks) == marks

    results = source.load(AS_OF)
    assert {name: (result.rows_valid, result.rows_rejected) for name, result in results.items()} == {
        "medicines": (2, 0),
        "sales": (120, 0),
        "inventory": (1, 0),
    }
    sales = results["sales"].data
    assert results["sales"].file == f"{schema}.sales"
    assert sales["selling_price"].dtype == "float64" and sales["sale_datetime"].dt.year.min() == 2026
    assert results["medicines"].data.set_index("medicine_code").at["TH0001", "pack_size"] == 10


@pg
def test_pipeline_from_postgres_and_change_detection(schema, tmp_path):
    import psycopg

    store = AnalyticsStore(tmp_path / "analytics.db")
    pipeline = Pipeline(tmp_path, store, source=PostgresSource(PG_DSN, schema))
    first = pipeline.run(trigger="refresh", as_of=AS_OF)
    assert first.status == "processed"
    snapshot = store.latest_snapshot()
    assert snapshot["stores"] == ["NT01", "NT02"]
    assert snapshot["source"]["sales"]["name"] == f"{schema}.sales"
    assert snapshot["reorder"]["ALL"]["available"] is True
    # Không đổi gì: lần kiểm tra sau không đọc lại.
    assert pipeline.run(trigger="refresh", as_of=AS_OF + pd.Timedelta(seconds=30)).status == "unchanged"

    with psycopg.connect(PG_DSN, autocommit=True) as connection:
        connection.execute(
            f"INSERT INTO {schema}.sales VALUES ('HD999', 1, '2026-10-29 10:00', 'retail', 'NT01', 'TH0001', 'L1', 7, 1000, 600, 'cash')"
        )
        connection.execute(f"UPDATE {schema}.change_marker SET sales = 's2'")
    second = pipeline.run(trigger="refresh", as_of=AS_OF + pd.Timedelta(seconds=60))
    assert second.status == "processed"
    assert store.latest_snapshot()["kpi"]["NT01"]["periods"]["day"]["current"]["revenue"] == 7_000


@pg
def test_empty_sales_is_a_clear_error(schema):
    import psycopg

    with psycopg.connect(PG_DSN, autocommit=True) as connection:
        connection.execute(f"DELETE FROM {schema}.sales")
    with pytest.raises(LoadError, match="chưa có dòng bán hàng"):
        PostgresSource(PG_DSN, schema).load(AS_OF)
