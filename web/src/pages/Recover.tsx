import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { ApiError, recoverAccount } from "../api/client";
import RecoveryCodeNotice from "../components/RecoveryCodeNotice";
import LanguageSelect from "../components/LanguageSelect";
import { errorText } from "../i18n/errors";
import {
  loadPasskeyRecord,
  parseRescueFile,
  passkeySupported,
  savePasskeyRecord,
  unsealWithPasskey,
  type PasskeyRecord,
} from "../passkey";

/** "Forgot your password?": sets a new password with the recovery code
 * (docs/encryption.md §9.1). The account key, and so every synced item,
 * stays the same; the code is replaced by a new one, shown once. */
export default function Recover() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [passkeyOk, setPasskeyOk] = useState(false);
  const [rescue, setRescue] = useState<PasskeyRecord | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    passkeySupported().then((ok) => {
      if (!cancelled) setPasskeyOk(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Unseals the recovery code with the passkey and fills it in; the usual
   * reset below does the rest. */
  async function usePasskey() {
    setError(null);
    const record = rescue ?? loadPasskeyRecord(email);
    if (!record) {
      setError(
        email.includes("@")
          ? t("recover.noPasskeyForEmail")
          : t("recover.enterEmailOrFile"),
      );
      return;
    }
    setPasskeyBusy(true);
    try {
      setCode(await unsealWithPasskey(record));
      // Kept here so the new code can be sealed with the same passkey after.
      savePasskeyRecord(record);
      if (!email) setEmail(record.email);
    } catch (err) {
      setError(errorText(err, "errors.passkeyUnused"));
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function onRescueFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const record = parseRescueFile(await file.text());
      setRescue(record);
      setEmail(record.email);
    } catch (err) {
      setError(errorText(err, "errors.rescueUnreadable"));
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t("login.passwordsMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      setNewCode(await recoverAccount(email, code, password));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t("recover.noMatch"));
      } else {
        setError(errorText(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-sm p-8">
        <h1 className="text-xl font-semibold mb-1">HelixSync</h1>
        {newCode ? (
          <>
            <p className="text-sm text-slate-500 mb-6">{t("recover.done")}</p>
            <p className="text-sm text-slate-700 mb-4">
              {t("recover.doneBody")}
            </p>
            <RecoveryCodeNotice
              code={newCode}
              email={email}
              continueLabel={t("recover.continue")}
              confirmOnServer={false}
              onContinue={() => navigate("/login", { replace: true })}
            />
          </>
        ) : (
          <>
            <p className="text-sm text-slate-500 mb-6">{t("recover.subtitle")}</p>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                {t("login.email")}
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("recover.code")}
                <input
                  type="text"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="rounded border border-slate-300 px-3 py-2 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("recover.newPassword")}
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="rounded border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("recover.confirmNewPassword")}
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="rounded border border-slate-300 px-3 py-2"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
              >
                {submitting ? t("recover.submitting") : t("recover.submit")}
              </button>
            </form>
            {passkeyOk && (
              <div className="mt-4 flex flex-col gap-2 border-t border-slate-200 pt-4">
                <p className="text-sm text-slate-500">{t("recover.passkeyQuestion")}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={passkeyBusy}
                    onClick={usePasskey}
                    className="flex-1 rounded border border-slate-300 py-2 text-sm disabled:opacity-50"
                  >
                    {passkeyBusy ? t("recover.waiting") : t("recover.usePasskey")}
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="flex-1 rounded border border-slate-300 py-2 text-sm"
                  >
                    {rescue ? t("recover.rescueLoaded") : t("recover.chooseRescue")}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => onRescueFile(e.target.files?.[0])}
                  />
                </div>
              </div>
            )}
            <p className="mt-4 text-sm text-slate-500">
              <Trans i18nKey="recover.forgotBoth" components={{ anchor: <Link to="/reset" className="underline" /> }} />
            </p>
            <p className="mt-4 text-sm text-slate-500">
              {t("recover.lostBoth")}
            </p>
            <Link to="/login" className="mt-4 inline-block text-sm text-slate-500 underline">
              {t("recover.back")}
            </Link>
          </>
        )}
      </div>
      <LanguageSelect />
    </div>
  );
}
