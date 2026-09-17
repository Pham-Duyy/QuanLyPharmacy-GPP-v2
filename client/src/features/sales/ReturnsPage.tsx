import { FileSearchOutlined, PrinterOutlined, RollbackOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Card, Empty, Skeleton, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import { formatVnd, type Envelope, type Paged, type ReturnDetail, type ReturnListItem } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { paymentMethodLabel } from "../../ui/labels.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { printDocument, printUrl } from "../printing/printing.js";
import { PrintPreviewModal } from "../printing/PrintPreviewModal.js";

function DispositionTag({ value }: { value: ReturnListItem["disposition"] }) {
  return value === "RESTOCK" ? <Tag color="green">Nhập lại kho</Tag> : <Tag color="red">Xuất hủy</Tag>;
}

export function ReturnsPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const list = useQuery({
    queryKey: ["returns", page],
    queryFn: async () => (await http.get<Envelope<Paged<ReturnListItem>>>("/returns", { params: { page, limit: 20 } })).data.data,
    placeholderData: (previous) => previous,
  });

  const detail = useQuery({
    queryKey: ["return", openId],
    enabled: openId !== null,
    queryFn: async () => (await http.get<Envelope<ReturnDetail>>(`/returns/${openId}`)).data.data,
  });

  return (
    <div>
      <PageHeader
        icon={<RollbackOutlined />}
        title="Trả hàng"
        description="Phiếu khách trả hàng. Muốn nhận trả, mở hóa đơn gốc ở trang Hóa đơn rồi chọn “Nhận trả hàng”."
      />
      <div className="split-layout">
        <Card>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data?.items ?? []}
            scroll={{ x: 640 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có phiếu trả hàng" /> }}
            pagination={{
              current: page,
              pageSize: list.data?.pagination.limit ?? 20,
              total: list.data?.pagination.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
              showTotal: (total) => `${total} phiếu`,
            }}
            columns={[
              {
                title: "Phiếu trả",
                key: "code",
                render: (_: unknown, row: ReturnListItem) => (
                  <div className="cell-main">
                    <strong className="mono">{row.code}</strong>
                    <span>{formatDateTime(row.createdAt)}</span>
                  </div>
                ),
              },
              {
                title: "Hóa đơn gốc · Người nhận",
                key: "invoice",
                render: (_: unknown, row: ReturnListItem) => (
                  <div className="cell-main">
                    <strong className="mono">{row.invoiceCode}</strong>
                    <span>{row.createdByName}</span>
                  </div>
                ),
              },
              { title: "Xử lý", key: "disposition", width: 130, render: (_: unknown, row: ReturnListItem) => <DispositionTag value={row.disposition} /> },
              { title: "Tiền hoàn", key: "refund", width: 120, align: "right", render: (_: unknown, row: ReturnListItem) => <Typography.Text strong>{formatVnd(row.refundAmount)}</Typography.Text> },
            ]}
          />
        </Card>
        <aside className="split-aside">
          {openId === null ? (
            <Card title="Chi tiết phiếu trả">
              <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn phiếu trả" description="Bấm vào một phiếu để xem dòng hàng, lô và tiền hoàn." />
            </Card>
          ) : (
            <Card title={detail.data ? <span className="mono">{detail.data.code}</span> : "Chi tiết phiếu trả"} extra={
                detail.data ? (
                  <span className="row-actions">
                    <DispositionTag value={detail.data.disposition} />
                    <Button size="small" icon={<FileSearchOutlined />} onClick={() => setPreviewing(true)}>
                      Xem trước
                    </Button>
                    <Button size="small" icon={<PrinterOutlined />} onClick={() => void printDocument(printUrl.return(detail.data!.id), message)}>
                      In phiếu
                    </Button>
                  </span>
                ) : null
              }
            >
              {detail.isLoading || !detail.data ? (
                <Skeleton active paragraph={{ rows: 6 }} />
              ) : (
                <div className="detail-stack">
                  <div className="invoice-total">
                    <span>Tiền hoàn cho khách</span>
                    <strong>{formatVnd(detail.data.refundAmount)}</strong>
                  </div>
                  <dl className="kv-list">
                    <div>
                      <dt>Hóa đơn gốc</dt>
                      <dd>
                        <Typography.Link className="mono" onClick={() => void navigate(`/hoa-don?id=${detail.data.invoice.id}`)}>
                          {detail.data.invoice.code}
                        </Typography.Link>
                      </dd>
                    </div>
                    <div>
                      <dt>Thời điểm</dt>
                      <dd>{formatDateTime(detail.data.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Người nhận</dt>
                      <dd>{detail.data.createdBy.fullName}</dd>
                    </div>
                    <div>
                      <dt>Hoàn tiền bằng</dt>
                      <dd>{detail.data.refundMethod ? paymentMethodLabel(detail.data.refundMethod) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Hàng trả về</dt>
                      <dd>{detail.data.disposition === "RESTOCK" ? "Nhập lại kho, bán lại được" : "Xuất hủy, không bán lại"}</dd>
                    </div>
                    <div>
                      <dt>Lý do</dt>
                      <dd>{detail.data.reason ?? "—"}</dd>
                    </div>
                  </dl>
                  <div className="line-list">
                    <div className="line-list-head">
                      <span>{detail.data.lines.length} dòng hàng</span>
                    </div>
                    {detail.data.lines.map((line) => (
                      <div className="line-item" key={line.id}>
                        <div className="line-item-main">
                          <strong>{line.productName}</strong>
                          <span>
                            Lô <span className="mono">{line.batchNumber}</span> · HSD {formatDate(line.expiryDate)}
                          </span>
                        </div>
                        <div className="line-item-side">
                          <strong>{formatVnd(line.refundAmount)}</strong>
                          <span>
                            {formatNumber(line.quantity)} {line.unitName}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}
        </aside>
      </div>
      <PrintPreviewModal url={previewing && openId ? printUrl.return(openId) : null} title={`Xem trước phiếu trả ${detail.data?.code ?? ""}`} onClose={() => setPreviewing(false)} />
    </div>
  );
}
