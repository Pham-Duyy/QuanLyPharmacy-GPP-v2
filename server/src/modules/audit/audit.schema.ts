import { z } from "zod";

export const listAuditLogsSchema = z.object({
  actorId: z.uuid("actorId không hợp lệ").optional(),
  action: z.string().trim().max(100).optional(),
  resourceType: z.string().trim().max(100).optional(),
  resourceId: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().regex(/^\d+$/, "cursor không hợp lệ").optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsSchema>;
