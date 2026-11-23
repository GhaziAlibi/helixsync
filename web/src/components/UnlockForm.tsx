import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import { errorText } from "../i18n/errors";

/** Asks for the password to bring the account key back into memory (after a
 * reload or an auto-lock). Shared by the pages that need it. */
export default function UnlockForm() {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.unlockAccountKey(password);
      setPassword("");
    } catch (err) {
      setError(err instanceof api.ApiError && err.status === 401 ? t("vault.wrongPassword") : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
      <p className="mb-4 text-sm text-slate-600">{t("vault.lockedIntro")}</p>
      <label className="mb-1 block text-sm font-medium" htmlFor="vault-password">
        {t("vault.password")}
      </label>
      <input
        id="vault-password"
        type="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mb-3 w-full rounded border border-slate-300 px-3 py-2 text-base"
      />
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
      >
        {busy ? t("vault.unlocking") : t("vault.unlock")}
      </button>
    </form>
  );
}
