/**
 * Bổ sung danh mục thuốc cho nhà thuốc đã chạy.
 *
 * Chỉ **thêm**: mặt hàng, đơn vị, giá hay lô đã có thì bỏ qua, không sửa và
 * không xóa thứ gì đang có. Chạy lại nhiều lần vẫn an toàn.
 *
 * Tồn ban đầu của các mặt hàng mới đi đúng đường chứng từ: một phiếu nhập
 * loại "tồn đầu kỳ" đã kiểm nhập, có dòng phiếu, có lô và có thẻ kho — nhờ
 * vậy bất biến "tồn của lô bằng tổng thẻ kho" vẫn đúng ngay sau khi chạy.
 *
 *   npm run db:catalog
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { EXTRA_CATEGORIES, EXTRA_INGREDIENTS, EXTRA_PRODUCTS } from "./catalog-extra.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] ?? "" }),
});

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"] ?? "";
  const dbName = url.split("/").pop()?.split("?")[0] ?? "(không rõ)";
  console.log(`Bổ sung danh mục trên CSDL: ${dbName}`);

  const store = await prisma.store.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const admin = await prisma.user.findFirstOrThrow({
    where: { userRoles: { some: { role: { code: "admin" } } } },
    orderBy: { createdAt: "asc" },
  });

  // 1. Nhóm hàng và hoạt chất -----------------------------------------------
  for (const name of EXTRA_CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name } });
    if (!existing) await prisma.category.create({ data: { name } });
  }
  for (const name of EXTRA_INGREDIENTS) {
    const existing = await prisma.activeIngredient.findFirst({ where: { name } });
    if (!existing) await prisma.activeIngredient.create({ data: { name } });
  }

  // 2. Mặt hàng, đơn vị quy đổi và giá bán -----------------------------------
  let createdProducts = 0;
  for (const item of EXTRA_PRODUCTS) {
    const category = await prisma.category.findFirstOrThrow({ where: { name: item.categoryName } });
    const existing = await prisma.product.findUnique({ where: { code: item.code } });
    if (existing) continue;

    const product = await prisma.product.create({
      data: {
        code: item.code,
        name: item.name,
        productType: item.productType,
        drugClass: item.drugClass,
        categoryId: category.id,
        dosageForm: item.dosageForm,
        strengthText: item.strengthText ?? null,
        packagingText: item.packagingText,
        manufacturer: item.manufacturer,
        countryOfOrigin: item.countryOfOrigin,
        storageCondition: item.storageCondition,
        minStockBaseQuantity: item.minStockBaseQuantity,
      },
    });
    createdProducts += 1;

    for (const ingredient of item.ingredients) {
      const saved = await prisma.activeIngredient.findFirst({ where: { name: ingredient.name } });
      if (!saved) continue;
      await prisma.productIngredient.create({
        data: {
          productId: product.id,
          ingredientId: saved.id,
          strengthText: ingredient.strengthText,
        },
      });
    }

    for (const unit of item.units) {
      const savedUnit = await prisma.productUnit.create({
        data: {
          productId: product.id,
          name: unit.name,
          conversionToBase: unit.conversionToBase,
          isSellable: true,
          isDefaultSaleUnit: unit.isDefaultSaleUnit ?? false,
        },
      });
      await prisma.productPrice.create({
        data: {
          productUnitId: savedUnit.id,
          salePrice: BigInt(unit.salePrice),
          vatRatePercent: item.vatRatePercent,
          effectiveFrom: dayOffset(-1),
          createdBy: admin.id,
        },
      });
    }
  }

  // 3. Tồn ban đầu cho những mặt hàng chưa có lô nào -------------------------
  const pending: Array<{
    product: { id: string; code: string };
    unitId: string;
    conversionToBase: number;
    batch: (typeof EXTRA_PRODUCTS)[number]["batches"][number];
  }> = [];

  for (const item of EXTRA_PRODUCTS) {
    const product = await prisma.product.findUnique({
      where: { code: item.code },
      include: { units: true },
    });
    if (!product) continue;

    for (const batch of item.batches) {
      const already = await prisma.batch.findFirst({
        where: { storeId: store.id, productId: product.id, batchNumber: batch.batchNumber },
      });
      if (already) continue;
      const unit = product.units.find((candidate) => candidate.name === batch.unitName);
      if (!unit) continue;
      pending.push({
        product: { id: product.id, code: product.code },
        unitId: unit.id,
        conversionToBase: unit.conversionToBase,
        batch,
      });
    }
  }

  if (pending.length > 0) {
    const now = new Date();
    const prefix = `PN-${store.code}-${yyyymmdd(now)}-`;
    const countToday = await prisma.goodsReceipt.count({
      where: { storeId: store.id, code: { startsWith: prefix } },
    });

    await prisma.$transaction(
      async (tx) => {
        const receipt = await tx.goodsReceipt.create({
          data: {
            storeId: store.id,
            code: `${prefix}${String(countToday + 1).padStart(4, "0")}`,
            type: "OPENING_BALANCE",
            receivedAt: now,
            status: "CONFIRMED",
            note: "Tồn ban đầu của các mặt hàng bổ sung vào danh mục",
            createdBy: admin.id,
            confirmedBy: admin.id,
            confirmedAt: now,
          },
        });

        let lineNo = 0;
        let totalCost = 0n;

        for (const entry of pending) {
          const baseQuantity = entry.batch.quantity * entry.conversionToBase;
          const lineCost = BigInt(entry.batch.unitCost) * BigInt(entry.batch.quantity);
          lineNo += 1;

          const line = await tx.goodsReceiptLine.create({
            data: {
              goodsReceiptId: receipt.id,
              lineNo,
              productId: entry.product.id,
              productUnitId: entry.unitId,
              quantity: entry.batch.quantity,
              baseQuantity,
              unitCost: BigInt(entry.batch.unitCost),
              lineCost,
              batchNumber: entry.batch.batchNumber,
              expiryDate: dayOffset(entry.batch.expiryInDays),
            },
          });

          const batch = await tx.batch.create({
            data: {
              storeId: store.id,
              productId: entry.product.id,
              batchNumber: entry.batch.batchNumber,
              expiryDate: dayOffset(entry.batch.expiryInDays),
              quantityOnHand: baseQuantity,
              unitCost: (Number(lineCost) / baseQuantity).toFixed(4),
              sourceType: "GOODS_RECEIPT",
              sourceId: receipt.id,
            },
          });

          await tx.goodsReceiptLine.update({ where: { id: line.id }, data: { batchId: batch.id } });

          await tx.stockMovement.create({
            data: {
              storeId: store.id,
              batchId: batch.id,
              productId: entry.product.id,
              type: "OPENING_BALANCE",
              baseQuantity,
              balanceAfter: baseQuantity,
              sourceType: "GOODS_RECEIPT",
              sourceId: receipt.id,
              sourceLineId: line.id,
              userId: admin.id,
            },
          });

          totalCost += lineCost;
        }

        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { goodsAmount: totalCost, totalCost },
        });
      },
      { timeout: 60_000 },
    );
  }

  const [products, batches] = await Promise.all([prisma.product.count(), prisma.batch.count()]);
  console.log(`Đã thêm ${createdProducts} mặt hàng và ${pending.length} lô.`);
  console.log(`Danh mục hiện có: ${products} mặt hàng, ${batches} lô.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
