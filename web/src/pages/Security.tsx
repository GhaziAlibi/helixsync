import { useEffect, useState } from "react";
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
              : "End-to-end encryption is not enforced on this server. This configuration is only appropriate for local development — see docs/encryption.md."}
        </p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">Active sessions</h2>
        <SessionsList />
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
        <h2 className="font-medium mb-4">Change password</h2>
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4">
          Your encryption key is derived from this password (docs/encryption.md
          §2). Changing it means every device will derive a <em>different</em>{" "}
          key next time it connects and will no longer be able to read
          bookmarks/history synced before the change. Reconnect each device
          (disconnect, then set it up again) right after changing your
          password so they all pick up the new key together.
        </p>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
