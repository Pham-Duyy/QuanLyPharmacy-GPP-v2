/**
 * Máy chủ MÔ PHỎNG Hệ thống Cơ sở dữ liệu về Dược, chạy trên máy của bạn.
 *
 *   npm run nds:mock
 *
 * Dùng khi chưa được cấp tài khoản sandbox của Bộ Y tế: nó nói đúng giao thức
 * trong đặc tả API v1.1 (đăng nhập form-urlencoded + mật khẩu base64, phân
 * trang danh mục, nhận chứng từ rồi trả transaction_id, xử lý bất đồng bộ),
 * nên chạy được trọn luồng liên thông từ đầu tới cuối.
 *
 * KHÔNG phải dữ liệu thật. Danh mục thuốc được dựng từ chính danh mục của
 * nhà thuốc trong CSDL, mọi mã đều mang tiền tố "MOCK-" và số đăng ký mang
 * dạng "MOCK-VD-..." để không thể nhầm với mã do Bộ Y tế cấp.
 *
 * Cách dùng:
 *   1. Cửa sổ 1:  npm run nds:mock
 *   2. Thêm vào server/.env:  NDS_BASE_URL="http://127.0.0.1:4010/v2"
 *   3. Khởi động lại máy chủ, vào màn Liên thông CSDL Dược, nhập tài khoản
 *      bất kỳ khớp với dòng in ra ở cửa sổ 1.
 *   4. Xong demo thì xóa dòng NDS_BASE_URL đi.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { startStubServer } from "../src/test/nds-stub-server.js";
import { PrismaClient } from "../src/generated/prisma/client.js";

const PORT = Number(process.env["NDS_MOCK_PORT"] ?? 4010);
const USERNAME = process.env["NDS_MOCK_USERNAME"] ?? "0101234567-001";
const PASSWORD = process.env["NDS_MOCK_PASSWORD"] ?? "MatKhauThu@123";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] ?? "" }),
});

/** Đơn vị tính: lấy đúng các đơn vị cơ bản đang có trong danh mục. */
async function buildUnits(): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.productUnit.findMany({
    where: { conversionToBase: 1 },
    select: { name: true },
    distinct: ["name"],
    orderBy: { name: "asc" },
  });

  const names = rows.map((row) => row.name);
  // Vài đơn vị phổ biến khác để danh mục trông giống thật.
  for (const extra of ["Hộp", "Vỉ", "Lọ", "Chai", "Tuýp", "Gói", "Ống"]) {
    if (!names.includes(extra)) names.push(extra);
  }

  return names.map((name, index) => ({
    id: `MOCK-U${String(index + 1).padStart(2, "0")}`,
    name,
  }));
}

/**
 * Danh mục thuốc mô phỏng dựng từ danh mục của nhà thuốc, để ghép mã trong
 * lúc demo ra kết quả có nghĩa thay vì không khớp gì.
 */
async function buildDrugs(units: Array<{ id: string; name: string }>): Promise<unknown[]> {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: {
      units: { where: { conversionToBase: 1 }, select: { name: true } },
      ingredients: { include: { ingredient: { select: { name: true } } } },
    },
    orderBy: { code: "asc" },
  });

  const unitByName = new Map(units.map((unit) => [unit.name, unit.id]));

  return products.map((product, index) => {
    const baseUnitName = product.units[0]?.name ?? "Viên";
    const unitId = unitByName.get(baseUnitName) ?? units[0]!.id;
    const serial = String(index + 1).padStart(4, "0");

    return {
      id: `MOCK-D${serial}`,
      name: product.name,
      drug_group_id: product.drugClass === "RX" ? "MOCK-G02" : "MOCK-G01",
      // Số đăng ký thật do Bộ Y tế cấp; bản mô phỏng ghi rõ là MOCK.
      registration_number: product.registrationNumber ?? `MOCK-VD-${serial}-26`,
      active_pharmaceutical_ingredient:
        product.ingredients.map((item) => item.ingredient.name).join(", ") || null,
      strength: product.strengthText,
      prescription_status: product.drugClass === "RX" || product.drugClass === "CONTROLLED" ? 1 : 0,
      special_control_type: product.drugClass === "CONTROLLED" ? 1 : 0,
      packagings: [{ unit_id: unitId, unit_name: baseUnitName, gtin: `MOCK${serial}` }],
      manufacturer: {
        id: "MOCK-M01",
        name: product.manufacturer ?? "Cơ sở sản xuất mô phỏng",
        country: product.countryOfOrigin ?? "VN",
        address: null,
      },
      last_update_time: new Date().toISOString(),
    };
  });
}

async function main(): Promise<void> {
  const dbName = (process.env["DATABASE_URL"] ?? "").split("/").pop()?.split("?")[0] ?? "(không rõ)";
  const units = await buildUnits();
  const drugs = await buildDrugs(units);

  const server = await startStubServer({ username: USERNAME, password: PASSWORD, units, drugs, port: PORT, autoAdvanceMs: 8_000 });

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────────────────┐");
  console.log("  │  MÁY CHỦ MÔ PHỎNG CSDL DƯỢC — KHÔNG PHẢI HỆ THỐNG THẬT       │");
  console.log("  └──────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  Địa chỉ      : ${server.baseUrl}`);
  console.log(`  Tài khoản    : ${USERNAME}`);
  console.log(`  Mật khẩu     : ${PASSWORD}`);
  console.log(`  Danh mục     : ${drugs.length} thuốc, ${units.length} đơn vị tính (dựng từ CSDL ${dbName})`);
  console.log("");
  console.log("  Thêm vào server/.env rồi khởi động lại máy chủ:");
  console.log(`    NDS_BASE_URL="${server.baseUrl}"`);
  console.log("");
  console.log("  Mọi mã thuốc đều mang tiền tố MOCK- để không nhầm với mã Bộ Y tế cấp.");
  console.log("  Xong demo thì xóa dòng NDS_BASE_URL khỏi .env.");
  console.log("  Ctrl+C để dừng.");
  console.log("");

  const stop = async (): Promise<void> => {
    console.log("\nĐang dừng máy chủ mô phỏng...");
    await server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
