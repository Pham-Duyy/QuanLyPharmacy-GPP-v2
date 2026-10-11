/** Số tiền, số lượng kiểu bigint đọc từ CSDL → number; thiếu giá trị coi là 0. */
export function num(value: bigint | null | undefined): number {
  return Number(value ?? 0n);
}
