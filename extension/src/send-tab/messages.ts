import type { SendTabResult } from "./send";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The text a user sees for a failed send, in the popup and in notifications. */
export function failureMessage(t: Translate, result: Extract<SendTabResult, { ok: false }>, name: string): string {
  switch (result.reason) {
    case "offline":
      return t("sendtab_offline", { device: name });
    case "not_connected":
      return t("sendtab_notConnected");
    case "unsupported":
      return t("sendtab_unsupported");
    case "bad_url":
      return t("sendtab_badUrl");
    case "too_large":
      return t("sendtab_tooLarge");
    case "device_gone":
      return t("sendtab_deviceGone");
    case "rate_limited":
      return t("sendtab_rateLimited");
    default:
      return t("sendtab_failed", { message: result.message ?? "" });
  }
}
