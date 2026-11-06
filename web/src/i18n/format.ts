import i18n from "./index";

function lang(): string {
  return i18n.language || "en";
}

export function formatDateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString(lang());
}

export function formatDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString(lang());
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(lang(), options).format(value);
}

/** "5 minutes ago" in the active language; `never` when there is no date. */
export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return i18n.t("common.never");
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" });
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.floor(hours / 24), "day");
}
