import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { createSignedImageUrl } from "../../lib/signed-url.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let pharmacistToken: string;
let adminToken: string;
let prescriptionId: string;

/** Đoạn JPEG hợp lệ tối thiểu, có kèm APP1 (EXIF) chứa dữ liệu giả để kiểm tra bị xóa. */
function segment(marker: number, data: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

function fakeJpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app1Exif = segment(0xe1, Buffer.from("Exif\0\0fake-gps-and-camera-data"));
  const sos = segment(0xda, Buffer.from([0x01]));
  const scanData = Buffer.from([0x11, 0x22, 0x33]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1Exif, sos, scanData, eoi]);
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  pharmacistToken = (await login("duocsi")).token;
  adminToken = (await login("admin")).token;

  const created = await api()
    .post("/api/v1/prescriptions")
    .set(authHeaders(pharmacistToken, fixture.storeId))
    .send({
      prescribedDate: new Date().toISOString().slice(0, 10),
      items: [{ drugNameText: "Amoxicillin 500mg", quantity: 10 }],
    })
    .expect(201);
  prescriptionId = created.body.data.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Tải ảnh đơn thuốc", () => {
  it("tải được ảnh JPEG hợp lệ, phiên bản tăng dần qua mỗi lần tải", async () => {
    const first = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", fakeJpegWithExif(), "don-thuoc.jpg")
      .expect(201);
    expect(first.body.data.versionNo).toBe(1);

    const second = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", fakeJpegWithExif(), "don-thuoc-2.jpg")
      .expect(201);
    expect(second.body.data.versionNo).toBe(2);

    const images = await prisma.prescriptionImage.findMany({ where: { prescriptionId } });
    expect(images).toHaveLength(2);
  });

  it("chặn tệp không phải JPEG, PNG hay PDF dù đặt tên đuôi .jpg", async () => {
    const response = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", Buffer.from("<html>không phải ảnh</html>"), "gia-mao.jpg")
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("chặn tệp vượt quá dung lượng cho phép", async () => {
    const tooBig = Buffer.alloc(9 * 1024 * 1024, 0);
    const response = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", tooBig, "qua-lon.jpg")
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("chặn người không có quyền prescription.create (admin không có quyền này)", async () => {
    const response = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(adminToken, fixture.storeId))
      .attach("file", fakeJpegWithExif(), "don-thuoc.jpg")
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("chặn khi chưa đăng nhập", async () => {
    const response = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .attach("file", fakeJpegWithExif(), "don-thuoc.jpg")
      .expect(401);

    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("không tìm thấy đơn thuốc thì trả 404", async () => {
    const response = await api()
      .post("/api/v1/prescriptions/00000000-0000-0000-0000-000000000000/images")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", fakeJpegWithExif(), "don-thuoc.jpg")
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("xóa EXIF trước khi lưu: ảnh đọc lại không còn dữ liệu vị trí/máy chụp gốc", async () => {
    const uploaded = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", fakeJpegWithExif(), "don-thuoc.jpg")
      .expect(201);

    const detail = await api()
      .get(`/api/v1/prescriptions/${prescriptionId}`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .expect(200);

    const image = detail.body.data.images.find(
      (item: { id: string }) => item.id === uploaded.body.data.id,
    );
    expect(image.url).toContain("/rx-images/");

    const url = new URL(`http://localhost${image.url}`);
    const streamed = await api()
      .get(url.pathname + url.search)
      .expect(200);

    expect(streamed.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.from(streamed.body).includes("fake-gps-and-camera-data")).toBe(false);
  });
});

describe("Xem ảnh qua URL có chữ ký", () => {
  async function uploadOne(): Promise<string> {
    const response = await api()
      .post(`/api/v1/prescriptions/${prescriptionId}/images`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .attach("file", fakeJpegWithExif(), "don-thuoc.jpg")
      .expect(201);
    return response.body.data.id as string;
  }

  it("chữ ký sai bị từ chối", async () => {
    const imageId = await uploadOne();
    const response = await api()
      .get(`/api/v1/rx-images/${imageId}`)
      .query({ expires: Math.floor(Date.now() / 1000) + 300, sig: "chu-ky-sai" })
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("URL đã hết hạn bị từ chối dù chữ ký đúng", async () => {
    const imageId = await uploadOne();
    const { expires, sig } = createSignedImageUrl(imageId, -10); // hết hạn 10 giây trước.

    const response = await api()
      .get(`/api/v1/rx-images/${imageId}`)
      .query({ expires, sig })
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("không cần đăng nhập vẫn xem được nếu chữ ký hợp lệ — vì <img> không gắn được token", async () => {
    const imageId = await uploadOne();
    const { expires, sig } = createSignedImageUrl(imageId);

    const response = await api()
      .get(`/api/v1/rx-images/${imageId}`)
      .query({ expires, sig })
      .expect(200);

    expect(response.headers["content-type"]).toBe("image/jpeg");
  });

  it("không thấy ảnh không tồn tại dù chữ ký hợp lệ cho id đó", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const { expires, sig } = createSignedImageUrl(fakeId);

    const response = await api()
      .get(`/api/v1/rx-images/${fakeId}`)
      .query({ expires, sig })
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
