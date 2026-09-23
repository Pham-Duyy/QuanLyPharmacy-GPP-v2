import { z } from "zod";

export const SCOPE_TYPES = ["ALL", "CATEGORY", "SHELF"] as const;

export const openCountSchema = z
  .object({
    scopeType: z.enum(SCOPE_TYPES).default("ALL"),
    /** categoryId khi đếm theo nhóm hàng, tên kệ khi đếm theo kệ. */
    scopeValue: z.string().trim().min(1).max(200).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((input) => input.scopeType === "ALL" || Boolean(input.scopeValue), {
    message: "Chọn nhóm hàng hoặc kệ cần kiểm kê",
    path: ["scopeValue"],
  });

export type OpenCountInput = z.infer<typeof openCountSchema>;

/** Ghi số đếm nhiều dòng một lượt: người đếm nhập cả kệ rồi mới lưu. */
export const saveCountsSchema = z.object({
  entries: z
    .array(
      z.object({
        lineId: z.uuid("lineId không hợp lệ"),
        unitId: z.uuid("unitId không hợp lệ").nullish(),
        quantity: z.coerce.number().int().min(0).max(1_000_000).nullish(),
        note: z.string().trim().max(300).nullish(),
        /** true: xóa số đếm, đưa dòng về trạng thái chưa đếm. */
        clear: z.boolean().optional(),
      }),
    )
    .min(1, "Chưa có dòng nào để lưu")
    .max(500, "Mỗi lần lưu tối đa 500 dòng"),
});

export type SaveCountsInput = z.infer<typeof saveCountsSchema>;

export const addLineSchema = z.object({
  batchId: z.uuid("batchId không hợp lệ"),
});

export const closeCountSchema = z.object({
  note: z.string().trim().max(500).nullish(),
});

export const listCountsSchema = z.object({
  status: z.enum(["COUNTING", "CLOSED", "CANCELLED"]).optional(),
});

export const countLinesQuerySchema = z.object({
  /** Lọc để đếm cho nhanh: chưa đếm, đã đếm, chỉ dòng lệch. */
  filter: z.enum(["ALL", "PENDING", "COUNTED", "DIFF"]).default("ALL"),
  q: z.string().trim().max(100).optional(),
  shelf: z.string().trim().max(100).optional(),
});
