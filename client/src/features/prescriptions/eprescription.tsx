import { CloudDownloadOutlined, LinkOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Input, Modal, Select, Space, Typography } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, Paged, PrescriptionItem, ProductListItem } from "../../api/types.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { ERX_CODE, importEPrescription, type ImportResult } from "./eprescription-api.js";

/** Hộp nhập (hoặc quét) mã đơn thuốc điện tử rồi lấy đơn về. */
export function EPrescriptionImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}) {
  const { message } = App.useApp();
  const [code, setCode] = useState("");
  const valid = ERX_CODE.test(code.trim());
  const run = useMutation({
    mutationFn: () => importEPrescription(code),
    onSuccess: (result) => {
      void message.success(
        result.created
          ? result.unmatched > 0
            ? `Đã lấy đơn về. Còn ${result.unmatched} thuốc cần chọn sản phẩm.`
            : "Đã lấy đơn về, mọi thuốc đã khớp sản phẩm."
          : "Mã này đã lấy về trước đó, mở lại đơn cũ.",
      );
      setCode("");
      onImported(result);
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không lấy được đơn thuốc điện tử"), 8),
  });
  return (
    <Modal
      title="Lấy đơn thuốc điện tử"
      open={open}
      onCancel={onClose}
      okText="Lấy đơn"
      cancelText="Hủy"
      okButtonProps={{ disabled: !valid, icon: <CloudDownloadOutlined /> }}
      confirmLoading={run.isPending}
      onOk={() => run.mutate()}
      destroyOnHidden
    >
      <Input
        autoFocus
        size="large"
        className="mono"
        maxLength={20}
        placeholder="Nhập hoặc quét mã đơn, ví dụ 01001ab12cd3-c"
        value={code}
        status={code && !valid ? "warning" : undefined}
        onChange={(event) => setCode(event.target.value)}
        onPressEnter={() => valid && run.mutate()}
      />
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12.5 }}>
        Mã 14 ký tự in trên đơn, đuôi -c (thường), -n (gây nghiện), -h (hướng thần) hoặc -y (y học
        cổ truyền).
      </Typography.Text>
    </Modal>
  );
}

/** Chọn sản phẩm cho một dòng đơn điện tử chưa khớp; phần mềm nhớ cho lần sau. */
export function MatchItem({
  prescriptionId,
  item,
  onMatched,
}: {
  prescriptionId: string;
  item: PrescriptionItem;
  onMatched: () => void;
}) {
  const { message } = App.useApp();
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 300);
  const [productId, setProductId] = useState<string>();
  const [unitId, setUnitId] = useState<string>();
  const products = useQuery({
    queryKey: ["erx-product-search", term],
    enabled: term.length >= 2,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: { search: term, page: 1, limit: 20 },
        })
      ).data.data.items,
  });
  const chosen = products.data?.find((product) => product.id === productId);
  const match = useMutation({
    mutationFn: () =>
      http.post(`/eprescriptions/prescriptions/${prescriptionId}/items/${item.id}/match`, {
        productId,
        unitId,
      }),
    onSuccess: () => {
      void message.success("Đã khớp. Lần sau thuốc này tự khớp.");
      onMatched();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không khớp được")),
  });
  return (
    <Space.Compact style={{ width: "100%", marginTop: 4 }}>
      <Select
        showSearch
        size="small"
        filterOption={false}
        style={{ flex: 1, minWidth: 0 }}
        placeholder="Tìm sản phẩm để khớp"
        value={productId}
        onSearch={setSearch}
        loading={products.isFetching}
        notFoundContent={term.length < 2 ? "Gõ ít nhất 2 ký tự" : "Không tìm thấy"}
        onChange={(value: string) => {
          setProductId(value);
          const product = products.data?.find((candidate) => candidate.id === value);
          const sameUnit = product?.saleUnits.find(
            (unit) =>
              item.nationalUnitName &&
              unit.name.toLowerCase() === item.nationalUnitName.toLowerCase(),
          );
          setUnitId(
            (
              sameUnit ??
              product?.saleUnits.find((unit) => unit.conversionToBase === 1) ??
              product?.saleUnits[0]
            )?.id,
          );
        }}
        options={products.data?.map((product) => ({
          value: product.id,
          label: `${product.code} · ${product.name}`,
        }))}
      />
      <Select
        size="small"
        style={{ width: 90 }}
        disabled={!chosen}
        value={unitId}
        onChange={setUnitId}
        options={chosen?.saleUnits.map((unit) => ({ value: unit.id, label: unit.name }))}
      />
      <Button
        size="small"
        type="primary"
        icon={<LinkOutlined />}
        disabled={!productId || !unitId}
        loading={match.isPending}
        onClick={() => match.mutate()}
      >
        Khớp
      </Button>
    </Space.Compact>
  );
}
