import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/context";
import * as api from "../api/client";
import {
  downloadRescueFile,
  loadPasskeyRecord,
  passkeySupported,
  savePasskeyRecord,
  sealWithNewPasskey,
  unsealWithPasskey,
} from "../passkey";

import { errorText as describe } from "../i18n/errors";

/** Typing the current recovery code back (docs/encryption.md §9.1): the
 * server compares only its derived key and sets the "confirmed" flag. */
export function ConfirmRecoveryCodeForm() {
  const { user, markRecoveryCodeConfirmed } = useAuth();
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const confirmed = user?.recoveryCodeConfirmed === true;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWorking(true);
    try {
      await api.confirmRecoveryCode(typed);
      markRecoveryCodeConfirmed();
      setTyped("");
    } catch (err) {
      setError(
        err instanceof api.ApiError && err.status === 401
          ? t("safeguards.wrongCurrentGenerate")
          : describe(err),
      );
    } finally {
      setWorking(false);
    }
  }

  if (confirmed) {
    return <p className="text-sm text-emerald-600 mb-4">{t("safeguards.confirmed")}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm mb-6">
      <label className="flex flex-col gap-1 text-sm">
        {t("safeguards.confirmLabel")}
        <input
          type="text"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2 font-mono"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={working}
        className="self-start rounded bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50"
      >
        {working ? t("safeguards.checking") : t("safeguards.confirmButton")}
      </button>
    </form>
  );
}

/** Seals the recovery code under a passkey (docs/encryption.md §9.5). Needs
 * the current code typed in (checked by the server), then adds the passkey,
 * keeps the sealed copy in this browser and offers a rescue file. */
export function PasskeySection() {
  const { user, markRecoveryCodeConfirmed } = useAuth();
  const { t } = useTranslation();
  const email = user?.email ?? "";
  const [supported, setSupported] = useState<boolean | null>(null);
  const [record, setRecord] = useState(() => loadPasskeyRecord(email));
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    passkeySupported().then((ok) => {
      if (!cancelled) setSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (supported === null) return null;
  if (!supported) {
    return (
      <p className="text-sm text-slate-500">
        {t("safeguards.noPasskeySupport")}
      </p>
    );
  }

  async function enrol(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      // The server accepts only the current code, so a stale one is never sealed.
      await api.confirmRecoveryCode(typed);
      markRecoveryCodeConfirmed();
      const next = await sealWithNewPasskey(email, typed);
      savePasskeyRecord(next);
      downloadRescueFile(next);
      setRecord(next);
      setTyped("");
      setStatus(t("safeguards.passkeyAdded"));
    } catch (err) {
      setError(
        err instanceof api.ApiError && err.status === 401 ? t("safeguards.wrongCurrent") : describe(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!record) return;
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      await api.confirmRecoveryCode(await unsealWithPasskey(record));
      markRecoveryCodeConfirmed();
      setStatus(t("safeguards.passkeyWorks"));
    } catch (err) {
      setError(
        err instanceof api.ApiError && err.status === 401
          ? t("safeguards.passkeyOldCode")
          : describe(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 max-w-sm">
      {record && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-slate-700">{t("safeguards.protects")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={check}
              className="rounded border border-slate-300 px-3 py-2 disabled:opacity-50"
            >
              {t("safeguards.checkWorks")}
            </button>
            <button
              type="button"
              onClick={() => downloadRescueFile(record)}
              className="rounded border border-slate-300 px-3 py-2"
            >
              {t("safeguards.downloadRescue")}
            </button>
          </div>
        </div>
      )}
      <form onSubmit={enrol} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {record ? t("safeguards.replaceLabel") : t("safeguards.typeCurrent")}
          <input
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="border border-slate-300 rounded px-3 py-2 font-mono"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50"
        >
          {busy ? t("safeguards.waitingPasskey") : t("safeguards.addPasskey")}
        </button>
      </form>
      {status && <p className="text-sm text-emerald-600">{status}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
