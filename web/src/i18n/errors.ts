import i18n from "./index";
import { LocalizedError } from "./localized-error";

export { LocalizedError };

/** Server error codes that have a translated message. Others (such as
 * `validation_error`, whose message names the exact problem) show the
 * server's English message. */
const API_ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
  "registration_disabled",
  "rate_limited",
  "protocol_too_old",
  "busy",
  "internal_error",
  "restore_point_pin_limit",
]);

/** The text to show for any error thrown while the UI was doing something. */
export function errorText(err: unknown, fallbackKey = "errors.generic"): string {
  if (err instanceof LocalizedError) return i18n.t(err.key, err.params);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && API_ERROR_CODES.has(code) && (err as { status?: unknown }).status !== undefined) {
    return i18n.t(`apiErrors.${code}`);
  }
  if (err instanceof Error && err.message) return err.message;
  return i18n.t(fallbackKey);
}
