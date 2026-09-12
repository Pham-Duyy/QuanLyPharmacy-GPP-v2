import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { pool } from "./pool.js";

/**
 * Một PrismaClient dùng chung cho toàn ứng dụng.
 * Prisma 7 bắt buộc truyền driver adapter; ở đây dùng lại đúng pool ở pool.ts
 * nên toàn hệ thống chỉ có một nguồn kết nối tới PostgreSQL.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
