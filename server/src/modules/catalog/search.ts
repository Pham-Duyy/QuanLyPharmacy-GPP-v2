import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

/**
 * Tìm kiếm danh mục.
 *
 * Hai lỗi đã sửa ở đây:
 *
 * 1. Trước đây hàm này trả về "tối đa 200/500 id khớp" rồi để tầng trên lọc
 *    và phân trang bằng `id IN (...)`: tổng số kết quả bị chặn ở mức trần và
 *    bản ghi khớp nằm ngoài trần thì không bao giờ tìm thấy.
 * 2. Sau đó tổng số được lấy từ `COUNT(*) OVER()` của chính trang đang xem,
 *    nên trang vượt quá số kết quả (không có dòng nào) trả tổng số 0 dù bộ
 *    lọc vẫn có dữ liệu.
 *
 * Nay điều kiện lọc được dựng một lần rồi dùng cho **hai câu lệnh**: một câu
 * đếm tổng và một câu lấy đúng trang. Tổng số vì thế không phụ thuộc vào việc
 * trang hiện tại có dòng nào.
 *
 * Tìm không phân biệt hoa thường và không phân biệt dấu tiếng Việt qua
 * `f_unaccent`, đúng biểu thức của chỉ mục trigram (ERD §1.6), nên gõ
 * "thuoc ho" vẫn ra "thuốc ho".
 */

type Page = { skip: number; limit: number; order: "asc" | "desc" };

function direction(order: "asc" | "desc") {
  return order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
}

/** Điều kiện khớp chuỗi không dấu cho một cột. */
function likeUnaccent(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`f_unaccent(lower(${column})) LIKE '%' || f_unaccent(lower(${term})) || '%'`;
}

export type ProductSearchFilters = {
  term: string | null;
  isActive: boolean;
  categoryId: string | null;
  productType: string | null;
  /** "RX,CONTROLLED" → lọc chung nhóm thuốc phải có đơn. */
  drugClasses: string[] | null;
  /** Chỉ lấy sản phẩm còn tồn bán được tại cửa hàng này. */
  inStockStoreId: string | null;
  /** Ngày làm việc hiện tại, để so hạn dùng của lô. */
  businessDate: Date;
};

const PRODUCT_SORT: Record<string, Prisma.Sql> = {
  name: Prisma.sql`p.name`,
  code: Prisma.sql`p.code`,
  createdAt: Prisma.sql`p.created_at`,
};

/** Điều kiện WHERE dùng chung cho câu đếm và câu lấy trang. */
function productWhere(filters: ProductSearchFilters): Prisma.Sql {
  const term = filters.term;
  const search = term
    ? Prisma.sql`AND (
        ${likeUnaccent(Prisma.sql`p.name`, term)}
        OR lower(p.code) LIKE '%' || lower(${term}) || '%'
        OR EXISTS (
          SELECT 1 FROM product_ingredients pi
          JOIN active_ingredients ai ON ai.id = pi.ingredient_id
          WHERE pi.product_id = p.id AND ${likeUnaccent(Prisma.sql`ai.name`, term)}
        )
        OR EXISTS (
          SELECT 1 FROM product_units pu
          JOIN product_barcodes pb ON pb.product_unit_id = pu.id
          WHERE pu.product_id = p.id AND pb.barcode = ${term}
        )
      )`
    : Prisma.empty;

  const inStock = filters.inStockStoreId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM batches b
        WHERE b.product_id = p.id
          AND b.store_id = ${filters.inStockStoreId}::uuid
          AND b.status = 'AVAILABLE'
          AND b.quantity_on_hand > 0
          AND b.expiry_date > ${filters.businessDate}::date
      )`
    : Prisma.empty;

  return Prisma.sql`
    p.is_active = ${filters.isActive}
    ${filters.categoryId ? Prisma.sql`AND p.category_id = ${filters.categoryId}::uuid` : Prisma.empty}
    ${filters.productType ? Prisma.sql`AND p.product_type = ${filters.productType}` : Prisma.empty}
    ${filters.drugClasses ? Prisma.sql`AND p.drug_class = ANY(${filters.drugClasses}::text[])` : Prisma.empty}
    ${search}
    ${inStock}
  `;
}

/**
 * Một trang sản phẩm theo bộ lọc, kèm **tổng số thật** của cả bộ lọc.
 * Trả về danh sách id đúng thứ tự để tầng trên nạp chi tiết bằng Prisma.
 */
export async function searchProductPage(
  filters: ProductSearchFilters,
  sortBy: string,
  page: Page,
): Promise<{ ids: string[]; total: number }> {
  const where = productWhere(filters);

  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p.id::text
      FROM products p
      WHERE ${where}
      ORDER BY ${PRODUCT_SORT[sortBy] ?? PRODUCT_SORT["name"]!} ${direction(page.order)}, p.id
      LIMIT ${page.limit} OFFSET ${page.skip}
    `),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total FROM products p WHERE ${where}
    `),
  ]);

  return { ids: rows.map((row) => row.id), total: counted[0]?.total ?? 0 };
}

/** Một trang hoạt chất đang dùng, kèm tổng số thật. */
export async function searchIngredientPage(
  term: string | null,
  page: Page,
): Promise<{ ids: string[]; total: number }> {
  const where = Prisma.sql`
    ai.is_active = true
    ${term ? Prisma.sql`AND ${likeUnaccent(Prisma.sql`ai.name`, term)}` : Prisma.empty}
  `;

  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT ai.id::text
      FROM active_ingredients ai
      WHERE ${where}
      ORDER BY ai.name ${direction(page.order)}, ai.id
      LIMIT ${page.limit} OFFSET ${page.skip}
    `),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total FROM active_ingredients ai WHERE ${where}
    `),
  ]);

  return { ids: rows.map((row) => row.id), total: counted[0]?.total ?? 0 };
}

/** Sắp xếp lại bản ghi đã nạp theo đúng thứ tự id của trang. */
export function orderByIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
}
