/** Bỏ dấu tiếng Việt để so khớp "ton kho" với "Tồn kho". */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}
