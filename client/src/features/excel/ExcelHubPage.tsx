import {
  AccountBookOutlined,
  AuditOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FileProtectOutlined,
  FileTextOutlined,
  InboxOutlined,
  MedicineBoxOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  TruckOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Empty, Skeleton, Tabs, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState, type ReactNode } from "react";
import { PageHeader } from "../../ui/PageHeader.js";
import { InfoTip } from "../../ui/InfoTip.js";
import { useAuth } from "../auth/auth-context.js";
import { ExcelExportButton } from "./ExcelButtons.js";
import { rangeParams } from "./excel-api.js";
import { ExcelImportModal } from "./ExcelImportModal.js";
import { downloadTemplate, fetchCatalog, type ExportType, type ImportType } from "./excel-api.js";

/** short: một dòng trên thẻ; text: giải thích đầy đủ trong biểu tượng "?". */
const IMPORT_INFO: Record<string, { icon: ReactNode; step: number; short: string; text: string }> =
  {
    products: {
      icon: <MedicineBoxOutlined />,
      step: 1,
      short: "Thuốc, đơn vị, mã vạch, giá bán",
      text: "Thêm hoặc cập nhật hàng loạt thuốc, hoạt chất, đơn vị quy đổi, mã vạch và giá bán. Xuất danh mục ra, sửa trong Excel rồi nhập lại.",
    },
    suppliers: {
      icon: <TruckOutlined />,
      step: 2,
      short: "Mã số thuế, giấy phép dược",
      text: "Nhà cung cấp kèm mã số thuế, số giấy phép kinh doanh dược — cần cho phiếu nhập và hồ sơ GPP.",
    },
    customers: {
      icon: <TeamOutlined />,
      step: 3,
      short: "Trùng số điện thoại thì cập nhật",
      text: "Chuyển danh sách khách từ sổ tay hoặc phần mềm cũ. Trùng số điện thoại thì cập nhật, không tạo khách trùng.",
    },
    "opening-balance": {
      icon: <DatabaseOutlined />,
      step: 4,
      short: "Tồn từng lô lúc bắt đầu dùng",
      text: "Tồn thực tế từng lô (số lô, hạn dùng, giá vốn) khi bắt đầu dùng phần mềm. Chỉ dùng được trước hóa đơn bán đầu tiên của cửa hàng.",
    },
  };

const EXPORT_INFO: Record<string, { icon: ReactNode; short: string; text: string }> = {
  "revenue-book-s1a": {
    icon: <AccountBookOutlined />,
    short: "Hộ doanh thu đến 500 triệu/năm",
    text: "Sổ kế toán bắt buộc từ 01/01/2026 (TT 152/2025) cho hộ có doanh thu đến 500 triệu/năm. Mỗi ngày một dòng, đã trừ hóa đơn hủy và tiền hoàn.",
  },
  "revenue-book-s2a": {
    icon: <AccountBookOutlined />,
    short: "Hộ doanh thu từ 500 triệu/năm",
    text: "Cho hộ có doanh thu từ 500 triệu/năm, nộp thuế theo tỷ lệ. Hai dòng thuế để trống cho người khai thuế điền.",
  },
  "rx-sales": {
    icon: <SafetyCertificateOutlined />,
    short: "Sổ bán thuốc kê đơn cho thanh tra GPP",
    text: "Sổ theo dõi bán thuốc kê đơn: người bệnh, mã đơn, người kê, cơ sở khám chữa bệnh, chẩn đoán, số lô, hạn dùng và người bán — phục vụ thanh tra GPP.",
  },
  "controlled-ledger": {
    icon: <SafetyCertificateOutlined />,
    short: "Nhập, xuất, tồn thuốc kiểm soát",
    text: "Sổ theo dõi nhập, xuất, tồn thuốc kiểm soát đặc biệt trong kỳ, kèm số lô. Mỗi lần xuất được ghi nhật ký.",
  },
  "period-summary": {
    icon: <FileTextOutlined />,
    short: "Nhập, bán, hàng đứng yên trong kỳ",
    text: "Tổng kết kỳ: hàng đã nhập, bán chạy và bán chậm, hàng không bán được, bảng nhập – xuất – tồn.",
  },
  invoices: {
    icon: <FileTextOutlined />,
    short: "Hóa đơn và từng dòng kèm lô",
    text: "Hóa đơn trong kỳ và chi tiết từng dòng kèm lô xuất theo FEFO. Dùng đối soát doanh thu, gửi kế toán.",
  },
  "goods-receipts": {
    icon: <InboxOutlined />,
    short: "Phiếu nhập kèm lô, hạn dùng",
    text: "Phiếu nhập và chi tiết lô, ngày sản xuất, hạn dùng, số hóa đơn nhà cung cấp — đối chiếu công nợ và hồ sơ kiểm nhập.",
  },
  inventory: {
    icon: <DatabaseOutlined />,
    short: "Tồn từng lô theo hạn dùng",
    text: "Tồn từng lô xếp theo hạn dùng, số ngày còn lại, vị trí kệ, trạng thái biệt trữ; kèm giá vốn nếu bạn có quyền. Dùng khi kiểm kê.",
  },
  "stock-count": {
    icon: <DatabaseOutlined />,
    short: "Phiếu đếm của đợt kiểm kê đang mở",
    text: "Danh sách lô cần đếm của đợt kiểm kê đang mở, xếp theo vị trí kệ. In ra để đếm, điền số rồi nhập lại.",
  },
  "purchase-order": {
    icon: <InboxOutlined />,
    short: "Số lượng nên đặt theo lượng bán",
    text: "Mặt hàng cần đặt và số lượng đề xuất, tính theo lượng bán 30 ngày gần nhất. Là gợi ý: soát lại trước khi gửi nhà cung cấp.",
  },
  products: {
    icon: <MedicineBoxOutlined />,
    short: "Danh mục đúng mẫu nhập",
    text: "Toàn bộ danh mục kèm giá hiện hành và tồn bán được. Đúng mẫu nhập: sửa hàng loạt xong nhập lại được.",
  },
  suppliers: {
    icon: <TruckOutlined />,
    short: "Nhà cung cấp đúng mẫu nhập",
    text: "Danh sách nhà cung cấp đúng mẫu nhập.",
  },
  customers: {
    icon: <TeamOutlined />,
    short: "Khách hàng kèm số điện thoại",
    text: "Khách hàng có số điện thoại đầy đủ để gọi chăm sóc. Dữ liệu cá nhân: mỗi lần xuất được ghi nhật ký.",
  },
};

type RangeValue = [Dayjs, Dayjs];
type ExportItem = {
  type: string;
  title: string;
  dated: boolean;
  needsStore: boolean;
  audited?: boolean;
};

/** Sổ sách bắt buộc (thuế, GPP) tách nhóm riêng; còn lại chia theo kỳ / hiện tại. */
const BOOKS = ["revenue-book-s1a", "revenue-book-s2a", "rx-sales", "controlled-ledger"];
const EXPORT_GROUPS: Array<{ key: string; title: string; match: (item: ExportItem) => boolean }> = [
  { key: "books", title: "Sổ sách thuế & GPP", match: (item) => BOOKS.includes(item.type) },
  {
    key: "period",
    title: "Báo cáo theo kỳ",
    match: (item) => item.dated && !BOOKS.includes(item.type),
  },
  {
    key: "current",
    title: "Dữ liệu hiện tại",
    match: (item) => !item.dated && !BOOKS.includes(item.type),
  },
];

/** Mẫu nhập chưa có mô tả ngắn: lấy câu đầu của hướng dẫn, phần còn lại trong "?". */
function firstSentence(text: string): string {
  return text.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "");
}

export function ExcelHubPage() {
  const { storeId, me } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState<{ type: ImportType; title: string } | null>(null);
  const [range, setRange] = useState<RangeValue>(() => [dayjs().startOf("month"), dayjs()]);
  const [downloading, setDownloading] = useState<string | null>(null);

  const catalog = useQuery({ queryKey: ["excel", "catalog", storeId], queryFn: fetchCatalog });
  const storeName = me?.stores.find((store) => store.id === storeId)?.name;

  async function template(type: ImportType) {
    setDownloading(type);
    try {
      await downloadTemplate(type);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không tải được tệp mẫu");
    } finally {
      setDownloading(null);
    }
  }

  const exports = [...(catalog.data?.exports ?? [])].sort(
    (a, b) => Object.keys(EXPORT_INFO).indexOf(a.type) - Object.keys(EXPORT_INFO).indexOf(b.type),
  );

  return (
    <div className="excel-hub">
      <PageHeader
        icon={<FileExcelOutlined />}
        title="Nhập / xuất Excel"
        description={`Áp dụng cho ${storeName ?? "cửa hàng đang chọn"}`}
      />

      {catalog.isLoading ? <Skeleton active /> : null}
      {catalog.isError ? (
        <Alert type="error" showIcon title="Không tải được danh sách chức năng Excel" />
      ) : null}

      {catalog.data ? (
        <>
          <Tabs
            className="excel-tabs"
            defaultActiveKey="export"
            items={[
              {
                key: "export",
                label: "Xuất",
                children: (
                  <>
                    <div className="excel-range">
                      <span>Kỳ</span>
                      <DatePicker.RangePicker
                        value={range}
                        allowClear={false}
                        format="DD/MM/YYYY"
                        disabledDate={(day) => day.isAfter(dayjs(), "day")}
                        presets={RANGE_PRESETS()}
                        onChange={(value) => {
                          if (value?.[0] && value[1]) setRange([value[0], value[1]]);
                        }}
                      />
                      <InfoTip>
                        Áp dụng cho sổ sách và báo cáo theo kỳ (tối đa 366 ngày). Tệp .xlsx có định
                        dạng sẵn: tiền, ngày kiểu Việt Nam, cố định tiêu đề, bật lọc.
                      </InfoTip>
                    </div>
                    {exports.length === 0 ? (
                      <Empty description="Vai trò của bạn chưa được xuất dữ liệu" />
                    ) : (
                      EXPORT_GROUPS.map((group) => {
                        const items = exports.filter(group.match);
                        if (items.length === 0) return null;
                        return (
                          <section key={group.key} className="excel-section">
                            <h2 className="excel-group-title">{group.title}</h2>
                            <div className="excel-grid">
                              {items.map((item) => (
                                <ExportCard
                                  key={item.type}
                                  item={item}
                                  range={range}
                                  disabled={item.needsStore && !storeId}
                                />
                              ))}
                            </div>
                          </section>
                        );
                      })
                    )}
                  </>
                ),
              },
              {
                key: "import",
                label: "Nhập",
                children: (
                  <section className="excel-section">
                    <p className="excel-hint">
                      Mới dùng phần mềm: nhập theo thứ tự 1 → 4
                      <InfoTip>
                        Mỗi tệp được kiểm tra toàn bộ trước khi ghi, có lỗi thì không ghi dòng nào.
                      </InfoTip>
                    </p>
                    {catalog.data.imports.length === 0 ? (
                      <Empty description="Vai trò của bạn chưa được nhập dữ liệu từ Excel" />
                    ) : (
                      <div className="excel-grid">
                        {catalog.data.imports.map((item) => {
                          const info = IMPORT_INFO[item.type];
                          const disabled = item.needsStore && !storeId;
                          return (
                            <article key={item.type} className="excel-card">
                              <div className="excel-card-head">
                                <span className="excel-card-icon">
                                  {info?.icon ?? <UploadOutlined />}
                                </span>
                                <div>
                                  <h3>
                                    {info ? <span className="excel-step">{info.step}</span> : null}
                                    {item.title}
                                  </h3>
                                  {item.needsStore ? (
                                    <Tag variant="filled">Theo cửa hàng</Tag>
                                  ) : (
                                    <Tag variant="filled" color="blue">
                                      Toàn chuỗi
                                    </Tag>
                                  )}
                                </div>
                              </div>
                              <p className="excel-card-text">
                                {info?.short ?? firstSentence(item.guide[0] ?? "")}
                                <InfoTip>{info?.text ?? item.guide.join(" ")}</InfoTip>
                              </p>
                              <div className="excel-card-actions">
                                <Button
                                  icon={<DownloadOutlined />}
                                  loading={downloading === item.type}
                                  onClick={() => void template(item.type)}
                                >
                                  Tải mẫu
                                </Button>
                                <Tooltip title={disabled ? "Chọn cửa hàng trước" : undefined}>
                                  <Button
                                    type="primary"
                                    icon={<UploadOutlined />}
                                    disabled={disabled}
                                    onClick={() =>
                                      setImporting({ type: item.type, title: item.title })
                                    }
                                  >
                                    Nhập từ Excel
                                  </Button>
                                </Tooltip>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                ),
              },
            ]}
          />
        </>
      ) : null}

      {importing ? (
        <ExcelImportModal
          type={importing.type}
          title={importing.title}
          open
          hint={
            importing.type === "opening-balance"
              ? `Tồn được ghi vào ${storeName ?? "cửa hàng đang chọn"}.`
              : undefined
          }
          onClose={() => setImporting(null)}
          onDone={() => void queryClient.invalidateQueries()}
        />
      ) : null}
    </div>
  );
}

const RANGE_PRESETS = (): Array<{ label: string; value: RangeValue }> => [
  { label: "Hôm nay", value: [dayjs(), dayjs()] },
  { label: "7 ngày", value: [dayjs().subtract(6, "day"), dayjs()] },
  { label: "Tháng này", value: [dayjs().startOf("month"), dayjs()] },
  {
    label: "Tháng trước",
    value: [
      dayjs().subtract(1, "month").startOf("month"),
      dayjs().subtract(1, "month").endOf("month"),
    ],
  },
  {
    label: "Quý này",
    value: [
      dayjs()
        .startOf("month")
        .subtract(dayjs().month() % 3, "month"),
      dayjs(),
    ],
  },
];

function ExportCard({
  item,
  range,
  disabled,
}: {
  item: ExportItem;
  range: RangeValue;
  disabled: boolean;
}) {
  const info = EXPORT_INFO[item.type];
  return (
    <article className="excel-card">
      <div className="excel-card-head">
        <span className="excel-card-icon">{info?.icon ?? <FileProtectOutlined />}</span>
        <div>
          <h3>{item.title}</h3>
          {item.audited ? (
            <span className="excel-card-tags">
              <Tag variant="filled" color="purple" icon={<AuditOutlined />}>
                Ghi nhật ký
              </Tag>
            </span>
          ) : null}
        </div>
      </div>
      {info ? (
        <p className="excel-card-text">
          {info.short}
          <InfoTip>{info.text}</InfoTip>
        </p>
      ) : null}
      <div className="excel-card-actions">
        {disabled ? (
          <Tooltip title="Chọn cửa hàng trước">
            <Button icon={<FileExcelOutlined />} disabled>
              Xuất Excel
            </Button>
          </Tooltip>
        ) : (
          <ExcelExportButton
            type={item.type as ExportType}
            range={item.dated ? rangeParams(range) : undefined}
          />
        )}
      </div>
    </article>
  );
}
