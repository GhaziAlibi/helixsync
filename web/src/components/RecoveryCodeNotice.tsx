import { useEffect, useState } from "react";
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
import { RECOVERY_KIT_STEPS, RECOVERY_KIT_WARNING, recoveryKitDate, recoveryKitText } from "../util/recovery-kit";

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
    const url = URL.createObjectURL(new Blob([recoveryKitText(kit)], { type: "text/plain" }));
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
        setError("Couldn't record that on the server. Try again.");
        setContinuing(false);
        return;
      }
    }
    onContinue();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-700">
        This is your recovery code. If you forget your password, it's the only way back into your account without
        losing your synced data. It's shown only now.
      </p>
      <code className="block text-center font-mono text-lg tracking-wider bg-slate-100 border border-slate-200 rounded px-3 py-3 break-all select-all">
        {code}
      </code>
      <div className="flex gap-2">
        <button type="button" onClick={copy} className="flex-1 rounded border border-slate-300 py-2 text-sm">
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="flex-1 rounded border border-slate-300 py-2 text-sm"
        >
          Print kit
        </button>
        <button type="button" onClick={download} className="flex-1 rounded border border-slate-300 py-2 text-sm">
          Download .txt
        </button>
      </div>
      <p className="text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        Keep it offline, printed or in a password manager. Anyone with this code and your email can reset your
        password and read your synced data.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Type your recovery code to confirm you saved it
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="rounded border border-slate-300 px-3 py-2 font-mono"
        />
        {typed.length > 0 && !matches && <span className="text-xs text-slate-500">Doesn't match yet.</span>}
        {matches && <span className="text-xs text-emerald-600">Matches.</span>}
      </label>
      {matches && <PasskeySeal code={code} email={email} />}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        disabled={!matches || continuing}
        onClick={onDone}
        className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
      >
        {continuing ? "Saving…" : continueLabel}
      </button>

      <section className="recovery-kit-print" style={{ display: "none" }} aria-hidden="true">
        <h1 style={{ fontSize: "20pt", fontWeight: 600 }}>HelixSync recovery kit</h1>
        <p>Account: {email}</p>
        <p>Server: {kit.serverUrl}</p>
        <p>Generated: {recoveryKitDate(generatedAt)}</p>
        <p style={{ fontFamily: "monospace", fontSize: "16pt", margin: "16pt 0" }}>{code}</p>
        <p>If you forget your password:</p>
        <ol>
          {RECOVERY_KIT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>{RECOVERY_KIT_WARNING}</p>
      </section>
    </div>
  );
}

/** Optional: protects this code with a passkey (docs/encryption.md §9.5). An
 * existing passkey record is re-sealed with the new code; otherwise a passkey
 * can be added. Never blocks continuing. */
function PasskeySeal({ code, email }: { code: string; email: string }) {
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
    return <p className="text-sm text-emerald-600">Passkey updated. Keep the rescue file somewhere safe.</p>;
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
      setError(err instanceof Error ? err.message : "The passkey wasn't used.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-slate-200 rounded px-3 py-2">
      <p className="text-sm text-slate-700">
        {existing
          ? "Your passkey still holds your old code. Seal this new one with it."
          : "Optional: protect this code with a passkey (fingerprint, OS PIN or security key)."}
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="self-start rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
      >
        {busy ? "Waiting for the passkey…" : existing ? "Update my passkey" : "Add a passkey"}
      </button>
    </div>
  );
}
