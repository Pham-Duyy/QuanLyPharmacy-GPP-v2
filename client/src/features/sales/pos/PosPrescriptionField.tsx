import { CloseOutlined, FileProtectOutlined, PlusOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { AutoComplete, Button, Input } from "antd";
import { http } from "../../../api/http.js";
import type { Envelope, PrescriptionDetail, PrescriptionListItem } from "../../../api/types.js";
import { ERX_CODE, findErxCode } from "../../prescriptions/eprescription-api.js";
import { CameraScanButton } from "../../scanning/CameraScan.js";

/** Giá trị đặc biệt trong ô chọn đơn: lấy đơn điện tử theo mã đang gõ. */
const ERX_OPTION = "__erx__";

/** Đơn thuốc của đơn bán: đơn đã gắn, hoặc ô chọn đơn đã xác nhận / lấy đơn điện tử. */
export function PosPrescriptionField({
  prescription,
  pending,
  canRead,
  search,
  onSearchChange,
  onAttach,
  onLoadErx,
  onClear,
  onAddLines,
}: {
  prescription: PrescriptionDetail | null;
  pending: number;
  canRead: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onAttach: (id: string) => Promise<void>;
  onLoadErx: (code: string) => Promise<void>;
  onClear: () => void;
  onAddLines: () => void;
}) {
  // Tải một lần rồi lọc theo mã hoặc tên khách ngay trên trình duyệt. Endpoint
  // chỉ lọc được một trạng thái mỗi lần gọi, nên lấy hết rồi tự lọc còn dùng
  // bán tiếp được: VERIFIED hoặc PARTIALLY_DISPENSED (contract §5.4).
  const verifiedPrescriptions = useQuery({
    queryKey: ["usable-prescriptions"],
    enabled: canRead,
    queryFn: async () =>
      (await http.get<Envelope<PrescriptionListItem[]>>("/prescriptions")).data.data.filter(
        (item) => item.status === "VERIFIED" || item.status === "PARTIALLY_DISPENSED",
      ),
  });

  return (
    <>
      {prescription ? (
        <>
          <div className="pos-field pos-field-rx">
            <FileProtectOutlined />
            <span>
              Đơn thuốc: <strong>{prescription.code}</strong>
            </span>
            <span className="muted">{prescription.customer?.fullName ?? "Khách lẻ"}</span>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label="Bỏ đơn thuốc"
              onClick={onClear}
            />
          </div>
          {pending > 0 ? (
            <Button block type="dashed" icon={<PlusOutlined />} onClick={onAddLines}>
              Thêm {pending} thuốc theo đơn
            </Button>
          ) : null}
        </>
      ) : canRead ? (
        <div className="pos-attach-row">
          <AutoComplete
            className="pos-field-input"
            value={search}
            onChange={onSearchChange}
            filterOption={(input, option) =>
              typeof option?.label === "string" &&
              option.label.toLowerCase().includes(input.toLowerCase())
            }
            options={[
              // Gõ hoặc quét đúng mã đơn điện tử: lấy đơn từ hệ thống quốc gia ngay tại quầy.
              ...(ERX_CODE.test(search.trim())
                ? [
                    {
                      value: ERX_OPTION,
                      label: `Lấy đơn điện tử ${search.trim()}`,
                    },
                  ]
                : []),
              ...(verifiedPrescriptions.data ?? []).map((item) => ({
                value: item.id,
                label: `${item.code} — ${item.customer?.fullName ?? item.patientName ?? "Khách lẻ"}`,
              })),
            ]}
            notFoundContent={
              verifiedPrescriptions.data?.length === 0 ? "Chưa có đơn thuốc đã xác nhận" : null
            }
            onSelect={async (id) => {
              if (id === ERX_OPTION) {
                await onLoadErx(search.trim());
                return;
              }
              await onAttach(id);
            }}
          >
            <Input
              prefix={<FileProtectOutlined />}
              placeholder="Đơn thuốc: chọn đơn đã xác nhận, hoặc quét mã đơn điện tử"
              allowClear
              aria-label="Chọn đơn thuốc"
            />
          </AutoComplete>
          <CameraScanButton
            title="Quét mã đơn thuốc điện tử bằng camera"
            accept={findErxCode}
            wrongCodeMessage="Mã vừa đọc không phải mã đơn thuốc điện tử (14 ký tự, đuôi -c, -n, -h hoặc -y)."
            onDetected={(code) => void onLoadErx(code)}
          />
        </div>
      ) : null}
    </>
  );
}
