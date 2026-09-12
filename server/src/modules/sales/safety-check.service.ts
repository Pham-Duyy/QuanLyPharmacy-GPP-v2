import { Prisma } from "../../generated/prisma/client.js";
import { businessDateNow, getSetting } from "../../lib/settings.js";
import { findSellableBatches, sumByProduct, type ResolvedLine } from "./cart.js";

type Tx = Prisma.TransactionClient;

/** Đổi khi luật kiểm tra thay đổi, để hóa đơn cũ tra được đã kiểm theo luật nào. */
const RULE_VERSION = "2026-09-12";

export type Blocking = {
  code: string;
  productId: string;
  message: string;
  requestedBaseQuantity?: number;
  sellableBaseQuantity?: number;
};

export type Warning = {
  code: string;
  severity: "INFO" | "MEDIUM" | "HIGH";
  requiresAck: boolean;
  productIds: string[];
  message: string;
  source: string;
  sourceVersion: string;
};

export type NotChecked = { productId: string; reason: string };

export type SafetyResult = {
  blocking: Blocking[];
  warnings: Warning[];
  notChecked: NotChecked[];
};

export type SafetyParams = {
  storeId: string;
  lines: ResolvedLine[];
  customerId?: string | null;
  prescriptionId?: string | null;
};

/**
 * Kiểm tra an toàn tất định của contract §13. Không gọi LLM, không đoán:
 * mọi kết luận đều suy ra từ dữ liệu trong CSDL và luật ghi ở đây.
 *
 * Ba nhóm kết quả có ý nghĩa khác hẳn nhau:
 * - `blocking` là vi phạm luật cứng, không bỏ qua được;
 * - `warnings` cần người bán cân nhắc, loại `requiresAck` phải ghi nhận mới bán;
 * - `notChecked` là những gì hệ thống **không** kiểm tra được, phải hiển thị
 *   rõ cho người bán chứ không được coi là an toàn.
 */
export async function runSafetyCheck(tx: Tx, params: SafetyParams): Promise<SafetyResult> {
  const { lines, storeId } = params;
  const blocking: Blocking[] = [];
  const warnings: Warning[] = [];
  const notChecked: NotChecked[] = [];

  const productIds = [...new Set(lines.map((line) => line.productId))];

  // 1. Thuốc kiểm soát đặc biệt: chưa có sổ theo dõi thì chặn bán (contract §22).
  for (const productId of productIds) {
    const line = lines.find((item) => item.productId === productId)!;
    if (line.drugClass === "CONTROLLED") {
      blocking.push({
        code: "CONTROLLED_DRUG_NOT_SUPPORTED",
        productId,
        message: `${line.productName} là thuốc kiểm soát đặc biệt, phiên bản này chưa bán được`,
      });
    }
  }

  // 2. Thuốc kê đơn phải có đơn đã được dược sĩ xác nhận và còn hiệu lực.
  const rxProductIds = productIds.filter(
    (productId) =>
      lines.find((item) => item.productId === productId)!.drugClass === "RX" ||
      lines.find((item) => item.productId === productId)!.drugClass === "CONTROLLED",
  );

  if (rxProductIds.length > 0) {
    const prescription = params.prescriptionId
      ? await tx.prescription.findUnique({ where: { id: params.prescriptionId } })
      : null;

    for (const productId of rxProductIds) {
      const line = lines.find((item) => item.productId === productId)!;
      if (!prescription) {
        blocking.push({
          code: "PRESCRIPTION_REQUIRED",
          productId,
          message: `${line.productName} là thuốc kê đơn, phải có đơn thuốc đã xác nhận`,
        });
      } else if (!["VERIFIED", "PARTIALLY_DISPENSED"].includes(prescription.status)) {
        blocking.push({
          code: "PRESCRIPTION_NOT_VERIFIED",
          productId,
          message: `Đơn thuốc ${prescription.code} đang ở trạng thái ${prescription.status}, chưa bán được`,
        });
      } else if (prescription.validUntil < businessDateNow()) {
        blocking.push({
          code: "PRESCRIPTION_EXPIRED",
          productId,
          message: `Đơn thuốc ${prescription.code} đã hết hiệu lực`,
        });
      }
    }
  }

  // 3. Tồn bán được, tính theo đơn vị nhỏ nhất và chỉ đếm lô bán được.
  const minRemainingDays = await getSetting("minRemainingShelfLifeDays", storeId);
  const batches = await findSellableBatches(tx, storeId, productIds, minRemainingDays);
  const sellable = sumByProduct(batches);

  const requested = new Map<string, number>();
  for (const line of lines) {
    requested.set(line.productId, (requested.get(line.productId) ?? 0) + line.baseQuantity);
  }

  for (const [productId, needed] of requested) {
    const available = sellable.get(productId) ?? 0;
    if (available < needed) {
      const line = lines.find((item) => item.productId === productId)!;
      blocking.push({
        code: "INSUFFICIENT_STOCK",
        productId,
        message: `${line.productName} chỉ còn ${available} theo đơn vị nhỏ nhất, cần ${needed}`,
        requestedBaseQuantity: needed,
        sellableBaseQuantity: available,
      });
    }
  }

  // 4. Hoạt chất: nền của cả cảnh báo trùng hoạt chất lẫn cảnh báo dị ứng.
  const mappings = await tx.productIngredient.findMany({
    where: { productId: { in: productIds } },
    include: { ingredient: { select: { id: true, name: true } } },
  });

  const ingredientsByProduct = new Map<string, Array<{ id: string; name: string }>>();
  for (const mapping of mappings) {
    const bucket = ingredientsByProduct.get(mapping.productId) ?? [];
    bucket.push(mapping.ingredient);
    ingredientsByProduct.set(mapping.productId, bucket);
  }

  for (const productId of productIds) {
    if (!ingredientsByProduct.has(productId)) {
      notChecked.push({ productId, reason: "NO_INGREDIENT_MAPPING" });
    }
    // Tương tác thuốc nằm ngoài MVP vì chưa có nguồn dữ liệu đáng tin cậy,
    // và không được thay bằng suy đoán của LLM (contract §13).
    notChecked.push({ productId, reason: "INTERACTION_SOURCE_NOT_CONFIGURED" });
  }

  // 5. Trùng hoạt chất giữa hai sản phẩm khác nhau trong cùng giỏ hàng.
  const productsByIngredient = new Map<string, { name: string; productIds: Set<string> }>();
  for (const [productId, ingredients] of ingredientsByProduct) {
    for (const ingredient of ingredients) {
      const entry = productsByIngredient.get(ingredient.id) ?? {
        name: ingredient.name,
        productIds: new Set<string>(),
      };
      entry.productIds.add(productId);
      productsByIngredient.set(ingredient.id, entry);
    }
  }

  for (const entry of productsByIngredient.values()) {
    if (entry.productIds.size < 2) continue;
    warnings.push({
      code: "DUPLICATE_INGREDIENT",
      severity: "HIGH",
      requiresAck: true,
      productIds: [...entry.productIds],
      message: `Các sản phẩm trong giỏ cùng chứa ${entry.name}, nguy cơ quá liều`,
      source: "rule:duplicate-ingredient",
      sourceVersion: RULE_VERSION,
    });
  }

  // 6. Dị ứng theo hồ sơ của khách, đối chiếu theo hoạt chất.
  if (params.customerId) {
    const allergies = await tx.customerAllergy.findMany({
      where: { customerId: params.customerId },
      include: { ingredient: { select: { id: true, name: true } } },
    });

    for (const allergy of allergies) {
      const hit = [...ingredientsByProduct.entries()]
        .filter(([, ingredients]) => ingredients.some((item) => item.id === allergy.ingredientId))
        .map(([productId]) => productId);

      if (hit.length === 0) continue;
      warnings.push({
        code: "ALLERGY_MATCH",
        severity: "HIGH",
        requiresAck: true,
        productIds: hit,
        message: `Hồ sơ khách ghi nhận dị ứng ${allergy.ingredient.name}`,
        source: "rule:customer-allergy",
        sourceVersion: RULE_VERSION,
      });
    }
  }

  // 7. Lô sắp hết hạn: chỉ nhắc, không chặn và không cần ghi nhận.
  const nearExpiryDays = await getSetting("nearExpiryWarningDays", storeId);
  const threshold = new Date(businessDateNow());
  threshold.setUTCDate(threshold.getUTCDate() + nearExpiryDays);

  const nearExpiry = batches.filter(
    (batch) => batch.expiryDate <= threshold && requested.has(batch.productId),
  );
  for (const batch of nearExpiry) {
    warnings.push({
      code: "NEAR_EXPIRY_BATCH",
      severity: "MEDIUM",
      requiresAck: false,
      productIds: [batch.productId],
      message: `Lô ${batch.batchNumber} hết hạn ngày ${batch.expiryDate.toISOString().slice(0, 10)}`,
      source: "rule:near-expiry",
      sourceVersion: RULE_VERSION,
    });
  }

  return { blocking, warnings, notChecked };
}
