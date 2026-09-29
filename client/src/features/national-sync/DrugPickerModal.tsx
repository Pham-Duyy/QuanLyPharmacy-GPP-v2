import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, Empty, Input, List, Modal, Select, Skeleton, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { searchDrugs, setMapping, type MappingRow, type NationalDrug } from "./nds-api.js";

type Props = {
  row: MappingRow | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
};

/**
 * Chọn mã thuốc quốc gia cho một mặt hàng. Tìm theo tên, số đăng ký hoặc mã
 * thuốc trong bản danh mục đã đồng bộ về máy — không gọi thẳng API quốc gia
 * mỗi lần gõ, vì API đó có giới hạn tần suất.
 */
export function DrugPickerModal({ row, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<NationalDrug | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const search = useDebounced(term, 350);

  const drugs = useQuery({
    queryKey: ["nds", "drugs", search],
    queryFn: () => searchDrugs(search),
    enabled: row !== null,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!row || !picked || !unitId) throw new Error("Chưa chọn đủ thuốc và đơn vị tính");
      const packaging = picked.packagings.find((item) => item.unit_id === unitId);
      await setMapping(row.productId, { drugId: picked.id, unitId, gtin: packaging?.gtin ?? null });
    },
    onSuccess: async () => {
      void message.success("Đã ghép mã thuốc quốc gia");
      await onSaved();
      close();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ghép được mã")),
  });

  function close(): void {
    setTerm("");
    setPicked(null);
    setUnitId(null);
    onClose();
  }

  function choose(drug: NationalDrug): void {
    setPicked(drug);
    // Đoán sẵn đơn vị trùng tên với đơn vị cơ bản của mặt hàng.
    const guess = drug.packagings.find(
      (item) => (item.unit_name ?? "").toLowerCase() === (row?.baseUnitName ?? "").toLowerCase(),
    );
    setUnitId(guess?.unit_id ?? drug.packagings[0]?.unit_id ?? null);
  }

  return (
    <Modal
      open={row !== null}
      onCancel={close}
      title={row ? `Ghép mã thuốc quốc gia — ${row.code} ${row.name}` : ""}
      width={760}
      okText="Lưu mã ghép"
      cancelText="Đóng"
      okButtonProps={{ disabled: !picked || !unitId, loading: save.isPending }}
      onOk={() => save.mutate()}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title="Chọn đúng thuốc đang bán"
        description="Đối chiếu số đăng ký ghi trên hộp thuốc. Ghép sai mã là báo sai dữ liệu dược lên Bộ Y tế."
        style={{ marginBottom: 12 }}
      />

      <Input.Search
        placeholder="Tìm theo tên thuốc, số đăng ký hoặc mã thuốc"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        allowClear
        style={{ marginBottom: 12 }}
      />

      {drugs.isLoading ? <Skeleton active /> : null}
      {drugs.isError ? (
        <Alert type="error" showIcon title="Không tìm được thuốc" description={getErrorMessage(drugs.error, "")} />
      ) : null}

      {drugs.data && drugs.data.length === 0 ? (
        <Empty description="Không có thuốc nào khớp. Hãy đồng bộ lại danh mục quốc gia." />
      ) : null}

      {drugs.data && drugs.data.length > 0 ? (
        <List
          size="small"
          bordered
          style={{ maxHeight: 300, overflow: "auto" }}
          dataSource={drugs.data}
          renderItem={(drug) => (
            <List.Item
              onClick={() => choose(drug)}
              style={{ cursor: "pointer", background: picked?.id === drug.id ? "var(--c-primary-bg, #e6f4ff)" : undefined }}
            >
              <List.Item.Meta
                title={
                  <span>
                    {drug.name}{" "}
                    {drug.prescriptionStatus === 1 ? <Tag color="orange">Kê đơn</Tag> : null}
                    {drug.specialControlType ? <Tag color="red">Kiểm soát đặc biệt</Tag> : null}
                  </span>
                }
                description={
                  <span className="muted">
                    SĐK {drug.registrationNumber ?? "—"} · {drug.activeIngredient ?? "—"}{" "}
                    {drug.strength ?? ""} · {drug.manufacturerName ?? "—"}
                  </span>
                }
              />
              <span className="muted">{drug.id}</span>
            </List.Item>
          )}
        />
      ) : null}

      {picked ? (
        <div style={{ marginTop: 16 }}>
          <p className="muted" style={{ marginBottom: 6 }}>
            Đơn vị tính gửi lên — phải là đơn vị cơ bản của mặt hàng
            {row?.baseUnitName ? ` (${row.baseUnitName})` : ""}:
          </p>
          <Select
            style={{ width: "100%" }}
            value={unitId}
            onChange={setUnitId}
            placeholder="Chọn đơn vị tính"
            options={picked.packagings.map((packaging) => ({
              value: packaging.unit_id,
              label: `${packaging.unit_name ?? packaging.unit_id}${packaging.gtin ? ` · GTIN ${packaging.gtin}` : ""}`,
            }))}
          />
        </div>
      ) : null}
    </Modal>
  );
}
