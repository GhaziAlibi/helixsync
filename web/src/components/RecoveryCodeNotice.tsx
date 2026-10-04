import { useState } from "react";

/** Shows a recovery code once (docs/encryption.md §9.1) and keeps the user
 * on this screen until they confirm they saved it: the server keeps only a
 * hash, so it can never show the code again. */
export default function RecoveryCodeNotice({
  code,
  email,
  continueLabel,
  onContinue,
}: {
  code: string;
  email: string;
  continueLabel: string;
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const text = [
      "HelixSync recovery code",
      "",
      `Account: ${email}`,
      `Recovery code: ${code}`,
      "",
      "If you forget your password, enter this code on the sign-in page under",
      '"Forgot your password?" to set a new one without losing your synced data.',
      "Each code works once; you get a new one after using it.",
      "",
      "Keep it offline and private: anyone with this code and your email can",
      "reset your password and read your synced data.",
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "helixsync-recovery-code.txt";
    link.click();
    // Revoked after the click has started the download, not before.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        <button type="button" onClick={download} className="flex-1 rounded border border-slate-300 py-2 text-sm">
          Download .txt
        </button>
      </div>
      <p className="text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        Keep it offline, printed or in a password manager. Anyone with this code and your email can reset your
        password and read your synced data.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1" />
        <span>I saved my recovery code somewhere safe.</span>
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={onContinue}
        className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
      >
        {continueLabel}
      </button>
    </div>
  );
}
