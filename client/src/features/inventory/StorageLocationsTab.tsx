import { PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Switch,
  Table,
  Tag,
} from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, StorageLocationItem } from "../../api/types.js";
import { thresholdText } from "./storage-thresholds.js";

const LOCATIONS_KEY = ["storage-locations"] as const;

type LocationForm = {
  name: string;
  minTempC?: number | null;
  maxTempC?: number | null;
  maxHumidityPercent?: number | null;
  isActive?: boolean;
};

/**
 * Khu vực bảo quản của cửa hàng (GPP: theo dõi nhiệt độ, độ ẩm từng khu).
 * Mọi người xem được; chủ nhà thuốc thêm, sửa ngưỡng, ngưng dùng khu.
 */
export function StorageLocationsTab({ canManage }: { canManage: boolean }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StorageLocationItem | "new" | null>(null);

  const locations = useQuery({
    queryKey: LOCATIONS_KEY,
    queryFn: async () =>
      (await http.get<Envelope<StorageLocationItem[]>>("/storage-locations")).data.data,
  });

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: LOCATIONS_KEY }),
      queryClient.invalidateQueries({ queryKey: ["storage-log-summary"] }),
    ]);
  }

  const createDefaults = useMutation({
    mutationFn: async () => http.post("/storage-locations/defaults"),
    onSuccess: async () => {
      void message.success("Đã tạo khu bán lẻ và tủ lạnh bảo quản thuốc");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không tạo được khu vực")),
  });

  const items = locations.data ?? [];

  if (!locations.isLoading && items.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          locations.isError
            ? getErrorMessage(locations.error, "Không tải được khu vực bảo quản")
            : canManage
              ? "Cửa hàng chưa có khu vực bảo quản nào"
              : "Cửa hàng chưa có khu vực bảo quản nào, nhờ chủ nhà thuốc tạo"
        }
      >
        {canManage && !locations.isError ? (
          <Button
            type="primary"
            loading={createDefaults.isPending}
            onClick={() => createDefaults.mutate()}
          >
            Tạo 2 khu mặc định (khu bán lẻ, tủ lạnh)
          </Button>
        ) : null}
      </Empty>
    );
  }

  return (
    <div className="detail-stack">
      {canManage ? (
        <div className="toolbar">
          <Button icon={<PlusOutlined />} onClick={() => setEditing("new")}>
            Thêm khu vực
          </Button>
        </div>
      ) : null}
      <Table
        rowKey="id"
        loading={locations.isLoading}
        dataSource={items}
        pagination={false}
        scroll={{ x: 560 }}
        columns={[
          { title: "Khu vực", dataIndex: "name" },
          {
            title: "Nhiệt độ cho phép",
            key: "temp",
            render: (_: unknown, row: StorageLocationItem) =>
              thresholdText(row.minTempC, row.maxTempC, "°C"),
          },
          {
            title: "Độ ẩm tối đa",
            key: "humidity",
            render: (_: unknown, row: StorageLocationItem) =>
              thresholdText(null, row.maxHumidityPercent, "%"),
          },
          {
            title: "Trạng thái",
            key: "status",
            width: 120,
            render: (_: unknown, row: StorageLocationItem) =>
              row.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngưng dùng</Tag>,
          },
          ...(canManage
            ? [
                {
                  title: "",
                  key: "actions",
                  width: 80,
                  render: (_: unknown, row: StorageLocationItem) => (
                    <Button size="small" onClick={() => setEditing(row)}>
                      Sửa
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      <LocationModal
        location={editing === "new" ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
    </div>
  );
}

function LocationModal({
  location,
  open,
  onClose,
  onSaved,
}: {
  location: StorageLocationItem | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<LocationForm>();
  const save = useMutation({
    mutationFn: async (values: LocationForm) => {
      const body = {
        name: values.name.trim(),
        minTempC: values.minTempC ?? null,
        maxTempC: values.maxTempC ?? null,
        maxHumidityPercent: values.maxHumidityPercent ?? null,
      };
      return location
        ? http.patch(`/storage-locations/${location.id}`, { ...body, isActive: values.isActive })
        : http.post("/storage-locations", body);
    },
    onSuccess: async () => {
      void message.success(location ? "Đã lưu khu vực" : "Đã thêm khu vực");
      await onSaved();
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được khu vực")),
  });

  return (
    <Modal
      open={open}
      title={location ? "Sửa khu vực bảo quản" : "Thêm khu vực bảo quản"}
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible)
          form.setFieldsValue({
            name: location?.name ?? "",
            minTempC: location?.minTempC ?? null,
            maxTempC: location?.maxTempC ?? null,
            maxHumidityPercent: location?.maxHumidityPercent ?? null,
            isActive: location?.isActive ?? true,
          });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="name"
          label="Tên khu vực"
          rules={[{ required: true, whitespace: true, message: "Nhập tên khu vực" }]}
        >
          <Input placeholder="Ví dụ: Tủ mát vắc-xin" maxLength={100} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="minTempC" label="Nhiệt độ thấp nhất">
              <InputNumber step={0.5} suffix="°C" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="maxTempC"
              label="Nhiệt độ cao nhất"
              dependencies={["minTempC"]}
              rules={[
                ({ getFieldValue }) => ({
                  validator: (_rule, value: number | null | undefined) => {
                    const min = getFieldValue("minTempC") as number | null | undefined;
                    return value == null || min == null || value > min
                      ? Promise.resolve()
                      : Promise.reject(new Error("Phải cao hơn nhiệt độ thấp nhất"));
                  },
                }),
              ]}
            >
              <InputNumber step={0.5} suffix="°C" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="maxHumidityPercent" label="Độ ẩm tối đa">
          <InputNumber min={1} max={100} step={1} suffix="%" style={{ width: "100%" }} />
        </Form.Item>
        {location ? (
          <Form.Item name="isActive" label="Đang dùng" valuePropName="checked">
            <Switch />
          </Form.Item>
        ) : null}
        <Alert
          type="info"
          showIcon
          title="Để trống ô nào thì không xét ngưỡng đó. Ngưỡng mới áp cho các lần đo ghi sau khi lưu."
        />
      </Form>
    </Modal>
  );
}
