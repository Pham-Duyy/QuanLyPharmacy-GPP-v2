// Kiểm thử đầu cuối (Phase 7, bước 7.1): đăng nhập từng tài khoản demo, mở mọi
// trang trên màn hình máy tính và điện thoại, ghi lỗi JavaScript, lỗi API
// (mã >= 500, hoặc 4xx không phải do thiếu quyền), trang tràn ngang trên điện thoại.
//
// Cần phần mềm đang chạy (giao diện ở BASE_URL) và dữ liệu demo (npm run db:demo).
// Chạy: cd e2e && npm install && npm run setup && npm test
// Thoát mã 1 khi có lỗi, ảnh chụp các trang lỗi nằm ở e2e/ket-qua/.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = (process.env.BASE_URL || "http://localhost:5173").replace(/\/$/, "");
const PASSWORD = process.env.E2E_PASSWORD || "Demo@12345";
// Tài khoản của db:demo: chủ nhà thuốc và dược sĩ bán hàng. Thêm tài khoản khác
// (cùng mật khẩu) bằng E2E_USERS, ví dụ E2E_USERS=demochu,demo,kho01.
const USERS = (process.env.E2E_USERS || "demochu,demo").split(",").map((u) => u.trim());
const PAGES = [
  "/",
  "/ban-hang",
  "/hoa-don",
  "/tra-hang",
  "/ca-thu-ngan",
  "/don-thuoc",
  "/khach-hang",
  "/san-pham",
  "/danh-muc",
  "/anh-san-pham",
  "/in-tem",
  "/nha-cung-cap",
  "/phieu-nhap",
  "/tra-hang-ncc",
  "/cong-no-ncc",
  "/de-xuat-dat-hang",
  "/ton-kho",
  "/can-han",
  "/kiem-ke",
  "/dieu-chinh-ton",
  "/chuyen-hang",
  "/kiem-soat-dac-biet",
  "/so-nhiet-do",
  "/khieu-nai",
  "/thu-hoi",
  "/bao-cao",
  "/tong-ket-thang",
  "/tro-ly-ai",
  "/phan-tich-ai",
  "/excel",
  "/nhan-vien",
  "/cua-hang",
  "/cai-dat",
  "/audit-log",
  "/hoa-don-dien-tu",
  "/lien-thong-duoc",
  "/tai-khoan",
];
const VIEWPORTS = [
  { tag: "may-tinh", width: 1440, height: 900 },
  { tag: "dien-thoai", width: 390, height: 844 },
];
const OUT = path.join(__dirname, "ket-qua");

async function login(page, username) {
  await page.goto(`${BASE_URL}/`);
  await page.locator("input").first().waitFor();
  await page.locator("input").first().fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page
    .waitForURL((url) => !url.pathname.includes("dang-nhap"), { timeout: 15000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  let visits = 0;

  for (const username of USERS) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      let issues = [];
      page.on("pageerror", (error) => issues.push(`Lỗi JavaScript: ${error.message}`));
      page.on("response", (response) => {
        const url = response.url();
        const status = response.status();
        // 401/403 là trang không có quyền: phần mềm đã chặn đúng, không tính là lỗi.
        if (
          url.includes("/api/") &&
          (status >= 500 || (status >= 400 && ![401, 403].includes(status)))
        ) {
          issues.push(
            `API ${status} ${response.request().method()} ${url.replace(/^.*\/api\/v1/, "")}`,
          );
        }
      });

      await login(page, username);
      if (page.url().includes("dang-nhap")) {
        failures.push(
          `${username}: đăng nhập không được (kiểm tra mật khẩu E2E_PASSWORD, đã chạy db:demo chưa)`,
        );
        await context.close();
        break;
      }

      for (const route of PAGES) {
        issues = [];
        visits++;
        try {
          await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(500);
          if (viewport.width < 500) {
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - window.innerWidth,
            );
            if (overflow > 2) issues.push(`Trang tràn ngang ${overflow}px trên điện thoại`);
          }
        } catch (error) {
          issues.push(`Không mở được trang: ${String(error.message).split("\n")[0]}`);
        }
        if (issues.length > 0) {
          const name = `${username}-${viewport.tag}${route.replace(/\//g, "_") || "_"}.png`;
          await page.screenshot({ path: path.join(OUT, name), fullPage: true }).catch(() => {});
          failures.push(`${username} · ${viewport.tag} · ${route}\n    ${issues.join("\n    ")}`);
        }
      }
      await context.close();
    }
  }
  await browser.close();

  if (failures.length > 0) {
    console.log(`Có ${failures.length} trang lỗi (ảnh chụp ở e2e/ket-qua/):\n`);
    console.log(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    `Đạt: ${visits} lượt mở trang, ${USERS.length} tài khoản, máy tính và điện thoại, không có lỗi.`,
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
