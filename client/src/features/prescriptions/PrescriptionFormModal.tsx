import { DeleteOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AutoComplete, Button, DatePicker, Input, Modal, Space, Table, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type {
  Envelope,
  Paged,
  PrescriptionDetail,
  ProductListItem,
} from "../../api/types.js";

type Row = {
  key: string;
  productId: string | null;
  drugNameText: string;
  unitId: string | null;
  unitName: string | null;
  quantity: number;
  dosageInstruction: string;
};

function emptyRow(): Row {
  return {
    key: crypto.randomUUID(),
    productId: null,
    drugNameText: "",
    unitId: null,
    unitName: null,
    quantity: 1,
    dosageInstruction: "",
  };
}

function toRows(prescription: PrescriptionDetail): Row[] {
  return prescription.items.map((item) => ({
    key: item.id,
    productId: item.productId,
    drugNameText: item.drugNameText,
    unitId: item.unitId,
    unitName: item.unitName,
    quantity: item.quantity,
    dosageInstruction: item.dosageInstruction ?? "",
  }));
}

/**
 * Tạo mới hoặc sửa đơn thuốc nháp. Mỗi dòng có thể khớp thẳng một sản phẩm
 * trong danh mục (tìm và chọn), hoặc chỉ ghi tên thuốc bằng tay nếu sản
 * phẩm chưa có trong hệ thống — contract §12 cho phép cả hai, chỉ bắt buộc
 * khớp hết trước khi dược sĩ xác nhận.
 */
export function PrescriptionFormModal({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  /** Có giá trị thì là sửa đơn nháp đã có; không thì tạo mới. */
  editing: PrescriptionDetail | null;
}) {
  const queryClient = useQueryClient();
  const [prescriberName, setPrescriberName] = useState("");
  const [facilityName, setFacilityName] = useState("");
  const [diagnosisText, setDiagnosisText] = useState("");
  const [prescribedDate, setPrescribedDate] = useState<Dayjs>(dayjs());
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setPrescriberName(editing.prescriberName ?? "");
      setFacilityName(editing.facilityName ?? "");
      setDiagnosisText(editing.diagnosisText ?? "");
      setPrescribedDate(dayjs(editing.prescribedDate));
      setRows(toRows(editing));
    } else {
      setPrescriberName("");
      setFacilityName("");
      setDiagnosisText("");
      setPrescribedDate(dayjs());
      setRows([emptyRow()]);
    }
  }, [open, editing]);

  const search_ = useQuery({
    queryKey: ["prescription-product-search", search],
    enabled: search.length > 0,
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: { search, limit: 10 },
      });
      return response.data.data.items;
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        prescriberName: prescriberName || null,
        facilityName: facilityName || null,
        diagnosisText: diagnosisText || null,
        prescribedDate: prescribedDate.format("YYYY-MM-DD"),
        items: rows.map((row) => ({
          productId: row.productId,
          unitId: row.unitId,
          drugNameText: row.drugNameText,
          quantity: row.quantity,
          dosageInstruction: row.dosageInstruction || null,
        })),
      };

      if (editing) {
        await http.patch(`/prescriptions/${editing.id}`, { ...body, version: editing.version });
      } else {
        await http.post("/prescriptions", body);
      }
    },
    onSuccess: async () => {
      void message.success(editing ? "Đã lưu đơn thuốc" : "Đã tạo đơn thuốc nháp");
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["prescriptions"] });
      if (editing) await queryClient.invalidateQueries({ queryKey: ["prescription", editing.id] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được đơn thuốc")),
  });

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  /** Chọn từ ô tìm kiếm phía trên thì luôn thêm một dòng mới đã khớp sẵn sản phẩm. */
  async function addMatchedRow(productId: string) {
    const response = await http.get<
      Envelope<{
        id: string;
        name: string;
        units: Array<{ id: string; name: string; isDefaultSaleUnit?: boolean }>;
      }>
    >(`/products/${productId}`);
    const product = response.data.data;
    const unit = product.units.find((u) => u.isDefaultSaleUnit) ?? product.units[0];

    setRows((current) => [
      ...current,
      {
        ...emptyRow(),
        productId: product.id,
        drugNameText: product.name,
        unitId: unit?.id ?? null,
        unitName: unit?.name ?? null,
      },
    ]);
    setSearch("");
  }

  const canSave = rows.length > 0 && rows.every((row) => row.drugNameText.trim().length > 0);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => save.mutate()}
      okText={editing ? "Lưu" : "Tạo đơn nháp"}
      okButtonProps={{ disabled: !canSave }}
      confirmLoading={save.isPending}
      width={760}
      title={editing ? `Sửa đơn thuốc — ${editing.code}` : "Tạo đơn thuốc"}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Space wrap>
          <Input
            style={{ width: 220 }}
            placeholder="Tên bác sĩ kê đơn"
            value={prescriberName}
            onChange={(event) => setPrescriberName(event.target.value)}
          />
          <Input
            style={{ width: 260 }}
            placeholder="Cơ sở khám chữa bệnh"
            value={facilityName}
            onChange={(event) => setFacilityName(event.target.value)}
          />
          <DatePicker
            value={prescribedDate}
            onChange={(value) => value && setPrescribedDate(value)}
            format="DD/MM/YYYY"
            placeholder="Ngày kê đơn"
          />
        </Space>
        <Input.TextArea
          rows={2}
          placeholder="Chẩn đoán"
          value={diagnosisText}
          onChange={(event) => setDiagnosisText(event.target.value)}
        />

        <AutoComplete
          style={{ width: "100%" }}
          value={search}
          onChange={setSearch}
          options={(search_.data ?? []).map((product) => ({
            value: product.id,
            label: `${product.name} (${product.code})`,
          }))}
          onSelect={(productId) => void addMatchedRow(productId)}
        >
          <Input.Search placeholder="Tìm sản phẩm trong danh mục để thêm một dòng đã khớp sẵn" allowClear />
        </AutoComplete>

        <Table
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: "Tên thuốc",
              render: (_, row: Row) => (
                <Space direction="vertical" size={0} style={{ width: "100%" }}>
                  <Input
                    size="small"
                    value={row.drugNameText}
                    placeholder="Ghi tên thuốc"
                    onChange={(event) => updateRow(row.key, { drugNameText: event.target.value })}
                  />
                  {row.productId ? (
                    <span style={{ color: "#0a7657", fontSize: 12 }}>Đã khớp sản phẩm trong danh mục</span>
                  ) : (
                    <span style={{ color: "#999", fontSize: 12 }}>Chưa khớp sản phẩm</span>
                  )}
                </Space>
              ),
            },
            {
              title: "Đơn vị",
              width: 100,
              render: (_, row: Row) => row.unitName ?? "—",
            },
            {
              title: "SL",
              width: 80,
              render: (_, row: Row) => (
                <Input
                  size="small"
                  type="number"
                  min={1}
                  value={row.quantity}
                  onChange={(event) =>
                    updateRow(row.key, { quantity: Number(event.target.value) || 1 })
                  }
                />
              ),
            },
            {
              title: "Liều dùng",
              render: (_, row: Row) => (
                <Input
                  size="small"
                  value={row.dosageInstruction}
                  placeholder="Ví dụ: ngày 2 lần, mỗi lần 1 viên"
                  onChange={(event) =>
                    updateRow(row.key, { dosageInstruction: event.target.value })
                  }
                />
              ),
            },
            {
              width: 40,
              render: (_, row: Row) => (
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                />
              ),
            },
          ]}
        />
        <Button onClick={() => setRows((current) => [...current, emptyRow()])}>Thêm dòng</Button>
      </Space>
    </Modal>
  );
}
