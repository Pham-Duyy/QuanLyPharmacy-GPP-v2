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
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
