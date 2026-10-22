import { z } from "zod";

export const reportsQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((value) => value.to > value.from, {
    message: "to phải sau from",
    path: ["to"],
  });

export const monthlyQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month phải có dạng YYYY-MM"),
});
