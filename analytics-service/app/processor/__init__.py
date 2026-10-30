"""Data Processor: đọc, làm sạch, kiểm tra dữ liệu Excel/CSV."""

from .issues import DataIssue
from .loader import LoadError
from .schemas import MEDICINES, SALES, SCHEMAS
from .service import ProcessResult, process_file, process_folder

__all__ = ["DataIssue", "LoadError", "MEDICINES", "SALES", "SCHEMAS", "ProcessResult", "process_file", "process_folder"]
