import { useEffect, useState } from "react";
import * as api from "../api/client";

const FEATURE_TOGGLES: Array<{ key: keyof api.UserSettings; label: string }> = [
  { key: "syncBookmarks", label: "Bookmarks" },
  { key: "syncHistory", label: "History" },
  { key: "syncTabs", label: "Tabs" },
  { key: "syncTabGroups", label: "Tab Groups" },
  { key: "syncExtensions", label: "Extensions" },
];

export default function Sync() {
  const [settings, setSettings] = useState<api.UserSettings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(String(e)));
  }, []);

  async function save(patch: Partial<api.UserSettings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setStatus("Saving…");
    try {
      const saved = await api.updateSettings(patch);
      setSettings(saved);
      setStatus("Saved");
      setTimeout(() => setStatus(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <p className="text-red-600 text-sm">{error}</p>;
  if (!settings) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Synchronization</h1>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">Sync features</h2>
        <div className="flex flex-col gap-3">
          {FEATURE_TOGGLES.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings[f.key] as boolean}
                onChange={(e) => save({ [f.key]: e.target.checked })}
              />
              {f.label}
            </label>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">Tab restore policy</h2>
        <select
          className="border border-slate-300 rounded px-3 py-2 text-sm"
          value={settings.tabRestorePolicy}
          onChange={(e) => save({ tabRestorePolicy: e.target.value as api.UserSettings["tabRestorePolicy"] })}
        >
          <option value="disabled">Disabled</option>
          <option value="ask">Ask before restoring</option>
          <option value="automatic">Automatically restore</option>
        </select>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">History retention</h2>
        <select
          className="border border-slate-300 rounded px-3 py-2 text-sm"
          value={settings.historyRetention}
          onChange={(e) => save({ historyRetention: e.target.value as api.UserSettings["historyRetention"] })}
        >
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="1y">1 year</option>
          <option value="unlimited">Unlimited</option>
        </select>
      </div>

      {status && <p className="text-sm text-slate-500">{status}</p>}
    </div>
  );
}
