import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

type SearchableTable = "products" | "active_ingredients" | "customers";

const COLUMN: Record<SearchableTable, string> = {
  products: "name",
  active_ingredients: "name",
  customers: "full_name",
};

/**
 * Tìm theo tên, không phân biệt hoa thường và không phân biệt dấu tiếng Việt
 * (contract §2, ERD §1.6). Dùng f_unaccent để khớp đúng chỉ mục trigram,
 * nên gõ "thuoc ho" vẫn ra "thuốc ho".
 */
export async function searchIdsByName(
  table: SearchableTable,
  term: string,
  limit = 200,
): Promise<string[]> {
  const column = COLUMN[table];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT id::text
      FROM ${Prisma.raw(`"${table}"`)}
      WHERE f_unaccent(lower(${Prisma.raw(`"${column}"`)})) LIKE '%' || f_unaccent(lower(${term})) || '%'
      LIMIT ${limit}`,
  );
  return rows.map((row) => row.id);
}

/**
 * Tìm sản phẩm theo tên, mã hoặc hoạt chất (contract §6.2).
 * Ở quầy, nhân viên hay gõ tên hoạt chất ("paracetamol") thay vì tên biệt dược,
 * nên cả ba đường tìm đều cần thiết.
 */
export async function searchProductIds(term: string, limit = 500): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT p.id::text
    FROM products p
    LEFT JOIN product_ingredients pi ON pi.product_id = p.id
    LEFT JOIN active_ingredients ai ON ai.id = pi.ingredient_id
    WHERE f_unaccent(lower(p.name)) LIKE '%' || f_unaccent(lower(${term})) || '%'
       OR lower(p.code) LIKE '%' || lower(${term}) || '%'
       OR f_unaccent(lower(ai.name)) LIKE '%' || f_unaccent(lower(${term})) || '%'
    LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}
