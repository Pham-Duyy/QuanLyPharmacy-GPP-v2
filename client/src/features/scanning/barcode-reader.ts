import { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// Chrome, Edge trên Windows chưa có BarcodeDetector sẵn, nên đọc mã bằng
// ZXing chạy WebAssembly. Tệp .wasm đóng gói cùng phần mềm thay vì tải từ
// CDN mặc định của thư viện: quầy mất mạng ngoài vẫn quét được. Hai gói được
// ghim cùng phiên bản trong package.json để tệp .wasm khớp với mã JavaScript.
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

/** Mã vạch trên hộp thuốc, tem in từ phần mềm và mã đơn thuốc in trên giấy. */
const FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
  "qr_code",
  "data_matrix",
  "pdf417",
] as const;

export function createBarcodeReader() {
  return new BarcodeDetector({ formats: [...FORMATS] });
}
