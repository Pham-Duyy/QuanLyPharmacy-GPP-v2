import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { SIZES, renderLabels, type LabelSize } from "./labels.js";

export const labelsRouter = Router();
labelsRouter.use("/labels", authenticate, storeContext, requireStore);

const printSchema = z.object({
  size: z.enum(Object.keys(SIZES) as [LabelSize, ...LabelSize[]]).default("50x30"),
  showPrice: z.boolean().default(true),
  showBatch: z.boolean().default(false),
  showStoreName: z.boolean().default(true),
  items: z
    .array(
      z.object({
        productId: z.uuid("productId không hợp lệ"),
        unitId: z.uuid("unitId không hợp lệ").nullish(),
        batchId: z.uuid("batchId không hợp lệ").nullish(),
        quantity: z.coerce.number().int().min(1, "Số tem phải lớn hơn 0").max(500, "Mỗi mặt hàng tối đa 500 tem"),
      }),
    )
    .min(1, "Chưa chọn mặt hàng nào để in tem")
    .max(200, "Mỗi lần in tối đa 200 mặt hàng"),
});

/** GET /api/v1/labels/sizes: các khổ tem hỗ trợ, để giao diện dựng danh sách chọn. */
labelsRouter.get("/labels/sizes", requirePermission("catalog.read"), (_req, res) => {
  sendData(
    res,
    Object.entries(SIZES).map(([value, spec]) => ({ value, label: spec.label, width: spec.width, height: spec.height, sheet: spec.columns !== null })),
  );
});

/**
 * POST /api/v1/labels/print: dựng trang tem để in. Chỉ đọc dữ liệu, in bao
 * nhiêu lần cũng không đổi tồn kho hay giá. `?autoprint=0` để chỉ xem trước.
 */
labelsRouter.post("/labels/print", requirePermission("catalog.read"), async (req, res) => {
  const input = parseOrThrow(printSchema, req.body);
  const result = await renderLabels(
    req.auth!.storeId!,
    input.items,
    {
      size: input.size,
      showPrice: input.showPrice,
      showBatch: input.showBatch,
      showStoreName: input.showStoreName,
      autoPrint: req.query["autoprint"] !== "0",
    },
  );

  res
    .set("X-Label-Count", String(result.labelCount))
    // Cảnh báo (thiếu mã vạch, thiếu giá) gửi kèm header vì thân phản hồi là HTML.
    .set("X-Label-Warnings", encodeURIComponent(JSON.stringify(result.warnings)))
    .type("html")
    .send(result.html);
});
