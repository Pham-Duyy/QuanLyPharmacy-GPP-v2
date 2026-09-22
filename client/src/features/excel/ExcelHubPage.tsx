import {
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
import { Alert, App, Button, DatePicker, Empty, Skeleton, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState, type ReactNode } from "react";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import { ExcelExportButton } from "./ExcelButtons.js";
import { rangeParams } from "./excel-api.js";
import { ExcelImportModal } from "./ExcelImportModal.js";
import { downloadTemplate, fetchCatalog, type ExportType, type ImportType } from "./excel-api.js";

const IMPORT_INFO: Record<string, { icon: ReactNode; step: number; text: string }> = {
  products: {
    icon: <MedicineBoxOutlined />,
    step: 1,
    text: "Thêm hoặc cập nhật hàng loạt thuốc, hoạt chất, đơn vị quy đổi, mã vạch và giá bán. Xuất danh mục ra, sửa trong Excel rồi nhập lại.",
  },
  suppliers: { icon: <TruckOutlined />, step: 2, text: "Nhà cung cấp kèm mã số thuế, số giấy phép kinh doanh dược — cần cho phiếu nhập và hồ sơ GPP." },
  customers: { icon: <TeamOutlined />, step: 3, text: "Chuyển danh sách khách từ sổ tay hoặc phần mềm cũ. Trùng số điện thoại thì cập nhật, không tạo khách trùng." },
  "opening-balance": {
    icon: <DatabaseOutlined />,
    step: 4,
    text: "Tồn thực tế từng lô (số lô, hạn dùng, giá vốn) khi bắt đầu dùng phần mềm. Chỉ dùng được trước hóa đơn bán đầu tiên của cửa hàng.",
  },
};

const EXPORT_INFO: Record<string, { icon: ReactNode; text: string }> = {
  "rx-sales": {
    icon: <SafetyCertificateOutlined />,
    text: "Sổ theo dõi bán thuốc kê đơn: người bệnh, mã đơn, người kê, cơ sở khám chữa bệnh, chẩn đoán, số lô, hạn dùng và người bán — phục vụ thanh tra GPP.",
  },
  invoices: { icon: <FileTextOutlined />, text: "Hóa đơn trong kỳ và chi tiết từng dòng kèm lô xuất theo FEFO. Dùng đối soát doanh thu, gửi kế toán." },
  "goods-receipts": { icon: <InboxOutlined />, text: "Phiếu nhập và chi tiết lô, ngày sản xuất, hạn dùng, số hóa đơn nhà cung cấp — đối chiếu công nợ và hồ sơ kiểm nhập." },
  inventory: { icon: <DatabaseOutlined />, text: "Tồn từng lô xếp theo hạn dùng, số ngày còn lại, vị trí kệ, trạng thái biệt trữ; kèm giá vốn nếu bạn có quyền. Dùng khi kiểm kê." },
  products: { icon: <MedicineBoxOutlined />, text: "Toàn bộ danh mục kèm giá hiện hành và tồn bán được. Đúng mẫu nhập: sửa hàng loạt xong nhập lại được." },
  suppliers: { icon: <TruckOutlined />, text: "Danh sách nhà cung cấp đúng mẫu nhập." },
  customers: { icon: <TeamOutlined />, text: "Khách hàng có số điện thoại đầy đủ để gọi chăm sóc. Dữ liệu cá nhân: mỗi lần xuất được ghi nhật ký." },
};

type RangeValue = [Dayjs, Dayjs];

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

  const exports = [...(catalog.data?.exports ?? [])].sort((a, b) => Object.keys(EXPORT_INFO).indexOf(a.type) - Object.keys(EXPORT_INFO).indexOf(b.type));

  return (
    <div className="excel-hub">
      <PageHeader
        icon={<FileExcelOutlined />}
        title="Nhập / xuất Excel"
        description={`Chuyển dữ liệu giữa phần mềm và Excel. Dữ liệu theo cửa hàng áp dụng cho ${storeName ?? "cửa hàng đang chọn"}.`}
      />

      {catalog.isLoading ? <Skeleton active /> : null}
      {catalog.isError ? <Alert type="error" showIcon title="Không tải được danh sách chức năng Excel" /> : null}

      {catalog.data ? (
        <>
          <section className="excel-section">
            <div className="excel-section-head">
              <div>
                <h2>Nhập dữ liệu</h2>
                <p>Mới bắt đầu dùng phần mềm: nhập theo đúng thứ tự đánh số. Mỗi tệp được kiểm tra toàn bộ trước khi ghi, có lỗi thì không ghi dòng nào.</p>
              </div>
            </div>
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
                        <span className="excel-card-icon">{info?.icon ?? <UploadOutlined />}</span>
                        <div>
                          <h3>
                            {info ? <span className="excel-step">{info.step}</span> : null}
                            {item.title}
                          </h3>
                          {item.needsStore ? <Tag variant="filled">Theo cửa hàng</Tag> : <Tag variant="filled" color="blue">Toàn chuỗi</Tag>}
                        </div>
                      </div>
                      <p className="excel-card-text">{info?.text ?? item.guide[0]}</p>
                      <div className="excel-card-actions">
                        <Button icon={<DownloadOutlined />} loading={downloading === item.type} onClick={() => void template(item.type)}>
                          Tải mẫu
                        </Button>
                        <Tooltip title={disabled ? "Chọn cửa hàng trước" : undefined}>
                          <Button type="primary" icon={<UploadOutlined />} disabled={disabled} onClick={() => setImporting({ type: item.type, title: item.title })}>
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

          <section className="excel-section">
            <div className="excel-section-head">
              <div>
                <h2>Xuất dữ liệu & sổ sách</h2>
                <p>Tệp .xlsx có định dạng sẵn: tiền, ngày kiểu Việt Nam, cố định tiêu đề, bật lọc. Mục theo kỳ dùng khoảng ngày bên phải (tối đa 366 ngày).</p>
              </div>
              <DatePicker.RangePicker
                value={range}
                allowClear={false}
                format="DD/MM/YYYY"
                disabledDate={(day) => day.isAfter(dayjs(), "day")}
                presets={[
                  { label: "Hôm nay", value: [dayjs(), dayjs()] },
                  { label: "7 ngày", value: [dayjs().subtract(6, "day"), dayjs()] },
                  { label: "Tháng này", value: [dayjs().startOf("month"), dayjs()] },
                  { label: "Tháng trước", value: [dayjs().subtract(1, "month").startOf("month"), dayjs().subtract(1, "month").endOf("month")] },
                  { label: "Quý này", value: [dayjs().startOf("month").subtract(dayjs().month() % 3, "month"), dayjs()] },
                ]}
                onChange={(value) => {
                  if (value?.[0] && value[1]) setRange([value[0], value[1]]);
                }}
              />
            </div>
            {exports.length === 0 ? (
              <Empty description="Vai trò của bạn chưa được xuất dữ liệu" />
            ) : (
              <div className="excel-grid">
                {exports.map((item) => {
                  const info = EXPORT_INFO[item.type];
                  const disabled = item.needsStore && !storeId;
                  return (
                    <article key={item.type} className={`excel-card ${item.type === "rx-sales" ? "is-featured" : ""}`}>
                      <div className="excel-card-head">
                        <span className="excel-card-icon">{info?.icon ?? <FileProtectOutlined />}</span>
                        <div>
                          <h3>{item.title}</h3>
                          <span className="excel-card-tags">
                            {item.dated ? <Tag variant="filled" color="gold">Theo kỳ</Tag> : <Tag variant="filled">Hiện tại</Tag>}
                            {item.audited ? (
                              <Tag variant="filled" color="purple" icon={<AuditOutlined />}>
                                Ghi nhật ký
                              </Tag>
                            ) : null}
                            {item.type === "rx-sales" ? <Tag variant="filled" color="green">GPP</Tag> : null}
                          </span>
                        </div>
                      </div>
                      <p className="excel-card-text">{info?.text}</p>
                      <div className="excel-card-actions">
                        {disabled ? (
                          <Tooltip title="Chọn cửa hàng trước">
                            <Button icon={<FileExcelOutlined />} disabled>
                              Xuất Excel
                            </Button>
                          </Tooltip>
                        ) : (
                          <ExcelExportButton type={item.type as ExportType} range={item.dated ? rangeParams(range) : undefined} />
                        )}
                        {item.dated ? (
                          <span className="excel-card-range">
                            {range[0].format("DD/MM/YYYY")} – {range[1].format("DD/MM/YYYY")}
                          </span>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : null}

      {importing ? (
        <ExcelImportModal
          type={importing.type}
          title={importing.title}
          open
          hint={importing.type === "opening-balance" ? `Tồn được ghi vào ${storeName ?? "cửa hàng đang chọn"}.` : undefined}
          onClose={() => setImporting(null)}
          onDone={() => void queryClient.invalidateQueries()}
        />
      ) : null}
    </div>
  );
}
