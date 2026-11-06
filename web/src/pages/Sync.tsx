import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import { errorText } from "../i18n/errors";

const FEATURE_TOGGLES: Array<{ key: keyof api.UserSettings; label: string }> = [
  { key: "syncBookmarks", label: "sync.bookmarks" },
  { key: "syncHistory", label: "sync.history" },
  { key: "syncTabs", label: "sync.tabs" },
  { key: "syncTabGroups", label: "sync.tabGroups" },
  { key: "syncExtensions", label: "sync.extensions" },
];

export default function Sync() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<api.UserSettings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(errorText(e)));
  }, []);

  async function save(patch: Partial<api.UserSettings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setStatus(t("sync.saving"));
    try {
      const saved = await api.updateSettings(patch);
      setSettings(saved);
      setStatus(t("sync.saved"));
      setTimeout(() => setStatus(null), 1500);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (error) return <p className="text-red-600 text-sm">{error}</p>;
  if (!settings) return <p className="text-sm text-slate-500">{t("common.loading")}</p>;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">{t("sync.title")}</h1>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">{t("sync.features")}</h2>
        <div className="flex flex-col gap-3">
          {FEATURE_TOGGLES.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings[f.key] as boolean}
                onChange={(e) => save({ [f.key]: e.target.checked })}
              />
              {t(f.label)}
            </label>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">{t("sync.tabPolicy")}</h2>
        <select
          className="border border-slate-300 rounded px-3 py-2 text-sm"
          value={settings.tabRestorePolicy}
          onChange={(e) => save({ tabRestorePolicy: e.target.value as api.UserSettings["tabRestorePolicy"] })}
        >
          <option value="disabled">{t("sync.policyDisabled")}</option>
          <option value="ask">{t("sync.policyAsk")}</option>
          <option value="automatic">{t("sync.policyAutomatic")}</option>
        </select>
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6">
        <h2 className="font-medium mb-4">{t("sync.retention")}</h2>
        <select
          className="border border-slate-300 rounded px-3 py-2 text-sm"
          value={settings.historyRetention}
          onChange={(e) => save({ historyRetention: e.target.value as api.UserSettings["historyRetention"] })}
        >
          <option value="7d">{t("sync.d7")}</option>
          <option value="30d">{t("sync.d30")}</option>
          <option value="90d">{t("sync.d90")}</option>
          <option value="1y">{t("sync.y1")}</option>
          <option value="unlimited">{t("sync.unlimited")}</option>
        </select>
      </div>

      {status && <p className="text-sm text-slate-500">{status}</p>}
    </div>
  );
}
