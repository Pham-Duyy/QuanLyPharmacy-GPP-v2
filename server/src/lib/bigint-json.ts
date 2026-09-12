/**
 * JSON.stringify ném lỗi khi gặp BigInt, mà mọi cột tiền (VND) trong lược đồ
 * đều là BigInt theo ERD §1.3. Số tiền của một nhà thuốc nằm rất xa giới hạn
 * an toàn 2^53 của JavaScript, nên chuyển sang Number là an toàn và giữ được
 * kiểu số trong JSON đúng như khung response ở contract §2.6.
 *
 * Import file này một lần ở app.ts là đủ cho toàn bộ ứng dụng.
 */
declare global {
  interface BigInt {
    toJSON(): number;
  }
}

// Cố ý mở rộng prototype: đây là cách duy nhất để JSON.stringify xử lý được
// BigInt ở mọi chỗ trong ứng dụng, thay vì phải nhớ chuyển đổi ở từng endpoint.
// oxlint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function (this: bigint): number {
  const asNumber = Number(this);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Giá trị ${this.toString()} vượt giới hạn số nguyên an toàn của JSON`);
  }
  return asNumber;
};

export {};
