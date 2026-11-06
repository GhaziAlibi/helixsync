import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/context";
import { confirmRecoveryCode } from "../api/client";
import { recoveryCodesMatch } from "../crypto";
import {
  downloadRescueFile,
  loadPasskeyRecord,
  passkeySupported,
  resealWithPasskey,
  savePasskeyRecord,
  sealWithNewPasskey,
} from "../passkey";
import { recoveryKitDate, recoveryKitSteps, recoveryKitText, recoveryKitWarning } from "../util/recovery-kit";
import { errorText } from "../i18n/errors";

/** Shows a recovery code once (docs/encryption.md §9.1) and keeps the user
 * on this screen until they type it back: the server keeps only a hash, so it
 * can never show the code again. Pasting is allowed; this checks that the
 * user holds a copy, not that they remember it.
 *
 * `confirmOnServer` (default true) records the confirmation on the account,
 * which needs a signed-in session. The recovery page has none, so it passes
 * false; the dashboard then asks again until the code is confirmed. */
export default function RecoveryCodeNotice({
  code,
  email,
  continueLabel,
  onContinue,
  confirmOnServer = true,
}: {
  code: string;
  email: string;
  continueLabel: string;
  onContinue: () => void;
  confirmOnServer?: boolean;
}) {
  const { markRecoveryCodeConfirmed } = useAuth();
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const [generatedAt] = useState(() => new Date());
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = recoveryCodesMatch(typed, code);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const kit = { email, serverUrl: window.location.origin, code, generatedAt };

  function download() {
    const url = URL.createObjectURL(new Blob([recoveryKitText(kit, t)], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "helixsync-recovery-kit.txt";
    link.click();
    // Revoked after the click has started the download, not before.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function onDone() {
    setError(null);
    if (confirmOnServer) {
      setContinuing(true);
      try {
        await confirmRecoveryCode(code);
        markRecoveryCodeConfirmed();
      } catch {
        setError(t("notice.saveFailed"));
        setContinuing(false);
        return;
      }
    }
    onContinue();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-700">
        {t("notice.intro")}
      </p>
      <code className="block text-center font-mono text-lg tracking-wider bg-slate-100 border border-slate-200 rounded px-3 py-3 break-all select-all">
        {code}
      </code>
      <div className="flex gap-2">
        <button type="button" onClick={copy} className="flex-1 rounded border border-slate-300 py-2 text-sm">
          {copied ? t("notice.copied") : t("notice.copy")}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="flex-1 rounded border border-slate-300 py-2 text-sm"
        >
          {t("notice.print")}
        </button>
        <button type="button" onClick={download} className="flex-1 rounded border border-slate-300 py-2 text-sm">
          {t("notice.download")}
        </button>
      </div>
      <p className="text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        {t("notice.keepOffline")}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        {t("notice.typeLabel")}
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="rounded border border-slate-300 px-3 py-2 font-mono"
        />
        {typed.length > 0 && !matches && <span className="text-xs text-slate-500">{t("notice.noMatch")}</span>}
        {matches && <span className="text-xs text-emerald-600">{t("notice.matches")}</span>}
      </label>
      {matches && <PasskeySeal code={code} email={email} />}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        disabled={!matches || continuing}
        onClick={onDone}
        className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
      >
        {continuing ? t("notice.saving") : continueLabel}
      </button>

      <section className="recovery-kit-print" style={{ display: "none" }} aria-hidden="true">
        <h1 style={{ fontSize: "20pt", fontWeight: 600 }}>{t("kit.title")}</h1>
        <p>{t("kit.account")}: {email}</p>
        <p>{t("kit.server")}: {kit.serverUrl}</p>
        <p>{t("kit.generated")}: {recoveryKitDate(generatedAt)}</p>
        <p style={{ fontFamily: "monospace", fontSize: "16pt", margin: "16pt 0" }}>{code}</p>
        <p>{t("kit.ifForget")}</p>
        <ol>
          {recoveryKitSteps(t).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>{recoveryKitWarning(t)}</p>
      </section>
    </div>
  );
}

/** Optional: protects this code with a passkey (docs/encryption.md §9.5). An
 * existing passkey record is re-sealed with the new code; otherwise a passkey
 * can be added. Never blocks continuing. */
function PasskeySeal({ code, email }: { code: string; email: string }) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = loadPasskeyRecord(email);

  useEffect(() => {
    let cancelled = false;
    passkeySupported().then((ok) => {
      if (!cancelled) setSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supported) return null;
  if (done) {
    return <p className="text-sm text-emerald-600">{t("notice.passkeyUpdated")}</p>;
  }

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const record = existing ? await resealWithPasskey(existing, code) : await sealWithNewPasskey(email, code);
      savePasskeyRecord(record);
      downloadRescueFile(record);
      setDone(true);
    } catch (err) {
      setError(errorText(err, "errors.passkeyUnused"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-slate-200 rounded px-3 py-2">
      <p className="text-sm text-slate-700">
        {existing ? t("notice.passkeyExisting") : t("notice.passkeyNew")}
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="self-start rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
      >
        {busy ? t("notice.waitingPasskey") : existing ? t("notice.updatePasskey") : t("notice.addPasskey")}
      </button>
    </div>
  );
}
