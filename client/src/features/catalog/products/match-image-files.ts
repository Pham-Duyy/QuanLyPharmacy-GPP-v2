/**
 * Ghép tên tệp ảnh với sản phẩm trong danh mục, phục vụ màn tải ảnh hàng loạt.
 *
 * Quy ước đặt tên: đặt tên tệp theo **mã sản phẩm** (`TH0019.jpg`) hoặc theo
 * **đúng tên sản phẩm** (`Efferalgan 500mg.jpg`). Muốn nhiều ảnh cho một
 * sản phẩm thì thêm số thứ tự ở cuối: `TH0019-2.jpg`, `TH0019 (3).jpg`.
 *
 * Mã sản phẩm thường tận cùng bằng số nên hậu tố đánh số chỉ được cắt khi
 * tên nguyên vẹn không khớp với mã nào — `TH0019.jpg` không bao giờ bị hiểu
 * nhầm thành `TH001` ảnh số 9.
 */

export type MatchTarget = { id: string; code: string; name: string };

export type FileMatch = {
  /** Khóa ổn định cho từng dòng bảng: tên tệp có thể trùng nhau. */
  key: string;
  file: File;
  product: MatchTarget | null;
  matchedBy: "code" | "name" | null;
};

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Bỏ phần mở rộng; tên bắt đầu bằng dấu chấm thì giữ nguyên. */
function fileStem(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Một hậu tố đánh số ở cuối: "-2", "_2", " 2", " (2)", "-copy" thì không. */
const NUMBER_SUFFIX = /[\s._-]*(?:\(\s*\d{1,3}\s*\)|\d{1,3})$/;

export function matchImageFiles(files: File[], products: MatchTarget[]): FileMatch[] {
  const byCode = new Map<string, MatchTarget>();
  for (const product of products) byCode.set(normalize(product.code), product);

  // Hai sản phẩm trùng tên thì không đoán bừa, chỉ ghép được bằng mã.
  const byName = new Map<string, MatchTarget>();
  const ambiguous = new Set<string>();
  for (const product of products) {
    const key = normalize(product.name);
    if (byName.has(key)) ambiguous.add(key);
    byName.set(key, product);
  }

  type Hit = { product: MatchTarget; matchedBy: "code" | "name" };

  function lookup(candidate: string): Hit | null {
    const key = normalize(candidate);
    if (!key) return null;
    const byCodeHit = byCode.get(key);
    if (byCodeHit) return { product: byCodeHit, matchedBy: "code" };
    const byNameHit = ambiguous.has(key) ? undefined : byName.get(key);
    if (byNameHit) return { product: byNameHit, matchedBy: "name" };
    return null;
  }

  /**
   * Sắp theo phần tên trước dấu chấm, có hiểu số: "TH0019" lên trước
   * "TH0019-2", và "TH0019-2" trước "TH0019-10". Ảnh tải lên đầu tiên thành
   * ảnh chính, nên tệp đặt tên trần phải được xử lý trước các tệp đánh số.
   */
  const ordered = [...files].sort(
    (a, b) =>
      fileStem(a.name).localeCompare(fileStem(b.name), "vi", { numeric: true }) ||
      a.name.localeCompare(b.name, "vi", { numeric: true }),
  );

  return ordered.map((file, index) => {
    const stem = fileStem(file.name);
    const hit = lookup(stem) ?? lookup(stem.replace(NUMBER_SUFFIX, ""));
    return {
      key: `${index}-${file.name}-${file.size}`,
      file,
      product: hit?.product ?? null,
      matchedBy: hit?.matchedBy ?? null,
    };
  });
}
