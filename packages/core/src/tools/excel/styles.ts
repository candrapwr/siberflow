/**
 * Styling helpers for the Excel tools.
 *
 * The goal: expose styling to the model as HIGH-LEVEL intents (themes, named
 * colors, named number-formats, boolean toggles) instead of raw exceljs style
 * objects. Models reason reliably about "header bold blue, zebra rows, column
 * harga formatted as currency" — they hallucinate on per-cell ARGB fill maps.
 *
 * Resolution order for `resolveStyling`:
 *   1. Start from the implicit default (professional).
 *   2. Apply the chosen theme preset on top (overwrites matching fields).
 *   3. Apply any explicitly-supplied fields from the caller (highest priority).
 *
 * All color strings flowing into exceljs become 8-hex ARGB ("FFRRGGBB") via
 * `normalizeColor`; both named colors ("blue") and "#RRGGBB" are accepted.
 */

export type ThemeName = "professional" | "zebra" | "minimal" | "colorful";

export interface HeaderStyling {
  bold?: boolean;
  /** Named color ("blue") or "#RRGGBB". */
  background?: string;
  /** Named color ("white") or "#RRGGBB" — the header text color. */
  color?: string;
}

export interface StylingConfig {
  theme?: ThemeName;
  header?: HeaderStyling;
  /** Alternate row background for readability. */
  zebraRows?: boolean;
  /** Freeze the header row (and column header area) so it stays visible on scroll. */
  freezeHeader?: boolean;
  /** Auto-fit column widths to content. */
  autoWidth?: boolean;
  /** Map of column name → named format ("currency") or raw Excel format string. */
  numberFormats?: Record<string, string>;
}

export interface ResolvedStyling {
  header: { bold: boolean; background: string; color: string };
  zebraRows: boolean;
  freezeHeader: boolean;
  autoWidth: boolean;
  zebraColor: string;
  numberFormats: Record<string, string>;
  /** True when the caller supplied no styling at all (used for result messages). */
  appliedDefault: boolean;
}

/**
 * Named color → ARGB. Hex codes (with or without leading #) are accepted too.
 * Keys are lowercase; lookups normalize input to lowercase before matching.
 */
export const NAMED_COLORS: Record<string, string> = {
  black: "FF000000",
  white: "FFFFFFFF",
  blue: "FF4472C4",
  darkblue: "FF1F4E78",
  lightblue: "FFDDEBF7",
  green: "FF548235",
  lightgreen: "FFE2EFDA",
  red: "FFC00000",
  lightred: "FFFCE4D6",
  orange: "FFED7D31",
  lightorange: "FFFBE5D6",
  yellow: "FFFFC000",
  lightyellow: "FFFFF2CC",
  purple: "FF7030A0",
  lightpurple: "FFE4DFEC",
  gray: "FF808080",
  grey: "FF808080",
  lightgray: "FFF2F2F2",
  lightgrey: "FFF2F2F2",
  darkgray: "FF404040",
  darkgrey: "FF404040",
  teal: "FF008080",
  lightteal: "FFD6EAEA",
};

/**
 * Named number formats → Excel format string. Raw format strings are passed
 * through unchanged, so callers can use either ("currency" or "#,##0.00").
 */
export const NUMBER_FORMATS: Record<string, string> = {
  currency: '#,##0.00',
  currency2: '"$"#,##0.00',
  integer: '#,##0',
  decimal: '#,##0.00',
  percent: '0.00%',
  percent0: '0%',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm:ss',
  time: 'hh:mm:ss',
  scientific: '0.00E+00',
};

/** Convert a named color or "#RRGGBB" (or "RRGGBB") into exceljs ARGB "FFRRGGBB". */
export function normalizeColor(input: string): string {
  const trimmed = input.trim();
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;

  // Strip optional leading #, then pad to RRGGBB. Prepend FF alpha if missing.
  let hex = trimmed.replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const expanded = hex
      .split("")
      .map((c) => c + c)
      .join("");
    return `FF${expanded.toUpperCase()}`;
  }
  throw new Error(
    `Unknown color "${input}". Use a named color (${Object.keys(NAMED_COLORS).join(", ")}) or hex (#RRGGBB).`,
  );
}

/** Resolve a possibly-named number format to its Excel format string. */
export function resolveNumberFormat(input: string): string {
  const named = NUMBER_FORMATS[input.toLowerCase()];
  return named ?? input;
}

const PROFESSIONAL: ResolvedStyling = {
  header: { bold: true, background: "FF4472C4", color: "FFFFFFFF" },
  zebraRows: true,
  freezeHeader: true,
  autoWidth: true,
  zebraColor: "FFF2F2F2",
  numberFormats: {},
  appliedDefault: false,
};

const THEME_PRESETS: Record<ThemeName, Partial<ResolvedStyling>> = {
  professional: {},
  zebra: {
    header: { bold: true, background: "FF808080", color: "FFFFFFFF" },
    zebraRows: true,
  },
  minimal: {
    header: { bold: true, background: "FFF2F2F2", color: "FF000000" },
    zebraRows: false,
  },
  colorful: {
    header: { bold: true, background: "FFED7D31", color: "FFFFFFFF" },
    zebraRows: true,
    zebraColor: "FFFBE5D6",
  },
};

/**
 * Merge default → theme preset → explicit caller overrides into a fully
 * resolved styling object. Caller-supplied colors/formats are normalized here.
 */
export function resolveStyling(styling?: StylingConfig): ResolvedStyling {
  if (!styling) {
    return { ...PROFESSIONAL, appliedDefault: true };
  }

  const themeName: ThemeName = styling.theme ?? "professional";
  const themeOverride = THEME_PRESETS[themeName] ?? {};

  // Start from the professional baseline.
  const resolved: ResolvedStyling = {
    ...PROFESSIONAL,
    header: { ...PROFESSIONAL.header },
    numberFormats: { ...PROFESSIONAL.numberFormats },
  };

  // Apply theme preset (header may be partial — merge field by field).
  if (themeOverride.header) {
    resolved.header = {
      bold: themeOverride.header.bold ?? resolved.header.bold,
      background: themeOverride.header.background ?? resolved.header.background,
      color: themeOverride.header.color ?? resolved.header.color,
    };
  }
  if (themeOverride.zebraRows !== undefined) resolved.zebraRows = themeOverride.zebraRows;
  if (themeOverride.freezeHeader !== undefined) resolved.freezeHeader = themeOverride.freezeHeader;
  if (themeOverride.autoWidth !== undefined) resolved.autoWidth = themeOverride.autoWidth;
  if (themeOverride.zebraColor !== undefined) resolved.zebraColor = themeOverride.zebraColor;

  // Apply explicit caller overrides (highest priority). Color fields are
  // normalized to ARGB; number formats are expanded from named → format string.
  if (styling.header) {
    if (styling.header.bold !== undefined) resolved.header.bold = styling.header.bold;
    if (styling.header.background) {
      resolved.header.background = normalizeColor(styling.header.background);
    }
    if (styling.header.color) {
      resolved.header.color = normalizeColor(styling.header.color);
    }
  }
  if (styling.zebraRows !== undefined) resolved.zebraRows = styling.zebraRows;
  if (styling.freezeHeader !== undefined) resolved.freezeHeader = styling.freezeHeader;
  if (styling.autoWidth !== undefined) resolved.autoWidth = styling.autoWidth;
  if (styling.numberFormats) {
    resolved.numberFormats = {};
    for (const [col, fmt] of Object.entries(styling.numberFormats)) {
      resolved.numberFormats[col] = resolveNumberFormat(fmt);
    }
  }

  resolved.appliedDefault = false;
  return resolved;
}
