# Hướng dẫn sử dụng

Tài liệu cho người dùng phần mềm hằng ngày: chủ nhà thuốc, dược sĩ, nhân viên kho. Cách cài đặt và chạy phần mềm xem [README](../README.md).

## 1. Đăng nhập lần đầu

1. Mở phần mềm trên trình duyệt (khi chạy trên máy: `http://localhost:5173`).
2. Nhập tên đăng nhập và mật khẩu tạm do quản lý đưa.
3. Phần mềm bắt đổi mật khẩu ngay. Chưa đổi thì không dùng được chức năng nào khác.
4. Nếu làm ở nhiều cửa hàng, chọn cửa hàng đang làm việc ở ô trên cùng màn hình. Mọi thao tác kho và bán hàng đều tính cho cửa hàng đang chọn.

Tài khoản quản trị đầu tiên sau khi cài là `admin` / `Admin@12345`.

## 2. Bốn vai trò

Theo GPP, việc bán thuốc và việc quản lý được tách riêng. Mỗi người có một hoặc nhiều vai trò, gán theo từng cửa hàng hoặc cho cả chuỗi.

| Vai trò | Làm được | Không làm được |
|---|---|---|
| **Chủ nhà thuốc, quản lý** | Nhân viên, cửa hàng, cài đặt; danh mục, giá bán; kiểm nhập và xác nhận phiếu nhập; duyệt điều chỉnh tồn; hủy hóa đơn; công nợ nhà cung cấp; báo cáo cả chuỗi, giá vốn, lợi nhuận; Trợ lý AI; nhật ký hệ thống | **Bán thuốc**, đơn thuốc, ghi sổ nhiệt độ, xem hồ sơ sức khỏe khách — cần thêm vai trò Dược sĩ (mục 3) |
| **Dược sĩ** | Quầy bán, đơn thuốc, trả hàng, ca thu ngân, khách hàng và hồ sơ sức khỏe, sổ nhiệt độ – độ ẩm, lập phiếu nhập, đề nghị điều chỉnh tồn, khiếu nại | Xác nhận phiếu nhập, duyệt điều chỉnh, giá vốn và lợi nhuận, quản lý nhân viên |
| **Nhân viên kho** | Xem tồn, lập phiếu nhập, đề nghị điều chỉnh tồn, chuyển hàng giữa cửa hàng, sổ nhiệt độ | Bán hàng, xác nhận phiếu nhập, báo cáo doanh thu |
| **Kiểm toán** | Xem hóa đơn, tồn kho, giá vốn, báo cáo, nhật ký hệ thống | Mọi thao tác ghi |

Một người có thể giữ nhiều vai trò cùng lúc, ví dụ vừa Quản lý vừa Dược sĩ tại cùng một cửa hàng. Quyền là tổng quyền của các vai trò.

## 3. Chủ nhà thuốc kiêm dược sĩ đứng quầy

Nhà thuốc nhỏ thường chỉ có chủ là dược sĩ, vừa quản lý vừa bán hàng. Vai trò Quản lý **không tự có quyền bán**, vì GPP yêu cầu người bán thuốc phải có chuyên môn dược. Chủ có chứng chỉ hành nghề dược thì thêm vai trò Dược sĩ cho chính mình:

1. Bấm **Quầy bán** trên thanh bên trái. Chưa có vai trò Dược sĩ thì trang hiện lời giải thích.
2. Bấm **Thêm vai trò Dược sĩ cho tôi**.
3. Nhập **số chứng chỉ hành nghề dược** và **bằng cấp chuyên môn** (ví dụ "Dược sĩ đại học, ĐH Dược Hà Nội, 2015").
4. Nếu bạn là người phụ trách chuyên môn của nhà thuốc, đánh dấu ô tương ứng. Mỗi cửa hàng chỉ có một người phụ trách chuyên môn.
5. Bấm **Thêm vai trò**. Quầy bán mở ra ngay, không cần đăng nhập lại.

Lưu ý:

- Vai trò Quản lý vẫn giữ nguyên.
- Thao tác này chỉ **thêm** vai trò Dược sĩ, áp dụng cho cửa hàng đang chọn. Làm ở nhiều cửa hàng thì đổi cửa hàng rồi làm lại.
- Thao tác được ghi vào **Nhật ký hệ thống** ("Tự thêm vai trò Dược sĩ"), kèm số chứng chỉ đã khai.
- Muốn gỡ vai trò Dược sĩ của mình, nhờ một quản lý khác làm ở trang Nhân viên. Không ai tự gỡ hay tự đổi vai trò của chính mình được, để tránh lỡ tay khóa quyền quản lý.
- Thuê thêm dược sĩ thì tạo tài khoản riêng cho họ ở **Quản trị → Nhân viên**, gán vai trò Dược sĩ, không dùng chung tài khoản chủ.

## 4. Công việc ở quầy (Dược sĩ)

**Đầu ca:** **Giao dịch bán → Ca thu ngân**, mở ca và nhập số tiền đang có trong két.

**Bán hàng** (**Quầy bán**):

1. Quét mã vạch hoặc gõ tên thuốc để thêm vào giỏ. Phần mềm tự chọn lô hết hạn trước (FEFO).
2. Thuốc kê đơn: quét hoặc nhập mã đơn thuốc điện tử, hoặc chọn đơn đã duyệt.
3. Chọn khách (gõ số điện thoại) nếu khách tích điểm.
4. Phần mềm kiểm tra an toàn: trùng hoạt chất, dị ứng, thuốc kiểm soát đặc biệt. Cảnh báo cần ghi nhận thì phải đọc và xác nhận mới thanh toán được.
5. Nhập tiền khách đưa, thanh toán, in hóa đơn.

**Trả hàng:** **Giao dịch bán → Khách trả hàng**, tìm hóa đơn, chọn dòng trả và lý do. Chỉ trả tại cửa hàng đã bán.

**Cuối ca:** **Ca thu ngân**, đếm tiền thực tế và chốt ca. Lệch so với sổ thì phải ghi lý do.

**Sổ nhiệt độ – độ ẩm:** **Hồ sơ GPP → Nhiệt độ – độ ẩm**, ghi mỗi lần đo. Vượt ngưỡng thì phần mềm đánh dấu để xử lý.

## 5. Nhập hàng

1. **Mua hàng → Đề xuất đặt hàng** xem mặt hàng sắp hết, theo tồn tối thiểu và theo dự báo bán.
2. Hàng về: **Mua hàng → Phiếu nhập → Lập phiếu nhập**. Chọn nhà cung cấp, nhập từng dòng: thuốc, đơn vị, số lượng, giá nhập, số lô, hạn dùng.
3. **Quản lý** mở phiếu, kiểm nhập từng dòng (đạt / không đạt kèm lý do), rồi xác nhận. Lúc đó hàng mới vào kho.

Phần mềm chặn các lỗi nhập hay gặp:

- hạn dùng đã qua hoặc xa quá 10 năm (gõ nhầm năm);
- ngày sản xuất hoặc ngày nhận hàng ở tương lai;
- một lô nhập hai dòng;
- nhà cung cấp trùng mã số thuế hoặc trùng tên với nhà cung cấp đã có.

## 6. Kho

- **Hàng hóa → Tồn kho**: tồn theo lô, vị trí kệ.
- **Hàng hóa → Hàng cận hạn**: lô sắp hết hạn; lập kế hoạch xử lý (ưu tiên bán, giảm giá, trả nhà cung cấp, hủy) kèm hạn xử lý.
- **Hàng hóa → Kiểm kê**: mở đợt kiểm kê, nhập số đếm được, chốt đợt. Phần mềm tự sinh phiếu điều chỉnh cho dòng lệch.
- **Hàng hóa → Điều chỉnh tồn**: nhân viên đề nghị, quản lý duyệt. Người lập không tự duyệt phiếu của mình.
- **Hàng hóa → Chuyển hàng**: lập phiếu, cửa hàng gửi xác nhận xuất, cửa hàng nhận kiểm và nhận về.

## 7. Báo cáo và Trợ lý AI

- **Tổng quan**: doanh thu, số hóa đơn, cảnh báo của cửa hàng đang chọn.
- **Báo cáo → Báo cáo kinh doanh**: doanh thu, lợi nhuận (chỉ quản lý và kiểm toán xem được giá vốn), tồn kho; xuất Excel.
- **Trợ lý AI**: hỏi bằng tiếng Việt về số liệu, ví dụ "Tuần này doanh thu cửa hàng nào giảm?". Có thể đính kèm tệp Excel/CSV. Chủ nhà thuốc đặt ngân sách AI mỗi tháng ở **Quản trị → Phân tích & AI**.

## 8. Quản trị (Chủ nhà thuốc)

- **Nhân viên**: tạo tài khoản, gán vai trò theo cửa hàng, đặt lại mật khẩu, khóa tài khoản người nghỉ việc. Gán vai trò Dược sĩ cần ghi căn cứ bằng cấp.
- **Cửa hàng**: thông tin, số chứng nhận GPP; mở cửa hàng mới.
- **Cài đặt**: mẫu in hóa đơn và phiếu, tích điểm, hóa đơn điện tử, liên thông Dược quốc gia.
- **Nhật ký hệ thống**: ai làm gì, lúc nào.
- **Sao lưu dữ liệu** (**Cài đặt → Công cụ → Sao lưu dữ liệu**, chỉ quản lý toàn chuỗi): phần mềm tự sao lưu mỗi ngày lúc 23:00, giữ 14 bản. Trang này cho xem các bản, bấm **Sao lưu ngay**, **Tải về**. Hơn 2 ngày chưa có bản mới thì trang báo vàng. Nên chép bản sao lưu ra ổ cứng rời mỗi tuần.
- **Nhập / xuất Excel**: nhập danh mục, nhà cung cấp, khách hàng, tồn đầu kỳ từ tệp mẫu.

## 9. Phục hồi dữ liệu khi có sự cố

Phục hồi thay **toàn bộ** dữ liệu hiện tại bằng dữ liệu lúc sao lưu: mọi hóa đơn, phiếu nhập sau thời điểm đó sẽ mất. Chỉ làm khi máy hỏng, cài lại máy mới, hoặc dữ liệu bị xóa nhầm nặng.

1. Dừng máy chủ (đóng cửa sổ đang chạy `npm run dev` trong thư mục `server`).
2. Mở PowerShell trong thư mục `server`, chạy (thay tên tệp bằng bản muốn dùng, xem ở trang Sao lưu dữ liệu):

   ```
   npm run db:restore -- sao-luu-20261031-230000-tu-dong.ndjson.gz
   ```

   Tệp nằm ngoài thư mục sao lưu (ví dụ chép từ ổ cứng rời) thì ghi đường dẫn đầy đủ: `npm run db:restore -- "E:\sao-luu\sao-luu-....ndjson.gz"`.
3. Đọc thông tin bản sao lưu hiện ra, gõ `PHUC HOI` rồi Enter.
4. Chạy lại máy chủ. Mọi người đăng nhập lại.

Trước khi ghi đè, lệnh tự lưu dữ liệu hiện tại thành một bản "Trước phục hồi", nên lỡ chọn nhầm bản vẫn quay lại được. Tệp hỏng hoặc không đúng phiên bản thì lệnh báo lỗi và không thay đổi gì.

## 10. Câu hỏi hay gặp

**Tôi là chủ nhà thuốc, sao không thấy nút bán hàng?** Xem mục 3.

**Lập phiếu nhập báo "Hạn dùng xa quá 10 năm"?** Kiểm tra lại năm trên bao bì, thường là gõ nhầm (2207 thay vì 2027).

**Thêm nhà cung cấp báo "Đã có nhà cung cấp …"?** Nhà cung cấp đó đã có trong danh mục, có thể đang ngừng giao dịch. Tìm theo tên, bấm **Kích hoạt lại** thay vì tạo mới, để công nợ không bị chia ra hai nơi.

**Số điện thoại báo không hợp lệ?** Di động 10 số, máy bàn 11 số, bắt đầu bằng 0. Viết có khoảng trắng hoặc `+84` đều được, phần mềm tự chuẩn hóa.
