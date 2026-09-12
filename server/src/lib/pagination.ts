import { z } from "zod";
import { parseOrThrow } from "./validate.js";

/** Quy ước phân trang và sắp xếp ở contract §2. */
export const MAX_LIMIT = 100;

export type PageQuery = {
  page: number;
  limit: number;
  skip: number;
  sortBy: string;
  order: "asc" | "desc";
};

export function parsePageQuery(
  query: unknown,
  options: { sortable: readonly string[]; defaultSort: string },
): PageQuery {
  const schema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(20),
    sortBy: z.enum(options.sortable as [string, ...string[]]).default(options.defaultSort),
    order: z.enum(["asc", "desc"]).default("desc"),
  });

  const parsed = parseOrThrow(schema, query);
  return { ...parsed, skip: (parsed.page - 1) * parsed.limit };
}

export function pageResult<T>(items: T[], total: number, page: PageQuery) {
  return { items, pagination: { page: page.page, limit: page.limit, total } };
}
