import type { MarginStatus } from "./margin";

/** Formats a number as currency for display. Falls back gracefully on bad codes. */
export function formatMoney(
  value: number,
  currencyCode = "GBP",
  locale = "en-GB",
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode,
    }).format(value);
  } catch {
    return `${currencyCode} ${value.toFixed(2)}`;
  }
}

export function formatPercent(value: number, locale = "en-GB"): string {
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

/** Maps a margin status onto a Polaris badge tone. */
export function statusTone(
  status: MarginStatus,
): "critical" | "warning" | "success" | "info" | "neutral" {
  switch (status) {
    case "loss":
    case "critical":
      return "critical";
    case "warn":
      return "warning";
    case "healthy":
      return "success";
    default:
      return "neutral";
  }
}

export function statusLabel(status: MarginStatus): string {
  switch (status) {
    case "loss":
      return "Losing money";
    case "critical":
      return "Critical";
    case "warn":
      return "Below target";
    case "healthy":
      return "Healthy";
    default:
      return "No cost set";
  }
}

/** Parses a form value into a number, treating blanks and junk as 0. */
export function parseNumber(value: FormDataEntryValue | null): number {
  if (value === null) return 0;
  const parsed = Number(String(value).trim().replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
