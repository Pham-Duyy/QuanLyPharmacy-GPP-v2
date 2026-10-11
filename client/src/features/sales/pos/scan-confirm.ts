/**
 * Quét xác nhận lấy đúng thuốc ở quầy. Mỗi lần quét nghĩa là "đang cầm
 * một hộp thuốc này trên tay": dòng chưa quét đủ thì chỉ đánh dấu đúng
 * thuốc, quét đủ rồi mới tăng số lượng như trước.
 */
export type ScanLine = {
  key: string;
  product: { id: string };
  unitId: string;
  quantity: number;
  /** Số lần quét đã khớp vào dòng này; lớn hơn 0 là đã xác nhận đúng thuốc. */
  scanned: number;
  /** Dòng tự điền từ đơn thuốc, người bán còn phải đi lấy. */
  fromPrescription?: boolean;
};

/**
 * Áp một lần quét vào giỏ. Thứ tự: dòng cùng đơn vị còn chưa quét đủ → dòng
 * cùng thuốc khác đơn vị chưa quét (quét mã hộp khi bán lẻ vỉ, viên vẫn là
 * đúng thuốc) → dòng cùng đơn vị đã quét đủ thì thêm 1 → không có thì thêm
 * dòng mới bằng `newLine`.
 */
export function applyScan<T extends ScanLine>(
  lines: T[],
  productId: string,
  unitId: string,
  newLine: () => T,
): T[] {
  const sameProduct = lines.filter((line) => line.product.id === productId);
  const sameUnit = sameProduct.filter((line) => line.unitId === unitId);
  const confirm =
    sameUnit.find((line) => line.scanned < line.quantity) ??
    sameProduct.find((line) => line.unitId !== unitId && line.scanned === 0);
  if (confirm)
    return lines.map((line) =>
      line.key === confirm.key ? { ...line, scanned: line.scanned + 1 } : line,
    );
  const increment = sameUnit[0];
  if (increment)
    return lines.map((line) =>
      line.key === increment.key
        ? { ...line, quantity: line.quantity + 1, scanned: line.scanned + 1 }
        : line,
    );
  return [...lines, newLine()];
}

/** Lần quét này chỉ đánh dấu đúng thuốc (không thêm, không tăng số lượng). */
export function scanConfirmsLine(lines: ScanLine[], productId: string, unitId: string): boolean {
  return lines.some(
    (line) =>
      line.product.id === productId &&
      (line.unitId === unitId ? line.scanned < line.quantity : line.scanned === 0),
  );
}

/**
 * Dòng đơn thuốc chưa lấy mà lại quét một thuốc không có trong giỏ lẫn trong
 * đơn: nhiều khả năng lấy nhầm (thuốc nhìn giống, tên gần giống), hỏi lại
 * trước khi thêm. Bán thường không có dòng tự điền nên không bị hỏi.
 */
export function pendingPicks<T extends ScanLine>(
  lines: T[],
  productId: string,
  inPrescription: boolean,
): T[] {
  if (inPrescription || lines.some((line) => line.product.id === productId)) return [];
  return lines.filter((line) => line.fromPrescription && line.scanned === 0);
}
