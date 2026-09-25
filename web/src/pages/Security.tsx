import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/context";
import * as api from "../api/client";

function ChangePasswordForm() {
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
      setStatus("Password updated.");
      setCurrent("");
      setNext("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm">
      <label className="flex flex-col gap-1 text-sm">
        Current password
        <input
          type="password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="border border-slate-300 rounded px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        New password
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
        Update password
      </button>
    </form>
  );
}

const DELETE_CONFIRMATION_WORD = "DELETE";

function DeleteAccountForm() {
  const { deleteAccount } = useAuth();
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
          ? "That password is incorrect. Nothing was deleted."
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm">
      <label className="flex flex-col gap-1 text-sm">
        Your password
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
        Type {DELETE_CONFIRMATION_WORD} to confirm
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
        {deleting ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}

function SessionsList() {
  const [sessions, setSessions] = useState<api.WebSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setSessions(await api.listSessions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            <div>{s.userAgent ?? "Unknown browser"}</div>
            <div className="text-slate-400 text-xs">
              {s.ipAddress ?? "unknown IP"} · created {new Date(s.createdAt).toLocaleString()}
              {s.current && <span className="ml-2 text-emerald-600">(this session)</span>}
            </div>
          </div>
          {!s.current && (
            <button className="text-red-600 hover:underline" onClick={() => handleRevoke(s.id)}>
              Revoke
            </button>
          )}
        </div>
      ))}
      {sessions.length === 0 && <p className="text-sm text-slate-500">No active sessions.</p>}
    </div>
  );
}

export default function Security() {
  const [settings, setSettings] = useState<api.UserSettings | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Security</h1>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-2">Encryption status</h2>
        <p className="text-sm text-slate-600">
          {settings === null
            ? "Loading…"
            : settings.requireEncryption
              ? "End-to-end encryption is required for this account. The server cannot read your synchronized browser data."
              : "This server is not enforcing end-to-end encryption, so it would accept unencrypted data (REQUIRE_ENCRYPTION is off). Your devices still encrypt what they sync, but nothing on the server stops a client that doesn't. This setup is only appropriate for local development — see docs/encryption.md."}
        </p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">Active sessions</h2>
        <SessionsList />
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
        <h2 className="font-medium mb-4">Change password</h2>
        <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2 mb-4">
          Your data stays readable across a password change: the encryption
          key itself doesn't change, it's just re-secured under your new
          password (docs/encryption.md §2). Every device just needs to sign
          in again to pick it up — nothing needs to be reconnected or
          re-synced. Changing your password also signs out every other
          browser session on this account.
        </p>
        <ChangePasswordForm />
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-red-200 p-5 mt-6">
        <h2 className="font-medium text-red-700 mb-4">Danger zone</h2>
        <p className="text-sm text-slate-600 bg-red-50 border border-red-100 rounded px-3 py-2 mb-4">
          Deleting your account permanently removes everything stored on this server: your devices, all synced
          bookmarks, history and tabs, and every session. It can't be undone, and because your data is encrypted
          with a key only your password unlocks, it can't be recovered afterwards either. Browsers that are still
          connected simply stop syncing.
        </p>
        <DeleteAccountForm />
      </div>
    </div>
  );
}
