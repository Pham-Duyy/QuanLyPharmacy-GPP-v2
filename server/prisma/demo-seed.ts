/**
 * Dữ liệu cho buổi demo.
 *
 * Chỉ **thêm**, không xóa và không sửa dữ liệu đang có: mọi thứ tạo ra đều
 * mang dấu hiệu demo (mã lô `DEMO-*`, khách "Chị Lan (demo)", tài khoản
 * `demo`). Chạy lại nhiều lần vẫn an toàn.
 *
 * Nó chuẩn bị sẵn những thứ không kịp bấm tay khi đang đứng trước người xem:
 * lô sắp hết hạn, mặt hàng dưới tồn tối thiểu, khách đã có điểm, đơn thuốc đã
 * duyệt, và một phiếu nhập còn nháp để kiểm nhập ngay trên sân khấu.
 *
 *   npm run db:demo
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashPassword } from "../src/lib/password.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] ?? "" }),
});

const DEMO_PASSWORD = "Demo@12345";

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"] ?? "";
  const dbName = url.split("/").pop()?.split("?")[0] ?? "(không rõ)";
  console.log(`Đang chuẩn bị dữ liệu demo trên CSDL: ${dbName}`);
  if (/prod/i.test(dbName)) {
    throw new Error("Không chạy dữ liệu demo trên cơ sở dữ liệu có tên giống môi trường thật");
  }

  const store = await prisma.store.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const para = await prisma.product.findUnique({
    where: { code: "TH0001" },
    include: { units: true },
  });
  const amox = await prisma.product.findUnique({
    where: { code: "TH0002" },
    include: { units: true },
  });
  const vitamin = await prisma.product.findUnique({
    where: { code: "TP0001" },
    include: { units: true },
  });
  if (!para || !amox || !vitamin) {
    throw new Error("Thiếu dữ liệu nền (TH0001, TH0002, TP0001). Chạy `npm run db:seed` trước.");
  }
  const paraBase = para.units.find((unit) => unit.conversionToBase === 1)!;
  const amoxBase = amox.units.find((unit) => unit.conversionToBase === 1)!;

  // 1. Tài khoản dược sĩ dùng riêng cho demo, mật khẩu biết trước ----------
  const pharmacistRole = await prisma.role.findUniqueOrThrow({ where: { code: "pharmacist" } });
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const demoUser = await prisma.user.upsert({
    where: { username: "demo" },
    update: { passwordHash, mustChangePassword: false, isActive: true },
    create: {
      username: "demo",
      passwordHash,
      fullName: "Dược sĩ trình bày",
      defaultStoreId: store.id,
      mustChangePassword: false,
    },
  });
  const hasRole = await prisma.userRole.findFirst({
    where: { userId: demoUser.id, roleId: pharmacistRole.id },
  });
  if (!hasRole) {
    await prisma.userRole.create({
      data: { userId: demoUser.id, roleId: pharmacistRole.id, storeId: store.id },
    });
  }

  // Tài khoản chủ nhà thuốc: báo cáo doanh thu và công nợ chỉ vai trò này mới
  // xem được, nên buổi demo cần sẵn cả hai để cho thấy phân quyền là thật.
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "admin" } });
  const demoOwner = await prisma.user.upsert({
    where: { username: "demochu" },
    update: { passwordHash, mustChangePassword: false, isActive: true },
    create: {
      username: "demochu",
      passwordHash,
      fullName: "Chủ nhà thuốc (demo)",
      defaultStoreId: store.id,
      mustChangePassword: false,
    },
  });
  const ownerRole = await prisma.userRole.findFirst({
    where: { userId: demoOwner.id, roleId: adminRole.id },
  });
  if (!ownerRole) {
    await prisma.userRole.create({
      data: { userId: demoOwner.id, roleId: adminRole.id, storeId: store.id },
    });
  }

  // 2. Lô sắp hết hạn: màn "Hàng cận hạn" có dữ liệu đỏ ---------------------
  await prisma.batch.upsert({
    where: {
      storeId_productId_batchNumber: {
        storeId: store.id,
        productId: para.id,
        batchNumber: "DEMO-CANHAN",
      },
    },
    update: { quantityOnHand: 240, expiryDate: dayOffset(18) },
    create: {
      storeId: store.id,
      productId: para.id,
      batchNumber: "DEMO-CANHAN",
      expiryDate: dayOffset(18),
      quantityOnHand: 240,
      unitCost: 700,
      shelfLocation: "Kệ A1",
      status: "AVAILABLE",
      sourceType: "OPENING_BALANCE",
    },
  });

  // 3. Mặt hàng dưới tồn tối thiểu: màn "Đề xuất đặt hàng" có dữ liệu -------
  await prisma.product.update({
    where: { id: vitamin.id },
    data: { minStockBaseQuantity: 600 },
  });

  // 4. Khách hàng đã có điểm, chương trình tích điểm đang bật --------------
  await prisma.setting.upsert({
    where: { id: (await prisma.setting.findFirst({ where: { key: "loyaltySettings", storeId: store.id } }))?.id ?? "00000000-0000-0000-0000-000000000000" },
    update: {},
    create: {
      key: "loyaltySettings",
      storeId: store.id,
      value: {
        enabled: true,
        earnAmountPerPoint: 10_000,
        pointValue: 500,
        minRedeemPoints: 10,
        maxRedeemPercent: 50,
        expiryMonths: 12,
        earnOnDrugs: false,
      },
      updatedBy: demoUser.id,
    },
  });

  const customer = await prisma.customer.findFirst({ where: { fullName: "Chị Lan (demo)" } });
  const demoCustomer =
    customer ??
    (await prisma.customer.create({
      data: { fullName: "Chị Lan (demo)", phone: "0901234567", address: "12 Lê Lợi, Q.1" },
    }));
  const hasPoints = await prisma.loyaltyTransaction.findFirst({ where: { customerId: demoCustomer.id } });
  if (!hasPoints) {
    await prisma.loyaltyTransaction.create({
      data: {
        storeId: store.id,
        customerId: demoCustomer.id,
        type: "ADJUST",
        points: 40,
        note: "Điểm chuẩn bị cho buổi demo",
        expiresAt: dayOffset(365),
        createdBy: demoUser.id,
      },
    });
  }

  // 5. Đơn thuốc đã duyệt, sẵn sàng bán thuốc kê đơn ------------------------
  const existingRx = await prisma.prescription.findFirst({ where: { externalCode: "DEMO-RX" } });
  if (!existingRx) {
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
      .format(new Date())
      .replace(/-/g, "");
    const count = await prisma.prescription.count({ where: { storeId: store.id } });
    await prisma.prescription.create({
      data: {
        storeId: store.id,
        code: `DT-${store.code}-${day}-${String(count + 900).padStart(4, "0")}`,
        externalCode: "DEMO-RX",
        customerId: demoCustomer.id,
        prescriberName: "BS. Trần Văn An",
        facilityName: "Bệnh viện Quận 1",
        diagnosisText: "Viêm họng cấp",
        prescribedDate: dayOffset(0),
        validUntil: dayOffset(5),
        status: "VERIFIED",
        createdBy: demoUser.id,
        verifiedBy: demoUser.id,
        verifiedAt: new Date(),
        items: {
          create: [
            {
              lineNo: 1,
              productId: amox.id,
              drugNameText: "Amoxicillin 500mg",
              productUnitId: amoxBase.id,
              quantity: 20,
              baseQuantity: 20,
              dosageInstruction: "Ngày uống 2 lần, mỗi lần 1 viên sau ăn",
            },
          ],
        },
      },
    });
  }

  // 6. Phiếu nhập còn nháp để kiểm nhập ngay trong buổi demo ----------------
  const supplier = await prisma.supplier.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const draft = await prisma.goodsReceipt.findFirst({ where: { supplierInvoiceNumber: "DEMO-0001" } });
  if (!draft) {
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
      .format(new Date())
      .replace(/-/g, "");
    const prefix = `PN-${store.code}-${day}-`;
    const countToday = await prisma.goodsReceipt.count({ where: { storeId: store.id, code: { startsWith: prefix } } });
    const goodsAmount = 20n * 70_000n;
    await prisma.goodsReceipt.create({
      data: {
        storeId: store.id,
        code: `${prefix}${String(countToday + 900).padStart(4, "0")}`,
        type: "PURCHASE",
        supplierId: supplier.id,
        supplierInvoiceNumber: "DEMO-0001",
        receivedAt: new Date(),
        note: "Phiếu chuẩn bị cho buổi demo",
        goodsAmount,
        discountAmount: 100_000n,
        vatAmount: 0n,
        totalCost: goodsAmount - 100_000n,
        createdBy: demoUser.id,
        lines: {
          create: [
            {
              lineNo: 1,
              productId: para.id,
              productUnitId: para.units.find((unit) => unit.conversionToBase === 100)?.id ?? paraBase.id,
              quantity: 20,
              baseQuantity: 20 * (para.units.find((unit) => unit.conversionToBase === 100)?.conversionToBase ?? 1),
              unitCost: 70_000n,
              lineCost: goodsAmount,
              batchNumber: "DEMO-NHAP",
              expiryDate: dayOffset(540),
            },
          ],
        },
      },
    });
  }

  console.log("Xong. Dữ liệu demo đã sẵn sàng:");
  console.log(`  Dược sĩ        : demo / ${DEMO_PASSWORD}`);
  console.log(`  Chủ nhà thuốc  : demochu / ${DEMO_PASSWORD} (xem được báo cáo, công nợ)`);
  console.log("  Lô cận hạn     : DEMO-CANHAN (Paracetamol, còn 18 ngày)");
  console.log("  Khách có điểm  : Chị Lan (demo) — 40 điểm");
  console.log("  Đơn thuốc      : đã duyệt, Amoxicillin 500mg × 20 viên");
  console.log("  Phiếu nhập nháp: hóa đơn NCC DEMO-0001, chờ kiểm nhập");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
