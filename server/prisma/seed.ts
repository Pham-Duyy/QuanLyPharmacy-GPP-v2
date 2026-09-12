import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PERMISSIONS, ROLES } from "../src/config/permissions.js";
import { CATEGORIES, INGREDIENTS, SUPPLIERS, PRODUCTS } from "./seed-catalog.js";

/**
 * Dữ liệu nền cho môi trường phát triển (docs/erd.md §12).
 * Chạy lại nhiều lần được: phần danh mục dùng upsert, phần tồn đầu kỳ chỉ
 * chạy khi kho còn trống.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] ?? "" }),
});

const STORE_CODE = "NT01";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "Admin@12345";

const SETTINGS: Array<{ key: string; value: unknown }> = [
  { key: "minRemainingShelfLifeDays", value: 0 },
  { key: "nearExpiryWarningDays", value: 30 },
  { key: "prescriptionValidityDays", value: 5 },
  { key: "returnWindowDays", value: 7 },
  { key: "invoiceVoidWindow", value: "SAME_BUSINESS_DAY" },
  { key: "discountLimitPercent", value: { sales_staff: 5, pharmacist: 10 } },
  { key: "storageLogPerDay", value: 2 },
];

const STORAGE_LOCATIONS = [
  { code: "RETAIL_AREA", name: "Khu bán lẻ", minTempC: null, maxTempC: 30, maxHumidityPercent: 75 },
  {
    code: "FRIDGE",
    name: "Tủ lạnh bảo quản thuốc",
    minTempC: 2,
    maxTempC: 8,
    maxHumidityPercent: null,
  },
];

async function seedStore() {
  return prisma.store.upsert({
    where: { code: STORE_CODE },
    update: {},
    create: {
      code: STORE_CODE,
      name: "Nhà thuốc GPP số 1",
      address: "Số 1, phố Sức Khỏe, Hà Nội",
      phone: "02412345678",
      gppCertificateNumber: "GPP-2026-0001",
      licenseNumber: "DKKD-2026-0001",
    },
  });
}

async function seedPermissionsAndRoles() {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { description: permission.description },
      create: permission,
    });
  }

  for (const role of ROLES) {
    const saved = await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: { code: role.code, name: role.name, isSystem: true },
    });

    // Ma trận quyền là nguồn duy nhất: xóa hết rồi gán lại theo seed-data.ts
    await prisma.rolePermission.deleteMany({ where: { roleId: saved.id } });
    await prisma.rolePermission.createMany({
      data: role.permissions.map((permissionCode) => ({ roleId: saved.id, permissionCode })),
    });
  }
}

async function seedAdmin(storeId: string) {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: { defaultStoreId: storeId },
    create: {
      username: ADMIN_USERNAME,
      passwordHash,
      fullName: "Quản trị hệ thống",
      mustChangePassword: true,
      defaultStoreId: storeId,
    },
  });

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "admin" } });

  // storeId để trống nghĩa là vai trò bao toàn chuỗi (contract §4.2).
  const existing = await prisma.userRole.findFirst({
    where: { userId: admin.id, roleId: adminRole.id, storeId: null },
  });
  if (!existing) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id, storeId: null },
    });
  }

  return admin;
}

async function seedSettingsAndLocations(storeId: string) {
  for (const setting of SETTINGS) {
    const existing = await prisma.setting.findFirst({ where: { key: setting.key, storeId: null } });
    if (existing) {
      await prisma.setting.update({
        where: { id: existing.id },
        data: { value: setting.value as never },
      });
    } else {
      await prisma.setting.create({ data: { key: setting.key, value: setting.value as never } });
    }
  }

  for (const location of STORAGE_LOCATIONS) {
    await prisma.storageLocation.upsert({
      where: { storeId_code: { storeId, code: location.code } },
      update: { name: location.name },
      create: {
        storeId,
        code: location.code,
        name: location.name,
        minTempC: location.minTempC,
        maxTempC: location.maxTempC,
        maxHumidityPercent: location.maxHumidityPercent,
      },
    });
  }
}

async function seedCatalog() {
  const categoryByName = new Map<string, string>();
  for (const name of CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name, parentId: null } });
    const category = existing ?? (await prisma.category.create({ data: { name } }));
    categoryByName.set(name, category.id);
  }

  const ingredientByName = new Map<string, string>();
  for (const name of INGREDIENTS) {
    const ingredient = await prisma.activeIngredient.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    ingredientByName.set(name, ingredient.id);
  }

  for (const supplier of SUPPLIERS) {
    const existing = await prisma.supplier.findFirst({ where: { name: supplier.name } });
    if (!existing) {
      await prisma.supplier.create({ data: supplier });
    }
  }

  for (const item of PRODUCTS) {
    const categoryId = categoryByName.get(item.categoryName);
    if (!categoryId) throw new Error(`Thiếu nhóm sản phẩm: ${item.categoryName}`);

    const product = await prisma.product.upsert({
      where: { code: item.code },
      update: { name: item.name },
      create: {
        code: item.code,
        name: item.name,
        productType: item.productType,
        drugClass: item.drugClass,
        categoryId,
        registrationNumber: item.registrationNumber ?? null,
        dosageForm: item.dosageForm ?? null,
        strengthText: item.strengthText ?? null,
        packagingText: item.packagingText ?? null,
        manufacturer: item.manufacturer ?? null,
        countryOfOrigin: item.countryOfOrigin ?? null,
        storageCondition: item.storageCondition ?? null,
        minStockBaseQuantity: item.minStockBaseQuantity,
      },
    });

    for (const ingredient of item.ingredients) {
      const ingredientId = ingredientByName.get(ingredient.name);
      if (!ingredientId) throw new Error(`Thiếu hoạt chất: ${ingredient.name}`);
      await prisma.productIngredient.upsert({
        where: { productId_ingredientId: { productId: product.id, ingredientId } },
        update: { strengthText: ingredient.strengthText },
        create: { productId: product.id, ingredientId, strengthText: ingredient.strengthText },
      });
    }

    for (const unit of item.units) {
      const savedUnit = await prisma.productUnit.upsert({
        where: { productId_name: { productId: product.id, name: unit.name } },
        update: { isSellable: unit.isSellable, isDefaultSaleUnit: unit.isDefaultSaleUnit ?? false },
        create: {
          productId: product.id,
          name: unit.name,
          conversionToBase: unit.conversionToBase,
          isSellable: unit.isSellable,
          isDefaultSaleUnit: unit.isDefaultSaleUnit ?? false,
        },
      });

      if (unit.barcode) {
        await prisma.productBarcode.upsert({
          where: { barcode: unit.barcode },
          update: { productUnitId: savedUnit.id },
          create: { productUnitId: savedUnit.id, barcode: unit.barcode },
        });
      }

      // Giá chung toàn chuỗi: chỉ tạo khi đơn vị chưa có bảng giá nào.
      const hasPrice = await prisma.productPrice.findFirst({
        where: { productUnitId: savedUnit.id, storeId: null },
      });
      if (!hasPrice) {
        await prisma.productPrice.create({
          data: {
            productUnitId: savedUnit.id,
            salePrice: BigInt(unit.salePrice),
            vatRatePercent: item.vatRatePercent,
            effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          },
        });
      }
    }
  }
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Tồn đầu kỳ đi đúng đường của phiếu nhập: tạo chứng từ, tạo lô, ghi thẻ kho.
 * Nhờ vậy bất biến "tồn của lô bằng tổng thẻ kho" vẫn đúng ngay sau khi seed.
 */
async function seedOpeningBalance(storeId: string, adminId: string) {
  const existing = await prisma.goodsReceipt.findFirst({
    where: { storeId, type: "OPENING_BALANCE" },
  });
  if (existing) {
    console.log("Đã có phiếu tồn đầu kỳ, bỏ qua bước này.");
    return;
  }

  const products = await prisma.product.findMany({ include: { units: true } });
  const productByCode = new Map(products.map((product) => [product.code, product]));
  const now = new Date();

  await prisma.$transaction(
    async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          storeId,
          code: `PN-${STORE_CODE}-${yyyymmdd(now)}-0001`,
          type: "OPENING_BALANCE",
          receivedAt: now,
          status: "CONFIRMED",
          note: "Tồn đầu kỳ khi bắt đầu dùng phần mềm",
          createdBy: adminId,
          confirmedBy: adminId,
          confirmedAt: now,
        },
      });

      let lineNo = 0;
      let totalCost = 0n;

      for (const item of PRODUCTS) {
        const product = productByCode.get(item.code);
        if (!product) throw new Error(`Thiếu sản phẩm ${item.code}`);

        for (const seedBatch of item.openingBatches) {
          const unit = product.units.find((candidate) => candidate.name === seedBatch.unitName);
          if (!unit) throw new Error(`Sản phẩm ${item.code} thiếu đơn vị ${seedBatch.unitName}`);

          const baseQuantity = seedBatch.quantity * unit.conversionToBase;
          const lineCost = BigInt(seedBatch.unitCost) * BigInt(seedBatch.quantity);
          lineNo += 1;

          const line = await tx.goodsReceiptLine.create({
            data: {
              goodsReceiptId: receipt.id,
              lineNo,
              productId: product.id,
              productUnitId: unit.id,
              quantity: seedBatch.quantity,
              baseQuantity,
              unitCost: BigInt(seedBatch.unitCost),
              lineCost,
              batchNumber: seedBatch.batchNumber,
              manufactureDate: seedBatch.manufactureDate
                ? new Date(seedBatch.manufactureDate)
                : null,
              expiryDate: new Date(seedBatch.expiryDate),
            },
          });

          const batch = await tx.batch.create({
            data: {
              storeId,
              productId: product.id,
              batchNumber: seedBatch.batchNumber,
              manufactureDate: seedBatch.manufactureDate
                ? new Date(seedBatch.manufactureDate)
                : null,
              expiryDate: new Date(seedBatch.expiryDate),
              quantityOnHand: baseQuantity,
              unitCost: (Number(lineCost) / baseQuantity).toFixed(4),
              sourceType: "GOODS_RECEIPT",
              sourceId: receipt.id,
            },
          });

          await tx.goodsReceiptLine.update({
            where: { id: line.id },
            data: { batchId: batch.id },
          });

          await tx.stockMovement.create({
            data: {
              storeId,
              batchId: batch.id,
              productId: product.id,
              type: "OPENING_BALANCE",
              baseQuantity,
              balanceAfter: baseQuantity,
              sourceType: "GOODS_RECEIPT",
              sourceId: receipt.id,
              sourceLineId: line.id,
              userId: adminId,
            },
          });

          totalCost += lineCost;
        }
      }

      await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { totalCost } });
    },
    { timeout: 30_000 },
  );
}

async function main() {
  const store = await seedStore();
  await seedPermissionsAndRoles();
  const admin = await seedAdmin(store.id);
  await seedSettingsAndLocations(store.id);
  await seedCatalog();
  await seedOpeningBalance(store.id, admin.id);

  const [permissions, roles, products, units, batches, movements] = await Promise.all([
    prisma.permission.count(),
    prisma.role.count(),
    prisma.product.count(),
    prisma.productUnit.count(),
    prisma.batch.count(),
    prisma.stockMovement.count(),
  ]);

  console.log("Seed xong:");
  console.log(`  cửa hàng      : ${store.code} - ${store.name}`);
  console.log(`  permission    : ${permissions}`);
  console.log(`  vai trò       : ${roles}`);
  console.log(`  sản phẩm      : ${products} (${units} đơn vị tính)`);
  console.log(`  lô thuốc      : ${batches}`);
  console.log(`  dòng thẻ kho  : ${movements}`);
  console.log(
    `  tài khoản     : ${ADMIN_USERNAME} / ${ADMIN_PASSWORD} (bắt buộc đổi khi đăng nhập lần đầu)`,
  );
}

main()
  .catch((error) => {
    console.error("Seed lỗi:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
