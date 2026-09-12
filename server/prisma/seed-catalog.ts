/**
 * Danh mục mẫu để chạy thử: đủ để bán hàng, thử quy đổi đơn vị và thử FEFO.
 * Đây là dữ liệu demo, không phải danh mục thật của nhà thuốc.
 */

export type SeedUnit = {
  name: string;
  conversionToBase: number;
  isSellable: boolean;
  isDefaultSaleUnit?: boolean;
  salePrice: number;
  barcode?: string;
};

export type SeedBatch = {
  batchNumber: string;
  expiryDate: string;
  manufactureDate?: string;
  unitName: string;
  quantity: number;
  unitCost: number;
};

export type SeedProduct = {
  code: string;
  name: string;
  productType: "DRUG" | "SUPPLEMENT" | "MEDICAL_DEVICE" | "COSMETIC" | "OTHER";
  drugClass: "OTC" | "RX" | "CONTROLLED" | null;
  categoryName: string;
  registrationNumber?: string;
  dosageForm?: string;
  strengthText?: string;
  packagingText?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  storageCondition?: string;
  minStockBaseQuantity: number;
  vatRatePercent: number;
  ingredients: Array<{ name: string; strengthText: string }>;
  units: SeedUnit[];
  openingBatches: SeedBatch[];
};

export const CATEGORIES = [
  "Thuốc giảm đau, hạ sốt",
  "Thuốc kháng sinh",
  "Thuốc dị ứng",
  "Thuốc tiêu hóa",
  "Vitamin và khoáng chất",
  "Dụng cụ y tế",
];

export const INGREDIENTS = [
  "Paracetamol",
  "Amoxicillin",
  "Ibuprofen",
  "Cetirizine",
  "Omeprazole",
  "Acid ascorbic",
];

export const SUPPLIERS = [
  {
    name: "Công ty CP Dược phẩm Trung ương CPC1",
    taxCode: "0100108536",
    licenseNumber: "GPP-HN-0001",
    phone: "02438256868",
  },
  {
    name: "Công ty TNHH Dược phẩm Hoàng Long",
    taxCode: "0106123456",
    licenseNumber: "GPP-HN-0042",
    phone: "02439991234",
  },
];

export const PRODUCTS: SeedProduct[] = [
  {
    code: "TH0001",
    name: "Paracetamol 500mg",
    productType: "DRUG",
    drugClass: "OTC",
    categoryName: "Thuốc giảm đau, hạ sốt",
    registrationNumber: "VD-12345-20",
    dosageForm: "Viên nén",
    strengthText: "500 mg",
    packagingText: "Hộp 10 vỉ x 10 viên",
    manufacturer: "Công ty CP Dược Hậu Giang",
    countryOfOrigin: "Việt Nam",
    storageCondition: "Nơi khô ráo, dưới 30 độ C",
    minStockBaseQuantity: 500,
    vatRatePercent: 5,
    ingredients: [{ name: "Paracetamol", strengthText: "500 mg" }],
    units: [
      {
        name: "Viên",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 1200,
      },
      {
        name: "Vỉ",
        conversionToBase: 10,
        isSellable: true,
        salePrice: 11000,
        barcode: "8934567000011",
      },
      {
        name: "Hộp",
        conversionToBase: 100,
        isSellable: true,
        salePrice: 105000,
        barcode: "8934567000028",
      },
    ],
    openingBatches: [
      {
        batchNumber: "PA250110",
        expiryDate: "2027-01-09",
        manufactureDate: "2025-01-10",
        unitName: "Hộp",
        quantity: 5,
        unitCost: 82000,
      },
      {
        batchNumber: "PA240915",
        expiryDate: "2026-10-31",
        manufactureDate: "2024-09-15",
        unitName: "Hộp",
        quantity: 2,
        unitCost: 80000,
      },
    ],
  },
  {
    code: "TH0002",
    name: "Amoxicillin 500mg",
    productType: "DRUG",
    drugClass: "RX",
    categoryName: "Thuốc kháng sinh",
    registrationNumber: "VD-23456-21",
    dosageForm: "Viên nang",
    strengthText: "500 mg",
    packagingText: "Hộp 10 vỉ x 10 viên",
    manufacturer: "Công ty CP Dược phẩm Imexpharm",
    countryOfOrigin: "Việt Nam",
    minStockBaseQuantity: 300,
    vatRatePercent: 5,
    ingredients: [{ name: "Amoxicillin", strengthText: "500 mg" }],
    units: [
      {
        name: "Viên",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 2500,
      },
      {
        name: "Vỉ",
        conversionToBase: 10,
        isSellable: true,
        salePrice: 24000,
        barcode: "8934567000035",
      },
      { name: "Hộp", conversionToBase: 100, isSellable: true, salePrice: 230000 },
    ],
    openingBatches: [
      {
        batchNumber: "AM250320",
        expiryDate: "2027-03-19",
        manufactureDate: "2025-03-20",
        unitName: "Hộp",
        quantity: 3,
        unitCost: 180000,
      },
    ],
  },
  {
    code: "TH0003",
    name: "Ibuprofen 400mg",
    productType: "DRUG",
    drugClass: "OTC",
    categoryName: "Thuốc giảm đau, hạ sốt",
    registrationNumber: "VD-34567-19",
    dosageForm: "Viên nén bao phim",
    strengthText: "400 mg",
    manufacturer: "Công ty CP Traphaco",
    countryOfOrigin: "Việt Nam",
    minStockBaseQuantity: 200,
    vatRatePercent: 5,
    ingredients: [{ name: "Ibuprofen", strengthText: "400 mg" }],
    units: [
      {
        name: "Viên",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 1800,
      },
      { name: "Vỉ", conversionToBase: 10, isSellable: true, salePrice: 17000 },
    ],
    openingBatches: [
      {
        batchNumber: "IB250505",
        expiryDate: "2027-05-04",
        unitName: "Vỉ",
        quantity: 40,
        unitCost: 12000,
      },
    ],
  },
  {
    code: "TH0004",
    name: "Cetirizine 10mg",
    productType: "DRUG",
    drugClass: "OTC",
    categoryName: "Thuốc dị ứng",
    dosageForm: "Viên nén bao phim",
    strengthText: "10 mg",
    minStockBaseQuantity: 100,
    vatRatePercent: 5,
    ingredients: [{ name: "Cetirizine", strengthText: "10 mg" }],
    units: [
      {
        name: "Viên",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 2000,
      },
      { name: "Vỉ", conversionToBase: 10, isSellable: true, salePrice: 19000 },
    ],
    openingBatches: [
      {
        batchNumber: "CE250210",
        expiryDate: "2028-02-09",
        unitName: "Vỉ",
        quantity: 20,
        unitCost: 13000,
      },
    ],
  },
  {
    code: "TH0005",
    name: "Omeprazole 20mg",
    productType: "DRUG",
    drugClass: "RX",
    categoryName: "Thuốc tiêu hóa",
    dosageForm: "Viên nang cứng",
    strengthText: "20 mg",
    minStockBaseQuantity: 100,
    vatRatePercent: 5,
    ingredients: [{ name: "Omeprazole", strengthText: "20 mg" }],
    units: [
      {
        name: "Viên",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 3000,
      },
      { name: "Vỉ", conversionToBase: 14, isSellable: true, salePrice: 40000 },
    ],
    openingBatches: [
      {
        batchNumber: "OM250601",
        expiryDate: "2027-05-31",
        unitName: "Vỉ",
        quantity: 15,
        unitCost: 28000,
      },
    ],
  },
  {
    code: "TP0001",
    name: "Vitamin C 500mg",
    productType: "SUPPLEMENT",
    drugClass: null,
    categoryName: "Vitamin và khoáng chất",
    packagingText: "Lọ 100 viên",
    minStockBaseQuantity: 200,
    vatRatePercent: 8,
    ingredients: [{ name: "Acid ascorbic", strengthText: "500 mg" }],
    units: [
      {
        name: "Viên",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 1500,
      },
      {
        name: "Lọ",
        conversionToBase: 100,
        isSellable: true,
        salePrice: 140000,
        barcode: "8934567000059",
      },
    ],
    openingBatches: [
      {
        batchNumber: "VC250401",
        expiryDate: "2027-03-31",
        unitName: "Lọ",
        quantity: 6,
        unitCost: 105000,
      },
    ],
  },
  {
    code: "DC0001",
    name: "Khẩu trang y tế 4 lớp",
    productType: "MEDICAL_DEVICE",
    drugClass: null,
    categoryName: "Dụng cụ y tế",
    packagingText: "Hộp 50 cái",
    minStockBaseQuantity: 200,
    vatRatePercent: 8,
    ingredients: [],
    units: [
      { name: "Cái", conversionToBase: 1, isSellable: true, salePrice: 1500 },
      {
        name: "Hộp",
        conversionToBase: 50,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 55000,
        barcode: "8934567000066",
      },
    ],
    openingBatches: [
      {
        batchNumber: "KT250101",
        expiryDate: "2028-01-01",
        unitName: "Hộp",
        quantity: 10,
        unitCost: 38000,
      },
    ],
  },
  {
    code: "DC0002",
    name: "Nhiệt kế điện tử",
    productType: "MEDICAL_DEVICE",
    drugClass: null,
    categoryName: "Dụng cụ y tế",
    minStockBaseQuantity: 5,
    vatRatePercent: 8,
    ingredients: [],
    units: [
      {
        name: "Cái",
        conversionToBase: 1,
        isSellable: true,
        isDefaultSaleUnit: true,
        salePrice: 120000,
        barcode: "8934567000073",
      },
    ],
    openingBatches: [
      {
        batchNumber: "NK250201",
        expiryDate: "2030-01-01",
        unitName: "Cái",
        quantity: 8,
        unitCost: 85000,
      },
    ],
  },
];
