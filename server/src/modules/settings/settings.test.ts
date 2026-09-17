import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;

const URL = "/api/v1/settings/invoice-print-template";

// PNG 1x1 hợp lệ.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;
  salesToken = (await login("banhang")).token;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function h(token = adminToken, storeId = fixture.storeId) {
  return authHeaders(token, storeId);
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    paperSize: "K58",
    logo: null,
    companyName: "Công ty TNHH Dược Kiểm Thử",
    storeName: "Nhà thuốc Minh An",
    address: "12 Lê Lợi, Q.1",
    phone: "0281234567",
    taxCode: "0312345678",
    title: "HÓA ĐƠN BÁN LẺ",
    footer: "Hẹn gặp lại!",
    display: {
      logo: true,
      customer: false,
      seller: true,
      unit: true,
      discount: true,
      paymentMethod: true,
      cashChange: false,
    },
    ...overrides,
  };
}

describe("Mẫu in hóa đơn", () => {
  it("chưa cài đặt thì trả mẫu mặc định lấy từ thông tin cửa hàng", async () => {
    const response = await api().get(URL).set(h()).expect(200);

    expect(response.body.data.isDefault).toBe(true);
    expect(response.body.data.template).toMatchObject({
      paperSize: "K80",
      storeName: "Nhà thuốc kiểm thử 1",
      title: "HÓA ĐƠN BÁN HÀNG",
      logo: null,
    });
  });

  it("lưu xong đọc lại vẫn giữ nguyên và có ghi nhật ký", async () => {
    await api().put(URL).set(h()).send(template()).expect(200);

    const response = await api().get(URL).set(h()).expect(200);
    expect(response.body.data.isDefault).toBe(false);
    expect(response.body.data.template).toEqual(template());

    const audit = await prisma.auditLog.findFirst({ where: { action: "SETTING_UPDATE" } });
    expect(audit?.storeId).toBe(fixture.storeId);

    // Lưu lần hai cập nhật đúng bản ghi cũ, không sinh bản ghi trùng.
    await api().put(URL).set(h()).send(template({ title: "PHIẾU THANH TOÁN" })).expect(200);
    expect(await prisma.setting.count({ where: { key: "invoicePrintTemplate" } })).toBe(1);
  });

  it("mẫu in tách riêng theo từng cửa hàng", async () => {
    await api().put(URL).set(h()).send(template()).expect(200);

    const other = await api().get(URL).set(h(adminToken, fixture.otherStoreId)).expect(200);
    expect(other.body.data.isDefault).toBe(true);
    expect(other.body.data.template.storeName).toBe("Nhà thuốc kiểm thử 2");
  });

  it("chỉ quyền settings.manage được sửa; nhân viên vẫn đọc được để in", async () => {
    await api().put(URL).set(h(pharmacistToken)).send(template()).expect(403);
    await api().put(URL).set(h(salesToken)).send(template()).expect(403);
    await api().get(URL).set(h(salesToken)).expect(200);
  });

  it("dược sĩ không làm việc tại cửa hàng khác thì không đọc được mẫu của cửa hàng đó", async () => {
    await api().get(URL).set(h(pharmacistToken, fixture.otherStoreId)).expect(403);
  });

  it("bắt buộc có tên nhà thuốc và khổ giấy hợp lệ", async () => {
    const response = await api()
      .put(URL)
      .set(h())
      .send(template({ storeName: "  ", paperSize: "A4" }))
      .expect(422);

    const fields = response.body.error.details.map((item: { field: string }) => item.field);
    expect(fields).toEqual(expect.arrayContaining(["storeName", "paperSize"]));
  });

  it("nhận logo PNG thật, từ chối SVG và tệp giả dạng ảnh", async () => {
    await api()
      .put(URL)
      .set(h())
      .send(template({ logo: `data:image/png;base64,${PNG_1PX}` }))
      .expect(200);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await api()
      .put(URL)
      .set(h())
      .send(template({ logo: `data:image/svg+xml;base64,${svg.toString("base64")}` }))
      .expect(422);

    const fake = Buffer.from("<script>alert(1)</script>").toString("base64");
    const response = await api()
      .put(URL)
      .set(h())
      .send(template({ logo: `data:image/png;base64,${fake}` }))
      .expect(422);
    expect(response.body.error.details[0].field).toBe("logo");
  });

  it("xem trước dựng HTML từ mẫu chưa lưu, thoát ký tự đặc biệt và không tạo hóa đơn", async () => {
    const response = await api()
      .post(`${URL}/preview`)
      .set(h())
      .send({
        template: template({ storeName: '<img src=x onerror="alert(1)">', paperSize: "A5" }),
        sample: "long",
      })
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("size: A5");
    expect(response.text).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(response.text).not.toContain("<img src=x");
    expect(response.text).not.toContain("window.print()");
    expect(response.text).toContain("Amoxicillin");
    // Đã tắt hiển thị khách hàng thì không có dòng khách hàng.
    expect(response.text).not.toContain("Khách hàng:");
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("dòng thông tin bị để trống không in ra", async () => {
    const response = await api()
      .post(`${URL}/preview`)
      .set(h())
      .send({ template: template({ companyName: "", taxCode: "", phone: "" }), sample: "walk_in" })
      .expect(200);

    expect(response.text).not.toContain("MST:");
    expect(response.text).not.toContain("ĐT:");
    expect(response.text).not.toContain('class="company"');
  });
});
