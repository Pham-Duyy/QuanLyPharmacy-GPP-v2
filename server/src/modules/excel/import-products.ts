import { prisma } from "../../db/prisma.js";
import { getCurrentPrices } from "../catalog/products.service.js";
import { COMMIT_TIMEOUT_MS, RowReader, fold, headerMap, type ImportDefinition, type ImportIssue, type PlannedRow } from "./import-kit.js";
import { asChoice, asInt, asNumber, asText, type ColumnDef } from "./workbook.js";

export const PRODUCT_TYPE_CHOICES = {
  Thuốc: "DRUG",
  TPCN: "SUPPLEMENT",
  "Thực phẩm chức năng": "SUPPLEMENT",
  "TP bảo vệ sức khỏe": "SUPPLEMENT",
  "Thực phẩm bảo vệ sức khỏe": "SUPPLEMENT",
  "Thiết bị y tế": "MEDICAL_DEVICE",
  "Mỹ phẩm": "COSMETIC",
  Khác: "OTHER",
} as const;

export const PRODUCT_TYPE_LABEL: Record<string, string> = {
  DRUG: "Thuốc",
  SUPPLEMENT: "TPCN",
  MEDICAL_DEVICE: "Thiết bị y tế",
  COSMETIC: "Mỹ phẩm",
  OTHER: "Khác",
};

export const DRUG_CLASS_CHOICES = {
  "Kê đơn": "RX",
  "Không kê đơn": "OTC",
  "Kiểm soát đặc biệt": "CONTROLLED",
} as const;

export const DRUG_CLASS_LABEL: Record<string, string> = { RX: "Kê đơn", OTC: "Không kê đơn", CONTROLLED: "Kiểm soát đặc biệt" };

const STATUS_CHOICES = { "Đang kinh doanh": true, "Ngừng kinh doanh": false } as const;

/** Cột dùng chung cho mẫu nhập và file xuất: xuất ra, sửa trong Excel, nhập lại được ngay. */
export const PRODUCT_COLUMNS: ColumnDef[] = [
  { key: "code", header: "Mã sản phẩm", required: true, width: 14, note: "Mã duy nhất. Mã đã có thì cập nhật, mã mới thì tạo sản phẩm mới." },
  { key: "name", header: "Tên sản phẩm", required: true, width: 38 },
  { key: "productType", header: "Loại hàng", required: true, width: 14, note: "Thuốc, TPCN, Thiết bị y tế, Mỹ phẩm, Khác. Không đổi được loại hàng của sản phẩm đã có." },
  { key: "drugClass", header: "Phân loại thuốc", width: 18, note: "Bắt buộc với Thuốc: Kê đơn, Không kê đơn, Kiểm soát đặc biệt. Để trống với hàng không phải thuốc." },
  { key: "category", header: "Nhóm hàng", required: true, width: 22, note: "Tên nhóm hàng. Chưa có thì hệ thống tạo mới." },
  { key: "ingredients", header: "Hoạt chất", width: 26, note: "Nhiều hoạt chất cách nhau bằng dấu chấm phẩy (;). Cần để kiểm tra trùng hoạt chất và dị ứng khi bán." },
  { key: "strengthText", header: "Hàm lượng", width: 14 },
  { key: "dosageForm", header: "Dạng bào chế", width: 18 },
  { key: "packagingText", header: "Quy cách đóng gói", width: 22 },
  { key: "registrationNumber", header: "Số đăng ký", width: 16 },
  { key: "manufacturer", header: "Nhà sản xuất", width: 22 },
  { key: "countryOfOrigin", header: "Nước sản xuất", width: 14 },
  { key: "storageCondition", header: "Điều kiện bảo quản", width: 24 },
  { key: "minStock", header: "Tồn tối thiểu", kind: "int", width: 12, note: "Tính theo đơn vị cơ bản. Dùng để cảnh báo tồn thấp." },
  { key: "baseUnit", header: "Đơn vị cơ bản", required: true, width: 14, note: "Đơn vị nhỏ nhất (Viên, Gói, Chai…). Không đổi được với sản phẩm đã có." },
  { key: "basePrice", header: "Giá bán đơn vị cơ bản", kind: "money", width: 18, note: "Để trống nếu không đổi giá. Giá mới được lưu thành phiên bản giá mới." },
  { key: "baseBarcode", header: "Mã vạch đơn vị cơ bản", width: 18 },
  { key: "largeUnit", header: "Đơn vị lớn", width: 12, note: "Tùy chọn: Hộp, Vỉ, Lọ…" },
  { key: "largeConversion", header: "Quy đổi đơn vị lớn", kind: "int", width: 14, note: "1 đơn vị lớn = bao nhiêu đơn vị cơ bản. Không sửa được quy đổi của đơn vị đã có." },
  { key: "largePrice", header: "Giá bán đơn vị lớn", kind: "money", width: 16 },
  { key: "largeBarcode", header: "Mã vạch đơn vị lớn", width: 18 },
  { key: "vat", header: "VAT (%)", kind: "percent", width: 9, note: "Thuế suất áp cho giá mới. Để trống: giữ thuế suất hiện tại (sản phẩm mới là 0)." },
  { key: "status", header: "Trạng thái", width: 16, note: "Đang kinh doanh hoặc Ngừng kinh doanh. Để trống: giữ nguyên." },
];

type UnitPlan = { name: string; conversion: number; price: number | null; barcode: string | null };

type ProductRowData = {
  existingId: string | null;
  code: string;
  name: string;
  productType: string;
  drugClass: string | null;
  categoryKey: string;
  categoryName: string;
  ingredients: string[] | null;
  fields: Record<string, string | null | undefined>;
  minStock: number | null;
  isActive: boolean | null;
  base: UnitPlan;
  large: UnitPlan | null;
  vat: number | null;
};

function splitList(value: string | null): string[] | null {
  if (!value) return null;
  const items = value
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : null;
}

export const productsImport: ImportDefinition<ProductRowData> = {
  type: "products",
  title: "Danh mục thuốc & sản phẩm",
  permission: ["catalog.manage"],
  needsStore: false,
  columns: PRODUCT_COLUMNS,
  guide: [
    "Mỗi dòng là một sản phẩm. Cột có dấu * là bắt buộc.",
    "Mã sản phẩm đã có trong hệ thống: cập nhật thông tin; ô để trống giữ nguyên giá trị cũ.",
    "Không đổi được loại hàng, phân loại kê đơn, đơn vị cơ bản và hệ số quy đổi qua Excel (ảnh hưởng luật bán thuốc và tồn kho) — sửa từng sản phẩm trên phần mềm nếu thật sự cần.",
    "Giá bán khác giá hiện hành sẽ tạo phiên bản giá mới áp dụng toàn chuỗi (cần quyền đặt giá); hóa đơn cũ không bị đổi.",
    "Có lỗi ở bất kỳ dòng nào thì không dòng nào được ghi — sửa hết lỗi rồi nhập lại.",
  ],
  example: [
    {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "Thuốc",
      drugClass: "Không kê đơn",
      category: "Thuốc giảm đau, hạ sốt",
      ingredients: "Paracetamol",
      strengthText: "500 mg",
      dosageForm: "Viên nén",
      packagingText: "Hộp 10 vỉ x 10 viên",
      registrationNumber: "VD-12345-20",
      manufacturer: "Công ty Dược mẫu",
      countryOfOrigin: "Việt Nam",
      storageCondition: "Nơi khô, dưới 30°C",
      minStock: 200,
      baseUnit: "Viên",
      basePrice: 1000,
      baseBarcode: "",
      largeUnit: "Hộp",
      largeConversion: 100,
      largePrice: 95000,
      largeBarcode: "8930000000017",
      vat: 5,
      status: "Đang kinh doanh",
    },
  ],

  async plan(rows, ctx) {
    const headers = headerMap(PRODUCT_COLUMNS);
    const issues: ImportIssue[] = [];
    const notes: string[] = [];
    const planned: PlannedRow<ProductRowData>[] = [];

    const codes = rows.map((row) => String(row.values["code"] ?? "").trim()).filter(Boolean);
    const [existing, categories, ingredients] = await Promise.all([
      prisma.product.findMany({
        where: { code: { in: codes } },
        include: { units: { include: { barcodes: true } } },
      }),
      prisma.category.findMany({ select: { id: true, name: true } }),
      prisma.activeIngredient.findMany({ select: { id: true, name: true } }),
    ]);
    const byCode = new Map(existing.map((product) => [product.code, product]));
    const categoryKeys = new Set(categories.map((category) => fold(category.name)));
    const ingredientKeys = new Set(ingredients.map((item) => fold(item.name)));
    const canPrice = ctx.auth.can("price.manage");
    // Giá hiện hành để người không có quyền giá vẫn nhập lại được tệp đã xuất
    // (giá giữ nguyên thì bỏ qua, chỉ báo lỗi khi thật sự đổi giá).
    const currentPrices = canPrice ? new Map() : await getCurrentPrices(existing.flatMap((product) => product.units.map((unit) => unit.id)), null);

    // Mã vạch trong CSDL để phát hiện trùng với đơn vị khác.
    const barcodesInFile = rows.flatMap((row) => [row.values["baseBarcode"], row.values["largeBarcode"]]).filter(Boolean).map(String);
    const barcodeOwners = await prisma.productBarcode.findMany({
      where: { barcode: { in: barcodesInFile } },
      include: { productUnit: { select: { name: true, product: { select: { code: true } } } } },
    });
    const ownerOf = new Map(barcodeOwners.map((row) => [row.barcode, `${row.productUnit.product.code}/${row.productUnit.name}`]));

    const seenCodes = new Map<string, number>();
    const seenBarcodes = new Map<string, number>();
    const newCategories = new Set<string>();
    const newIngredients = new Set<string>();

    for (const raw of rows) {
      const r = new RowReader(raw.rowNumber, headers);
      const v = raw.values;
      const code = r.read("code", () => asText(v["code"], 50, "Mã sản phẩm"));
      const name = r.read("name", () => asText(v["name"], 300, "Tên sản phẩm"));
      const productType = r.read("productType", () => asChoice(v["productType"], "Loại hàng", PRODUCT_TYPE_CHOICES));
      const drugClass = r.read("drugClass", () => asChoice(v["drugClass"], "Phân loại thuốc", DRUG_CLASS_CHOICES));
      const category = r.read("category", () => asText(v["category"], 200, "Nhóm hàng"));
      const ingredientList = r.read("ingredients", () => splitList(asText(v["ingredients"], 1000, "Hoạt chất")));
      const fields: Record<string, string | null> = {};
      for (const [key, label, max] of [
        ["strengthText", "Hàm lượng", 100],
        ["dosageForm", "Dạng bào chế", 100],
        ["packagingText", "Quy cách đóng gói", 200],
        ["registrationNumber", "Số đăng ký", 50],
        ["manufacturer", "Nhà sản xuất", 200],
        ["countryOfOrigin", "Nước sản xuất", 100],
        ["storageCondition", "Điều kiện bảo quản", 200],
      ] as const) {
        fields[key] = r.read(key, () => asText(v[key], max, label));
      }
      const minStock = r.read("minStock", () => asInt(v["minStock"], "Tồn tối thiểu", { min: 0 }));
      const baseUnit = r.read("baseUnit", () => asText(v["baseUnit"], 50, "Đơn vị cơ bản"));
      let basePrice = r.read("basePrice", () => asInt(v["basePrice"], "Giá bán đơn vị cơ bản", { min: 0 }));
      const baseBarcode = r.read("baseBarcode", () => asText(v["baseBarcode"], 50, "Mã vạch"));
      const largeUnit = r.read("largeUnit", () => asText(v["largeUnit"], 50, "Đơn vị lớn"));
      const largeConversion = r.read("largeConversion", () => asInt(v["largeConversion"], "Quy đổi đơn vị lớn", { min: 2 }));
      let largePrice = r.read("largePrice", () => asInt(v["largePrice"], "Giá bán đơn vị lớn", { min: 0 }));
      const largeBarcode = r.read("largeBarcode", () => asText(v["largeBarcode"], 50, "Mã vạch"));
      const vat = r.read("vat", () => asNumber(v["vat"], "VAT", { min: 0, max: 100 }));
      const status = r.read("status", () => asChoice(v["status"], "Trạng thái", STATUS_CHOICES));

      r.require("code", code);
      r.require("name", name);
      r.require("productType", productType);
      r.require("category", category);
      r.require("baseUnit", baseUnit);

      if (productType === "DRUG" && !drugClass) r.fail("drugClass", "Thuốc bắt buộc có phân loại kê đơn");
      if (productType && productType !== "DRUG" && drugClass) r.fail("drugClass", "Hàng không phải thuốc thì để trống phân loại thuốc");
      if (largeUnit && !largeConversion) r.fail("largeConversion", "Có đơn vị lớn thì phải có quy đổi");
      if (!largeUnit && (largeConversion || largePrice !== null || largeBarcode)) r.fail("largeUnit", "Thiếu tên đơn vị lớn");
      if (largeUnit && baseUnit && fold(largeUnit) === fold(baseUnit)) r.fail("largeUnit", "Đơn vị lớn trùng tên đơn vị cơ bản");
      for (const [key, barcode] of [["baseBarcode", baseBarcode], ["largeBarcode", largeBarcode]] as const) {
        if (!barcode) continue;
        if (barcode.length < 6) r.fail(key, "Mã vạch tối thiểu 6 ký tự");
        const seen = seenBarcodes.get(barcode);
        if (seen) r.fail(key, `Mã vạch ${barcode} trùng với dòng ${seen}`);
        seenBarcodes.set(barcode, raw.rowNumber);
      }

      if (code) {
        const seen = seenCodes.get(code);
        if (seen) r.fail("code", `Mã sản phẩm trùng với dòng ${seen}`);
        seenCodes.set(code, raw.rowNumber);
      }

      const current = code ? byCode.get(code) : undefined;
      if (current) {
        if (productType && current.productType !== productType) r.fail("productType", `Không đổi được loại hàng qua Excel (đang là ${PRODUCT_TYPE_LABEL[current.productType]})`);
        if (productType === "DRUG" && drugClass && current.drugClass !== drugClass) {
          r.fail("drugClass", `Không đổi được phân loại thuốc qua Excel (đang là ${DRUG_CLASS_LABEL[current.drugClass ?? ""]})`);
        }
        const currentBase = current.units.find((unit) => unit.conversionToBase === 1);
        if (baseUnit && currentBase && fold(currentBase.name) !== fold(baseUnit)) r.fail("baseUnit", `Đơn vị cơ bản đang là "${currentBase.name}", không đổi được`);
        const currentLarge = largeUnit ? current.units.find((unit) => fold(unit.name) === fold(largeUnit)) : undefined;
        if (currentLarge && largeConversion && currentLarge.conversionToBase !== largeConversion) {
          r.fail("largeConversion", `Đơn vị ${currentLarge.name} đang quy đổi ${currentLarge.conversionToBase}, không sửa được quy đổi`);
        }
        if (!canPrice) {
          const unchanged = (unitName: string | null, price: number | null) => {
            const unit = unitName ? current.units.find((item) => fold(item.name) === fold(unitName)) : undefined;
            const existingPrice = unit ? currentPrices.get(unit.id) : undefined;
            return price !== null && existingPrice !== undefined && Number(existingPrice.salePrice) === price && (vat === null || Number(existingPrice.vatRatePercent) === vat);
          };
          if (unchanged(baseUnit, basePrice)) basePrice = null;
          if (unchanged(largeUnit, largePrice)) largePrice = null;
        }
        const unitNames = new Map(current.units.map((unit) => [unit.id, fold(unit.name)]));
        for (const [key, barcode, unitName] of [["baseBarcode", baseBarcode, baseUnit], ["largeBarcode", largeBarcode, largeUnit]] as const) {
          if (!barcode) continue;
          const owner = ownerOf.get(barcode);
          const ownUnit = current.units.find((unit) => unit.barcodes.some((item) => item.barcode === barcode));
          if (owner && !(ownUnit && unitName && unitNames.get(ownUnit.id) === fold(unitName))) r.fail(key, `Mã vạch ${barcode} đang thuộc ${owner}`);
        }
      } else {
        for (const [key, barcode] of [["baseBarcode", baseBarcode], ["largeBarcode", largeBarcode]] as const) {
          const owner = barcode ? ownerOf.get(barcode) : undefined;
          if (owner) r.fail(key, `Mã vạch ${barcode} đang thuộc ${owner}`);
        }
      }

      if ((basePrice !== null || largePrice !== null) && !canPrice) r.fail(basePrice !== null ? "basePrice" : "largePrice", "Tài khoản không có quyền đổi giá bán — giữ nguyên giá cũ hoặc để trống cột giá");
      issues.push(...r.issues);
      if (r.issues.length > 0 || !code || !name || !productType || !category || !baseUnit) continue;

      if (!categoryKeys.has(fold(category))) newCategories.add(category);
      for (const item of ingredientList ?? []) if (!ingredientKeys.has(fold(item))) newIngredients.add(item);

      planned.push({
        row: raw.rowNumber,
        action: current ? "update" : "create",
        label: `${code} · ${name}`,
        data: {
          existingId: current?.id ?? null,
          code,
          name,
          productType,
          drugClass: productType === "DRUG" ? drugClass : null,
          categoryKey: fold(category),
          categoryName: category,
          ingredients: ingredientList,
          fields,
          minStock,
          isActive: status,
          base: { name: baseUnit, conversion: 1, price: basePrice, barcode: baseBarcode },
          large: largeUnit && largeConversion ? { name: largeUnit, conversion: largeConversion, price: largePrice, barcode: largeBarcode } : null,
          vat,
        },
      });
    }

    if (newCategories.size > 0) notes.push(`Sẽ tạo ${newCategories.size} nhóm hàng mới: ${[...newCategories].slice(0, 10).join(", ")}${newCategories.size > 10 ? "…" : ""}`);
    if (newIngredients.size > 0) notes.push(`Sẽ tạo ${newIngredients.size} hoạt chất mới: ${[...newIngredients].slice(0, 10).join(", ")}${newIngredients.size > 10 ? "…" : ""}`);
    return { rows: planned, issues, notes };
  },

  async commit(plan, ctx) {
    let created = 0;
    let updated = 0;
    const userId = ctx.auth.userId;

    await prisma.$transaction(
      async (tx) => {
        const categories = await tx.category.findMany({ select: { id: true, name: true } });
        const categoryId = new Map(categories.map((category) => [fold(category.name), category.id]));
        const ingredients = await tx.activeIngredient.findMany({ select: { id: true, name: true } });
        const ingredientId = new Map(ingredients.map((item) => [fold(item.name), item.id]));

        async function ensureCategory(key: string, name: string): Promise<string> {
          const found = categoryId.get(key);
          if (found) return found;
          const createdCategory = await tx.category.create({ data: { name } });
          categoryId.set(key, createdCategory.id);
          return createdCategory.id;
        }
        async function ensureIngredient(name: string): Promise<string> {
          const key = fold(name);
          const found = ingredientId.get(key);
          if (found) return found;
          const createdIngredient = await tx.activeIngredient.create({ data: { name } });
          ingredientId.set(key, createdIngredient.id);
          return createdIngredient.id;
        }

        const priceChanges: Array<{ unitId: string; price: number; vat: number | null }> = [];

        for (const { data } of plan.rows) {
          const catId = await ensureCategory(data.categoryKey, data.categoryName);
          const optional = Object.fromEntries(Object.entries(data.fields).filter(([, value]) => value !== null));
          let productId: string;

          if (data.existingId) {
            productId = data.existingId;
            await tx.product.update({
              where: { id: productId },
              data: {
                name: data.name,
                categoryId: catId,
                ...optional,
                ...(data.minStock !== null ? { minStockBaseQuantity: data.minStock } : {}),
                ...(data.isActive !== null ? { isActive: data.isActive } : {}),
                version: { increment: 1 },
              },
            });
            updated++;
          } else {
            const product = await tx.product.create({
              data: {
                code: data.code,
                name: data.name,
                productType: data.productType,
                drugClass: data.drugClass,
                categoryId: catId,
                ...optional,
                minStockBaseQuantity: data.minStock ?? 0,
                isActive: data.isActive ?? true,
              },
            });
            productId = product.id;
            created++;
          }

          if (data.ingredients) {
            const ids = await Promise.all(data.ingredients.map(ensureIngredient));
            await tx.productIngredient.deleteMany({ where: { productId, ingredientId: { notIn: ids } } });
            for (const id of ids) {
              await tx.productIngredient.upsert({
                where: { productId_ingredientId: { productId, ingredientId: id } },
                create: { productId, ingredientId: id, strengthText: data.fields["strengthText"] ?? null },
                update: {},
              });
            }
          }

          const units = await tx.productUnit.findMany({ where: { productId }, include: { barcodes: true } });
          for (const spec of [data.base, data.large]) {
            if (!spec) continue;
            let unit = units.find((item) => fold(item.name) === fold(spec.name));
            if (!unit) {
              unit = {
                ...(await tx.productUnit.create({
                  data: {
                    productId,
                    name: spec.name,
                    conversionToBase: spec.conversion,
                    isSellable: true,
                    // Đơn vị cơ bản của sản phẩm mới là đơn vị bán mặc định.
                    isDefaultSaleUnit: spec.conversion === 1 && !units.some((item) => item.isDefaultSaleUnit),
                  },
                })),
                barcodes: [],
              };
              units.push(unit);
            }
            if (spec.barcode && !unit.barcodes.some((item) => item.barcode === spec.barcode)) {
              await tx.productBarcode.create({ data: { productUnitId: unit.id, barcode: spec.barcode } });
            }
            if (spec.price !== null) priceChanges.push({ unitId: unit.id, price: spec.price, vat: data.vat });
          }
        }

        // Giá: chỉ tạo phiên bản mới khi khác giá chung hiện hành (theo đúng cơ chế phiên bản giá).
        if (priceChanges.length > 0) {
          const current = await getCurrentPrices(priceChanges.map((item) => item.unitId), null, new Date(), tx);
          const now = new Date();
          for (const change of priceChanges) {
            const existingPrice = current.get(change.unitId);
            const vat = change.vat ?? (existingPrice ? Number(existingPrice.vatRatePercent) : 0);
            if (existingPrice && Number(existingPrice.salePrice) === change.price && Number(existingPrice.vatRatePercent) === vat) continue;
            await tx.productPrice.create({
              data: { productUnitId: change.unitId, storeId: null, salePrice: BigInt(change.price), vatRatePercent: vat, effectiveFrom: now, createdBy: userId },
            });
          }
        }
      },
      { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
    );

    return { created, updated };
  },
};
