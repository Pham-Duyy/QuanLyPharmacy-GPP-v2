import {
  CopyOutlined,
  DownloadOutlined,
  LogoutOutlined,
  PlusOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  QRCode,
  Skeleton,
  Space,
  Typography,
} from "antd";
import type { InputProps } from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "./auth-context.js";
import { groupSecret, mfaApi, recoveryCodesText, type MfaStatus } from "./mfa-api.js";

/** Ô nhập mã 6 số: bàn phím số trên điện thoại, trình duyệt tự điền mã từ tin nhắn nếu có. */
function CodeInput({ allowRecovery, ...rest }: InputProps & { allowRecovery?: boolean }) {
  // `rest` gồm value/onChange do Form.Item truyền vào: phải chuyển tiếp cho Input.
  return (
    <Input
      {...rest}
      inputMode={allowRecovery ? "text" : "numeric"}
      autoComplete="one-time-code"
      maxLength={allowRecovery ? 20 : 6}
      placeholder={allowRecovery ? "123456 hoặc mã dự phòng" : "123456"}
      className="mfa-code-input"
    />
  );
}

function saveText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hiện 10 mã dự phòng đúng một lần; bắt xác nhận đã lưu mới cho đóng. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { me } = useAuth();
  const { message } = App.useApp();
  const [saved, setSaved] = useState(false);
  const text = recoveryCodesText(me?.user.username ?? "", codes);
  return (
    <div className="mfa-step">
      <Alert
        type="warning"
        showIcon
        title="Lưu 10 mã dự phòng này ngay"
        description="Mất điện thoại thì đăng nhập bằng một mã dự phòng thay cho mã 6 số. Mỗi mã dùng một lần. Phần mềm chỉ hiện các mã này lúc này."
      />
      <ol className="mfa-recovery-list">
        {codes.map((code) => (
          <li key={code} className="mono">
            {code}
          </li>
        ))}
      </ol>
      <Space wrap>
        <Button
          icon={<CopyOutlined />}
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => message.success("Đã chép mã dự phòng"))
              .catch(() => message.error("Không chép được, hãy tải tệp"))
          }
        >
          Chép
        </Button>
        <Button
          icon={<DownloadOutlined />}
          onClick={() => saveText(`ma-du-phong-${me?.user.username ?? "gpp"}.txt`, text)}
        >
          Tải tệp
        </Button>
      </Space>
      <Checkbox checked={saved} onChange={(event) => setSaved(event.target.checked)}>
        Tôi đã lưu các mã dự phòng ở nơi an toàn
      </Checkbox>
      <Button type="primary" block disabled={!saved} onClick={onDone}>
        Xong
      </Button>
    </div>
  );
}

/**
 * Bật xác thực hai lớp: quét mã QR bằng Google Authenticator / Microsoft
 * Authenticator, nhập mã 6 số để xác nhận, rồi lưu mã dự phòng.
 */
export function MfaSetupFlow({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await mfaApi.setup());
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(values: { code: string }) {
    setBusy(true);
    setError(null);
    try {
      setCodes(await mfaApi.enable(values.code.trim()));
    } catch (caught) {
      setError(getErrorMessage(caught, "Mã không đúng"));
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;

  if (!setup) {
    return (
      <div className="mfa-step">
        <p>
          Mỗi lần đăng nhập, ngoài mật khẩu bạn nhập thêm mã 6 số đổi mỗi 30 giây trên điện thoại.
          Lộ mật khẩu thì người khác vẫn không vào được.
        </p>
        <ol className="mfa-instructions">
          <li>
            Cài ứng dụng <strong>Google Authenticator</strong> hoặc{" "}
            <strong>Microsoft Authenticator</strong> trên điện thoại (miễn phí).
          </li>
          <li>Bấm Bắt đầu, quét mã QR hiện ra bằng ứng dụng đó.</li>
          <li>Nhập mã 6 số ứng dụng hiện ra, rồi lưu 10 mã dự phòng.</li>
        </ol>
        {error && <Alert type="error" showIcon title={error} />}
        <Button type="primary" block loading={busy} onClick={() => void start()}>
          Bắt đầu
        </Button>
      </div>
    );
  }

  return (
    <div className="mfa-step">
      <div className="mfa-qr">
        <QRCode value={setup.otpauthUrl} size={184} bordered={false} />
      </div>
      <Typography.Paragraph type="secondary" className="mfa-secret">
        Không quét được? Trong ứng dụng chọn nhập khóa thủ công, gõ:{" "}
        <Typography.Text code copyable={{ text: setup.secret }}>
          {groupSecret(setup.secret)}
        </Typography.Text>
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon title={error} />}
      <Form
        layout="vertical"
        onFinish={(values: { code: string }) => void confirm(values)}
        disabled={busy}
      >
        <Form.Item
          name="code"
          label="Mã 6 số trong ứng dụng"
          rules={[{ required: true, pattern: /^\s*\d{6}\s*$/, message: "Nhập đủ 6 số" }]}
        >
          <CodeInput autoFocus />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>
          Bật xác thực hai lớp
        </Button>
      </Form>
    </div>
  );
}

/** Mục "Xác thực hai lớp" trong menu tài khoản. */
export function MfaModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="Xác thực hai lớp"
      destroyOnHidden
      width={460}
    >
      {/* Nội dung dựng lại mỗi lần mở: trạng thái luôn bắt đầu từ đầu. */}
      {open ? <MfaModalBody /> : null}
    </Modal>
  );
}

function MfaModalBody() {
  const { reloadMe } = useAuth();
  const { message } = App.useApp();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [mode, setMode] = useState<"view" | "disable" | "regenerate">("view");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setStatus(await mfaApi.status());
  }

  useEffect(() => {
    mfaApi
      .status()
      .then(setStatus)
      .catch((caught: unknown) => setError(getErrorMessage(caught)));
  }, []);

  async function finish() {
    await reloadMe();
    await load();
    setCodes(null);
    setMode("view");
  }

  async function submitDisable(values: { password: string; code: string }) {
    setBusy(true);
    setError(null);
    try {
      await mfaApi.disable(values.password, values.code.trim());
      message.success("Đã tắt xác thực hai lớp");
      await finish();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegenerate(values: { code: string }) {
    setBusy(true);
    setError(null);
    try {
      setCodes(await mfaApi.regenerate(values.code.trim()));
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (!status) body = error ? <Alert type="error" title={error} /> : <Skeleton active />;
  else if (codes) body = <RecoveryCodes codes={codes} onDone={() => void finish()} />;
  else if (!status.enabled) body = <MfaSetupFlow onDone={() => void finish()} />;
  else if (mode === "disable")
    body = (
      <Form
        layout="vertical"
        onFinish={(v: { password: string; code: string }) => void submitDisable(v)}
      >
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
        <Form.Item
          name="password"
          label="Mật khẩu"
          rules={[{ required: true, message: "Nhập mật khẩu" }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="code"
          label="Mã 6 số hoặc mã dự phòng"
          rules={[{ required: true, message: "Nhập mã" }]}
        >
          <CodeInput allowRecovery />
        </Form.Item>
        <Space>
          <Button danger type="primary" htmlType="submit" loading={busy}>
            Tắt xác thực hai lớp
          </Button>
          <Button onClick={() => setMode("view")}>Quay lại</Button>
        </Space>
      </Form>
    );
  else if (mode === "regenerate")
    body = (
      <Form layout="vertical" onFinish={(v: { code: string }) => void submitRegenerate(v)}>
        <p>Các mã dự phòng cũ sẽ hết hiệu lực.</p>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
        <Form.Item
          name="code"
          label="Mã 6 số trong ứng dụng"
          rules={[{ required: true, message: "Nhập mã" }]}
        >
          <CodeInput allowRecovery autoFocus />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>
            Tạo mã mới
          </Button>
          <Button onClick={() => setMode("view")}>Quay lại</Button>
        </Space>
      </Form>
    );
  else
    body = (
      <div className="mfa-step">
        <Alert
          type="success"
          showIcon
          icon={<SafetyOutlined />}
          title="Xác thực hai lớp đang bật"
          description={`Còn ${status.recoveryCodesLeft} mã dự phòng chưa dùng.`}
        />
        {status.recoveryCodesLeft <= 3 && (
          <Alert type="warning" showIcon title="Sắp hết mã dự phòng, hãy tạo mã mới" />
        )}
        <Space wrap>
          <Button onClick={() => setMode("regenerate")}>Tạo lại mã dự phòng</Button>
          {status.required ? (
            <Typography.Text type="secondary">
              Chủ nhà thuốc đang bắt buộc xác thực hai lớp với Quản lý.
            </Typography.Text>
          ) : (
            <Button danger onClick={() => setMode("disable")}>
              Tắt
            </Button>
          )}
        </Space>
      </div>
    );

  return body;
}

/**
 * Hiện thay cho cả phần mềm khi chủ nhà thuốc bắt buộc MFA với Quản lý mà tài
 * khoản này chưa bật: máy chủ chặn mọi thao tác khác tới khi bật xong.
 */
export function MfaGate() {
  const { me, logout, reloadMe } = useAuth();
  return (
    <main className="login-main password-gate">
      <div className="login-card">
        <div className="login-card-brand">
          <span className="brand-mark" aria-hidden>
            <PlusOutlined />
          </span>
          <span className="brand-name">Pharmacy GPP</span>
        </div>
        <h1>Bật xác thực hai lớp</h1>
        <p className="login-subtitle">
          {me ? `Chào ${me.user.fullName}. ` : null}Chủ nhà thuốc yêu cầu tài khoản Quản lý bật xác
          thực hai lớp trước khi làm việc.
        </p>
        <MfaSetupFlow onDone={() => void reloadMe()} />
        <Button
          type="link"
          block
          icon={<LogoutOutlined />}
          className="password-gate-logout"
          onClick={() => void logout()}
        >
          Đăng xuất
        </Button>
      </div>
    </main>
  );
}
