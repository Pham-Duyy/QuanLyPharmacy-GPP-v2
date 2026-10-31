# Cài đặt và vận hành bằng Docker

Hướng dẫn cài phần mềm lên máy tính của nhà thuốc (Windows 10/11), chạy cả bộ bằng một lệnh. Lập trình viên muốn chạy từng phần để sửa mã: xem [README](../README.md).

Bộ phần mềm gồm 4 thành phần, Docker tự chạy và tự khởi động lại khi bật máy:

| Thành phần | Việc | Ra ngoài máy |
|---|---|---|
| `web` | Giao diện (nginx), chuyển `/api` vào máy chủ | Cổng 8080 |
| `server` | Máy chủ Node: nghiệp vụ, đăng nhập, sao lưu | Không |
| `analytics` | Phân tích số liệu (Python), đọc CSDL bằng tài khoản chỉ đọc | Không |
| `db` | PostgreSQL 17 | Chỉ chính máy này, cổng 5432 |

## 1. Chuẩn bị (làm một lần)

1. **Bật ảo hóa và WSL 2.** Mở PowerShell bằng quyền Administrator:

   ```
   wsl --install
   ```

   Khởi động lại máy khi được hỏi.
2. **Cài Docker Desktop** từ trang docker.com (bản cho Windows). Mở Docker Desktop, đợi biểu tượng cá voi báo "Engine running". Trong Settings → General, bật **Start Docker Desktop when you sign in** để bật máy là phần mềm chạy.
3. **Cài Git** từ git-scm.com (để mặc định khi cài).
4. Máy nên có từ 8 GB RAM và 10 GB ổ trống.

## 2. Cài phần mềm

Mở PowerShell (không cần quyền Administrator):

```
cd D:\
git clone https://github.com/Pham-Duyy/QuanLyPharmacy-GPP-v2.git
cd QuanLyPharmacy-GPP-v2
```

Tùy chọn: chép tệp thiết lập mẫu rồi sửa (thư mục sao lưu, cổng, email, khóa AI). Bỏ qua bước này vẫn chạy được.

```
copy docker.env.example .env
notepad .env
```

Nên đặt ít nhất `BACKUP_HOST_DIR` sang ổ khác ổ cài phần mềm, ví dụ `BACKUP_HOST_DIR=E:/sao-luu-nha-thuoc` (dùng dấu `/`).

Chạy:

```
docker compose up -d --build
```

Lần đầu mất 5–15 phút để tải và đóng gói. Xem trạng thái:

```
docker compose ps
```

Cột STATUS của `db`, `server`, `analytics` là `healthy` (`web` là `Up`) thì đã xong.

## 3. Dùng lần đầu

1. Mở trình duyệt: **http://localhost:8080**
2. Đăng nhập `admin` / `Admin@12345`, phần mềm bắt đổi mật khẩu ngay.
3. Làm theo [Hướng dẫn sử dụng](huong-dan-su-dung.md): sửa thông tin cửa hàng, tạo tài khoản nhân viên, thêm vai trò Dược sĩ cho mình nếu đứng quầy, bật xác thực hai lớp.

Lần đầu khởi động, phần mềm tự:

- tạo cửa hàng mẫu, quyền, tài khoản `admin` và một ít danh mục thuốc mẫu;
- sinh khóa bí mật đăng nhập và mật khẩu tài khoản chỉ đọc cho phân tích, cất trong volume `secrets` của Docker (không cần tự đặt);
- áp mọi migration CSDL. Các lần khởi động sau chỉ áp migration mới nếu có.

## 4. Máy khác trong nhà thuốc

Máy quầy, máy tính bảng cùng mạng Wi-Fi/LAN mở được phần mềm qua địa chỉ IP của máy cài:

1. Trên máy cài, xem IP: `ipconfig` → dòng **IPv4 Address**, ví dụ `192.168.1.20`.
2. Máy khác mở `http://192.168.1.20:8080`.
3. Không vào được: cho phép cổng 8080 qua tường lửa. PowerShell quyền Administrator:

   ```
   New-NetFirewallRule -DisplayName "Pharmacy GPP" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
   ```

Nên đặt IP tĩnh cho máy cài (trong cài đặt modem) để địa chỉ không đổi.

Camera quét mã trực tiếp chỉ chạy trên `https` hoặc `localhost`. Máy khác mở bằng `http://192.168…` thì dùng máy quét mã vạch cầm tay (cắm USB, chạy như bàn phím), hoặc bấm nút camera rồi **Chụp ảnh mã**: điện thoại, máy tính bảng mở ứng dụng camera để chụp, phần mềm đọc mã từ ảnh.

Bấm nút camera mà báo bị chặn: hộp thoại tự nói nguyên nhân và cách sửa.

| Báo | Sửa ở đâu |
|---|---|
| Trang này đang bị chặn dùng camera | Trong trình duyệt: bấm biểu tượng bên trái địa chỉ trang → Quyền cho trang web → Camera → Cho phép. Cho phép xong, camera tự mở |
| Máy tính đang chặn trình duyệt dùng camera | Cài đặt Windows (Windows + I) → Quyền riêng tư và bảo mật → Camera: bật Truy cập camera và Cho phép ứng dụng máy tính truy cập camera; đóng hẳn trình duyệt rồi mở lại |
| Camera đang được ứng dụng khác dùng | Đóng Zalo, Zoom, Teams… đang mở camera rồi bấm Thử lại |

## 5. Vận hành hằng ngày

| Việc | Lệnh (trong thư mục phần mềm) |
|---|---|
| Xem trạng thái | `docker compose ps` |
| Xem log máy chủ khi có lỗi | `docker compose logs --tail 100 server` |
| Tắt phần mềm (giữ dữ liệu) | `docker compose stop` |
| Bật lại | `docker compose start` |
| Khởi động lại một phần | `docker compose restart server` |

Docker Desktop đã bật "Start when you sign in" thì bật máy là phần mềm tự chạy, không cần lệnh nào.

## 6. Sao lưu và phục hồi

Phần mềm tự sao lưu mỗi ngày lúc 23:00 vào thư mục `BACKUP_HOST_DIR` (mặc định thư mục `backups` trong thư mục phần mềm), giữ 14 bản. Máy phải bật lúc đó, hoặc bật lại trong ngày để sao lưu bù. Xem và tải ở **Cài đặt → Công cụ → Sao lưu dữ liệu**. Mỗi tuần chép thư mục này ra ổ cứng rời.

Phục hồi (ghi đè toàn bộ dữ liệu, mọi người phải đăng nhập lại):

```
docker compose stop web
docker compose exec server npm run db:restore -- sao-luu-20261031-230000-tu-dong.ndjson.gz
docker compose start web
```

Lệnh hiện thông tin bản sao lưu, bắt gõ `PHUC HOI`, tự lưu dữ liệu hiện tại thành bản "trước phục hồi" rồi mới ghi đè. Tệp sao lưu phải nằm trong thư mục sao lưu (chép vào đó nếu lấy từ ổ cứng rời). Dừng `web` để không ai thao tác trong lúc phục hồi.

**Chuyển sang máy mới:** cài như mục 2 trên máy mới, chép tệp sao lưu vào thư mục sao lưu của máy mới, rồi phục hồi như trên.

## 7. Cập nhật phiên bản mới

```
docker compose exec server npm run db:backup
git pull
docker compose up -d --build
```

Dòng đầu sao lưu trước cho chắc. Migration mới tự áp khi máy chủ khởi động lại.

## 8. Lưu ý bảo mật

- **Không xóa volume** bằng `docker compose down -v`: lệnh này xóa toàn bộ CSDL, ảnh và khóa bí mật. Muốn tắt hẳn chỉ dùng `docker compose down`.
- CSDL chỉ mở cho chính máy cài, không mở ra mạng. Muốn đổi mật khẩu CSDL thì đặt `POSTGRES_PASSWORD` trong `.env` **trước lần chạy đầu tiên**.
- Mất volume `secrets` (khóa bí mật) thì mọi người phải đăng nhập lại, và xác thực hai lớp của mọi người phải đặt lại. Volume này nằm trong Docker, sao lưu không chứa nó.
- Mở phần mềm ra Internet (ngoài mạng nhà thuốc) cần https và tên miền; nhờ người có chuyên môn cấu hình, rồi đặt `COOKIE_SECURE=true`.

## 9. Gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| `docker` không nhận lệnh | Docker Desktop chưa chạy: mở Docker Desktop, đợi "Engine running" |
| `port is already allocated` ở cổng 8080 | Cổng đang bị phần mềm khác dùng: đặt `WEB_PORT=8090` trong `.env`, chạy lại `docker compose up -d`, mở `http://localhost:8090` |
| `port is already allocated` ở cổng 5432 | Máy đã cài PostgreSQL riêng: đặt `DB_PORT=5433` trong `.env` |
| `server` không lên `healthy` | `docker compose logs --tail 100 server` xem dòng lỗi cuối |
| Cứ vài phút lại bị đăng xuất khi mở từ máy khác | Kiểm tra `COOKIE_SECURE=false` trong `.env` khi dùng `http` |
| Trợ lý AI / Bảng điều hành báo chưa có dữ liệu | CSDL mới chưa có hóa đơn bán: bán vài hóa đơn, đợi vài phút |
