import { prisma } from "../../db/prisma.js";

/**
 * Dựng dữ liệu hóa đơn máy tính tiền (OrgInvoiceData của MISA meInvoice) từ
 * hóa đơn bán.
 *
 * Giá niêm yết trong phần mềm đã gồm VAT, giảm giá đã phân bổ vào từng dòng
 * (`line_total`), VAT từng dòng tách ngược ra đúng như lúc bán. Sang hóa đơn
 * điện tử: thành tiền chưa thuế = line_total − VAT dòng, đơn giá chưa thuế =
 * thành tiền chưa thuế / số lượng. Không gửi dòng chiết khấu riêng vì giảm
 * giá đã nằm trong thành tiền — gửi thêm sẽ trừ hai lần.
 *
 * Tổng các dòng phải khớp đúng tổng hóa đơn đã thu; lệch thì không gửi.
 */

const PAYMENT_METHOD_NAME: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  CARD: "Thẻ",
};

export type BuildResult =
  { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };

/** Làm tròn nửa lên, giống cách tách VAT lúc bán (invoices.service divRound). */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** "5.00" → "5%", "8.00" → "8%", "0.00" → "0%". Định dạng cần kiểm lại với sandbox MISA. */
export function vatRateName(percent: number): string {
  return `${Number(percent.toFixed(2))}%`;
}

/** Ngày giờ theo giờ Việt Nam, dạng yyyy-MM-ddTHH:mm:ss+07:00. */
function vnDateTime(at: Date): string {
  const local = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 19)}+07:00`;
}

export async function buildMisaInvoice(invoiceId: string, invSeries: string): Promise<BuildResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: { orderBy: { lineNo: "asc" }, include: { product: { select: { code: true } } } },
      customer: { select: { code: true, fullName: true, phone: true } },
    },
  });
  if (!invoice) return { ok: false, message: "Không tìm thấy hóa đơn bán" };
  if (invoice.status !== "COMPLETED") {
    return { ok: false, message: "Hóa đơn bán không ở trạng thái hoàn tất" };
  }
  if (invoice.lines.length === 0) return { ok: false, message: "Hóa đơn không có dòng hàng" };

  let sumTotal = 0n;
  let sumVat = 0n;
  const details = invoice.lines.map((line, index) => {
    const rateBp = BigInt(Math.round(Number(line.vatRatePercent) * 100));
    const vat = divRound(line.lineTotal * rateBp, 10000n + rateBp);
    const withoutVat = line.lineTotal - vat;
    sumTotal += line.lineTotal;
    sumVat += vat;
    return {
      ItemType: 1,
      LineNumber: index + 1,
      SortOrder: index + 1,
      ItemCode: line.product.code,
      ItemName: line.productName,
      UnitName: line.unitName,
      Quantity: line.quantity,
      UnitPrice: Math.round((Number(withoutVat) / line.quantity) * 100) / 100,
      AmountOC: Number(withoutVat),
      Amount: Number(withoutVat),
      AmountWithoutVATOC: Number(withoutVat),
      AmountWithoutVAT: Number(withoutVat),
      VATRateName: vatRateName(Number(line.vatRatePercent)),
      VATAmountOC: Number(vat),
      VATAmount: Number(vat),
    };
  });

  if (sumTotal !== invoice.totalAmount || sumVat !== invoice.vatAmount) {
    return {
      ok: false,
      message: `Tổng dòng (${sumTotal} / VAT ${sumVat}) không khớp tổng hóa đơn (${invoice.totalAmount} / VAT ${invoice.vatAmount}); không phát hành để tránh sai số liệu thuế`,
    };
  }

  const withoutVatTotal = Number(invoice.totalAmount - invoice.vatAmount);
  const payload: Record<string, unknown> = {
    RefID: invoice.id,
    InvSeries: invSeries,
    InvoiceName: "Hóa đơn giá trị gia tăng khởi tạo từ máy tính tiền",
    InvDate: vnDateTime(invoice.soldAt),
    IsInvoiceCalculatingMachine: true,
    CurrencyCode: "VND",
    ExchangeRate: 1,
    PaymentMethodName: PAYMENT_METHOD_NAME[invoice.paymentMethod] ?? invoice.paymentMethod,
    TotalSaleAmountOC: withoutVatTotal,
    TotalSaleAmount: withoutVatTotal,
    TotalAmountWithoutVATOC: withoutVatTotal,
    TotalAmountWithoutVAT: withoutVatTotal,
    TotalVATAmountOC: Number(invoice.vatAmount),
    TotalVATAmount: Number(invoice.vatAmount),
    TotalDiscountAmountOC: 0,
    TotalDiscountAmount: 0,
    TotalAmountOC: Number(invoice.totalAmount),
    TotalAmount: Number(invoice.totalAmount),
    OriginalInvoiceDetail: details,
  };
  // Khách lẻ không bắt buộc thông tin người mua; có khách thì ghi tên, mã, SĐT.
  if (invoice.customer) {
    if (invoice.customer.fullName) payload["BuyerFullName"] = invoice.customer.fullName;
    payload["BuyerCode"] = invoice.customer.code;
    if (invoice.customer.phone) payload["BuyerPhoneNumber"] = invoice.customer.phone;
  }
  return { ok: true, payload };
}
