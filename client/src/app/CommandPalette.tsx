import { EnterOutlined, FileTextOutlined, MedicineBoxOutlined, SearchOutlined, UserOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Input, Modal, Spin } from "antd";
import type { InputRef } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { http } from "../api/http.js";
import { formatVnd, type CustomerSearchItem, type Envelope, type InvoiceListItem, type Paged, type ProductListItem } from "../api/types.js";
import { useAuth } from "../features/auth/AuthProvider.js";
import { useDebounced } from "../ui/useDebounced.js";
import { confirmLeave } from "./leave-guard.js";
import { foldText, isAllowed, NAV_ITEMS } from "./navigation.js";

type Result = { key: string; icon: ReactNode; title: string; subtitle?: string; path: string };
type Section = { label: string; results: Result[]; loading: boolean };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const term = useDebounced(query.trim(), 250);

  const products = useQuery({
    queryKey: ["palette-products", term],
    enabled: open && can("catalog.read") && term.length >= 2,
    queryFn: async () =>
      (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: term, page: 1, limit: 5 } })).data.data.items,
    staleTime: 30_000,
  });
  const customers = useQuery({
    queryKey: ["palette-customers", term],
    enabled: open && can("customer.read") && term.length >= 3,
    queryFn: async () => (await http.get<Envelope<CustomerSearchItem[]>>("/customers", { params: { search: term } })).data.data.slice(0, 5),
    staleTime: 30_000,
  });
  // Số hóa đơn luôn có chữ số, tránh gọi API khi người dùng đang gõ tên thuốc.
  const invoices = useQuery({
    queryKey: ["palette-invoices", term],
    enabled: open && can("invoice.read") && term.length >= 3 && /\d/.test(term),
    queryFn: async () =>
      (await http.get<Envelope<Paged<InvoiceListItem>>>("/invoices", { params: { code: term, page: 1, limit: 5 } })).data.data.items,
    staleTime: 30_000,
  });

  const sections = useMemo<Section[]>(() => {
    const folded = foldText(query.trim());
    const pages = NAV_ITEMS.filter((item) => isAllowed(item, can))
      .filter((item) => !folded || foldText(`${item.label} ${item.keywords ?? ""}`).includes(folded))
      .slice(0, folded ? 5 : 8)
      .map<Result>((item) => ({ key: `page:${item.path}`, icon: item.icon, title: item.label, subtitle: "Mở trang", path: item.path }));

    const list: Section[] = [{ label: folded ? "Trang" : "Đi tới trang", results: pages, loading: false }];
    if (term.length >= 2 && can("catalog.read")) {
      list.push({
        label: "Thuốc & sản phẩm",
        loading: products.isFetching,
        results: (products.data ?? []).map((item) => ({
          key: `product:${item.id}`,
          icon: <MedicineBoxOutlined />,
          title: item.name,
          subtitle: [item.code, item.categoryName, item.currentPrice ? formatVnd(item.currentPrice.salePrice) : null].filter(Boolean).join(" · "),
          path: `/san-pham?id=${item.id}`,
        })),
      });
    }
    if (term.length >= 3 && can("customer.read")) {
      list.push({
        label: "Khách hàng",
        loading: customers.isFetching,
        results: (customers.data ?? []).map((item) => ({
          key: `customer:${item.id}`,
          icon: <UserOutlined />,
          title: item.fullName ?? "Khách chưa có tên",
          subtitle: item.phone ?? undefined,
          path: `/khach-hang?id=${item.id}`,
        })),
      });
    }
    if (term.length >= 3 && /\d/.test(term) && can("invoice.read")) {
      list.push({
        label: "Hóa đơn",
        loading: invoices.isFetching,
        results: (invoices.data ?? []).map((item) => ({
          key: `invoice:${item.id}`,
          icon: <FileTextOutlined />,
          title: item.code,
          subtitle: `${new Date(item.soldAt).toLocaleString("vi-VN")} · ${formatVnd(item.totalAmount)}`,
          path: `/hoa-don?id=${item.id}`,
        })),
      });
    }
    return list;
  }, [query, term, can, products.data, products.isFetching, customers.data, customers.isFetching, invoices.data, invoices.isFetching]);

  const flat = useMemo(() => sections.flatMap((section) => section.results), [sections]);
  const offsets = sections.map((_, sectionIndex) =>
    sections.slice(0, sectionIndex).reduce((sum, section) => sum + section.results.length, 0),
  );
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const loading = sections.some((section) => section.loading);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function close() {
    setQuery("");
    setActive(0);
    onClose();
  }

  function choose(result: Result | undefined) {
    if (!result) return;
    close();
    confirmLeave(() => void navigate(result.path));
  }

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      closable={false}
      width={640}
      className="palette-modal"
      style={{ top: 88 }}
      afterOpenChange={(visible) => {
        if (visible) inputRef.current?.focus();
      }}
      destroyOnHidden
    >
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        className="palette-input"
        prefix={<SearchOutlined />}
        suffix={loading ? <Spin size="small" /> : <kbd>Esc</kbd>}
        placeholder="Tìm trang, thuốc, khách hàng hoặc số hóa đơn…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(flat.length === 0 ? 0 : (activeIndex + 1) % flat.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(flat.length === 0 ? 0 : (activeIndex - 1 + flat.length) % flat.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(flat[activeIndex]);
          }
        }}
      />
      <div className="palette-results" ref={listRef} role="listbox">
        {sections.map((section, sectionIndex) =>
          section.results.length === 0 && !section.loading ? null : (
            <div key={section.label} className="palette-section">
              <div className="palette-section-label">{section.label}</div>
              {section.results.length === 0 ? <div className="palette-hint">Đang tìm…</div> : null}
              {section.results.map((result, resultIndex) => {
                const current = offsets[sectionIndex]! + resultIndex;
                return (
                  <button
                    key={result.key}
                    type="button"
                    role="option"
                    aria-selected={current === activeIndex}
                    data-index={current}
                    className={current === activeIndex ? "palette-item active" : "palette-item"}
                    onMouseMove={() => setActive(current)}
                    onClick={() => choose(result)}
                  >
                    <span className="palette-item-icon">{result.icon}</span>
                    <span className="palette-item-text">
                      <strong>{result.title}</strong>
                      {result.subtitle ? <span>{result.subtitle}</span> : null}
                    </span>
                    {current === activeIndex ? <EnterOutlined className="palette-item-enter" /> : null}
                  </button>
                );
              })}
            </div>
          ),
        )}
        {flat.length === 0 && !loading ? (
          <div className="palette-empty">Không tìm thấy kết quả phù hợp với “{query.trim()}”.</div>
        ) : null}
      </div>
      <div className="palette-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> di chuyển
        </span>
        <span>
          <kbd>Enter</kbd> mở
        </span>
        <span>Gõ từ 2 ký tự để tìm thuốc, 3 ký tự để tìm khách hàng và số hóa đơn</span>
      </div>
    </Modal>
  );
}
