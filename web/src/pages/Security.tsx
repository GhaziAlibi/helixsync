import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/context";
import * as api from "../api/client";
import RecoveryCodeNotice from "../components/RecoveryCodeNotice";
import { ConfirmRecoveryCodeForm, PasskeySection } from "../components/RecoveryCodeSafeguards";
import { errorText } from "../i18n/errors";
import { formatDateTime } from "../i18n/format";

function ChangePasswordForm() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    try {
      await api.changePassword(current, next);
      setStatus(t("security.passwordUpdated"));
      setCurrent("");
      setNext("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm">
      <label className="flex flex-col gap-1 text-sm">
        {t("security.currentPassword")}
        <input
          type="password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("security.newPassword")}
        <input
          type="password"
          required
          minLength={12}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {status && <p className="text-sm text-emerald-600">{status}</p>}
      <button type="submit" className="self-start rounded bg-slate-900 text-white px-4 py-2 text-sm">
        {t("security.updatePassword")}
      </button>
    </form>
  );
}

function RecoveryCodeForm({ onShowing }: { onShowing: (showing: boolean) => void }) {
  const { user, markRecoveryCodeUnconfirmed } = useAuth();
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWorking(true);
    try {
      setCode(await api.regenerateRecoveryCode(password));
      markRecoveryCodeUnconfirmed();
      onShowing(true);
      setPassword("");
    } catch (err) {
      setError(
        err instanceof api.ApiError && err.status === 401
          ? t("security.wrongPasswordRecovery")
          : errorText(err),
      );
    } finally {
      setWorking(false);
    }
  }

  if (code) {
    return (
      <div className="max-w-sm">
        <RecoveryCodeNotice
          code={code}
          email={user?.email ?? ""}
          continueLabel={t("security.done")}
          onContinue={() => {
            setCode(null);
            onShowing(false);
          }}
        />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm">
      <label className="flex flex-col gap-1 text-sm">
        {t("security.yourPassword")}
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={working}
        className="self-start rounded bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50"
      >
        {working ? t("security.generating") : t("security.generate")}
      </button>
    </form>
  );
}

const DELETE_CONFIRMATION_WORD = "DELETE";

function DeleteAccountForm() {
  const { deleteAccount } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmed = confirmation === DELETE_CONFIRMATION_WORD && password.length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteAccount(password);
      navigate("/login", { replace: true });
    } catch (err) {
      setError(
        err instanceof api.ApiError && err.status === 401
          ? t("security.wrongPasswordDelete")
          : errorText(err),
      );
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm">
      <label className="flex flex-col gap-1 text-sm">
        {t("security.yourPassword")}
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("security.typeToConfirm", { word: DELETE_CONFIRMATION_WORD })}
        <input
          type="text"
          required
          autoComplete="off"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={!confirmed || deleting}
        className="self-start rounded bg-red-600 text-white px-4 py-2 text-sm disabled:opacity-50"
      >
        {deleting ? t("security.deleting") : t("security.deleteButton")}
      </button>
    </form>
  );
}

function SessionsList() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<api.WebSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setSessions(await api.listSessions());
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRevoke(id: string) {
    await api.revokeSession(id);
    await load();
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((s) => (
        <div key={s.id} className="flex items-center justify-between border border-slate-100 rounded px-3 py-2 text-sm">
          <div>
            <div>{s.userAgent ?? t("security.unknownBrowser")}</div>
            <div className="text-slate-400 text-xs">
              {t("security.sessionCreated", { ip: s.ipAddress ?? t("security.unknownIp"), date: formatDateTime(s.createdAt) })}
              {s.current && <span className="ms-2 text-emerald-600">{t("security.thisSession")}</span>}
            </div>
          </div>
          {!s.current && (
            <button className="text-red-600 hover:underline" onClick={() => handleRevoke(s.id)}>
              {t("common.revoke")}
            </button>
          )}
        </div>
      ))}
      {sessions.length === 0 && <p className="text-sm text-slate-500">{t("security.noSessions")}</p>}
    </div>
  );
}

export default function Security() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<api.UserSettings | null>(null);
  const [newCodeShown, setNewCodeShown] = useState(false);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">{t("security.title")}</h1>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-2">{t("security.encryptionHeading")}</h2>
        <p className="text-sm text-slate-600">
          {settings === null
            ? t("common.loading")
            : settings.requireEncryption
              ? t("security.encryptionRequired")
              : t("security.encryptionNotRequired")}
        </p>
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">{t("security.sessionsHeading")}</h2>
        <SessionsList />
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5">
        <h2 className="font-medium mb-4">{t("security.changePasswordHeading")}</h2>
        <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2 mb-4">
          {t("security.changePasswordInfo")}
        </p>
        <ChangePasswordForm />
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mt-6">
        <h2 className="font-medium mb-4">{t("security.recoveryHeading")}</h2>
        <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2 mb-4">
          {t("security.recoveryInfo")}
        </p>
        {!newCodeShown && <ConfirmRecoveryCodeForm />}
        <RecoveryCodeForm onShowing={setNewCodeShown} />
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mt-6">
        <h2 className="font-medium mb-4">{t("security.passkeyHeading")}</h2>
        <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2 mb-4">
          {t("security.passkeyInfo")}
        </p>
        <PasskeySection />
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-red-200 p-5 mt-6">
        <h2 className="font-medium text-red-700 mb-4">{t("security.dangerHeading")}</h2>
        <p className="text-sm text-slate-600 bg-red-50 border border-red-100 rounded px-3 py-2 mb-4">
          {t("security.dangerInfo")}
        </p>
        <DeleteAccountForm />
      </div>
    </div>
  );
}
