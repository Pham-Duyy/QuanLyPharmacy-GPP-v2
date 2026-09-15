import type { ThemeConfig } from "antd";

/**
 * Bảng màu gốc của hệ thiết kế. Giữ đồng bộ với biến CSS trong styles/tokens.css:
 * antd đọc giá trị ở đây, còn CSS tự viết đọc biến --c-*.
 */
export const palette = {
  primary: "#0876eb",
  accent: "#10b58a",
  ink900: "#0b2447",
  ink700: "#243b5e",
  ink500: "#5a6f8f",
  ink400: "#8496b0",
  bg: "#f4f7fb",
  surface: "#ffffff",
  surface2: "#f8fafd",
  border: "#e4eaf2",
  borderStrong: "#d3dce8",
  navBg: "#0b1e3b",
  navText: "#b9c7dc",
  navMuted: "#6f84a3",
  success: "#0e9f6e",
  warning: "#e8890c",
  danger: "#dc3a4b",
} as const;

/** Màu dùng cho biểu đồ, theo thứ tự ưu tiên. */
export const chartColors = ["#0876eb", "#10b58a", "#f5a524", "#7c4ddb", "#e5484d", "#0891b2"];
export const chartOtherColor = "#a3b1c6";

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.primary,
    colorInfo: palette.primary,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.danger,
    colorText: palette.ink700,
    colorTextHeading: palette.ink900,
    colorTextSecondary: palette.ink500,
    colorTextTertiary: palette.ink400,
    colorBorder: palette.borderStrong,
    colorBorderSecondary: palette.border,
    colorBgLayout: palette.bg,
    colorFillAlter: palette.surface2,
    colorLink: palette.primary,
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    controlHeight: 36,
    fontSize: 14,
    fontFamily:
      "'Inter Variable', 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif",
    boxShadowTertiary: "0 1px 2px rgba(15, 35, 70, 0.05)",
  },
  components: {
    Layout: {
      bodyBg: palette.bg,
      headerBg: palette.surface,
      headerHeight: 64,
      headerPadding: "0 24px",
      siderBg: palette.navBg,
    },
    Menu: {
      darkItemBg: "transparent",
      darkSubMenuItemBg: "transparent",
      darkPopupBg: palette.navBg,
      darkItemColor: palette.navText,
      darkItemHoverColor: "#ffffff",
      darkItemHoverBg: "rgba(255, 255, 255, 0.06)",
      darkItemSelectedBg: palette.primary,
      darkItemSelectedColor: "#ffffff",
      darkGroupTitleColor: palette.navMuted,
      groupTitleFontSize: 11,
      itemHeight: 38,
      itemBorderRadius: 8,
      itemMarginInline: 12,
      itemMarginBlock: 2,
      iconSize: 17,
      collapsedIconSize: 18,
      collapsedWidth: 72,
    },
    Card: {
      headerFontSize: 15,
      headerHeight: 56,
      headerPadding: 20,
      bodyPadding: 20,
    },
    Table: {
      headerBg: palette.surface2,
      headerColor: palette.ink500,
      headerSplitColor: "transparent",
      borderColor: "#edf1f6",
      rowHoverBg: "#f5f9ff",
      rowSelectedBg: "#eaf3ff",
      rowSelectedHoverBg: "#e0edff",
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
      headerBorderRadius: 10,
    },
    Button: {
      fontWeight: 500,
      primaryShadow: "0 1px 2px rgba(8, 118, 235, 0.24)",
      defaultShadow: "0 1px 2px rgba(15, 35, 70, 0.04)",
      dangerShadow: "none",
    },
    Input: {
      activeShadow: "0 0 0 3px rgba(8, 118, 235, 0.12)",
    },
    Select: {
      optionSelectedBg: "#eaf3ff",
    },
    Tabs: {
      itemColor: palette.ink500,
      itemSelectedColor: palette.primary,
      inkBarColor: palette.primary,
      titleFontSize: 14,
      horizontalMargin: "0 0 16px 0",
    },
    Segmented: {
      trackBg: "#edf2f8",
      itemSelectedColor: palette.ink900,
    },
    Tag: {
      defaultBg: palette.surface2,
      defaultColor: palette.ink700,
    },
    Modal: {
      titleFontSize: 17,
      titleColor: palette.ink900,
    },
    Statistic: {
      contentFontSize: 24,
    },
    Descriptions: {
      labelColor: palette.ink500,
      contentColor: palette.ink900,
    },
    Form: {
      labelColor: palette.ink700,
    },
  },
};
