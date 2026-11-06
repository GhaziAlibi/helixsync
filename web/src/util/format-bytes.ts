import { formatNumber } from "../i18n/format";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unitIndex]}`;
}
