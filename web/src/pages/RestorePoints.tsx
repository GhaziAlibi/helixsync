import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import { formatBytes } from "../util/format-bytes";
import { errorText } from "../i18n/errors";
import { formatDateTime, formatNumber } from "../i18n/format";

export default function RestorePoints() {
  const { t } = useTranslation();
  const [points, setPoints] = useState<api.RestorePoint[]>([]);
  const [settings, setSettings] = useState<api.UserSettings | null>(null);
  const [stats, setStats] = useState<api.SyncStats | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const version = await api.getServerVersion();
      if (version.restorePoints !== true) {
        setSupported(false);
        return;
      }
      const [list, loadedSettings, loadedStats] = await Promise.all([
        api.listRestorePoints(),
        api.getSettings(),
        api.getSyncStats().catch(() => null),
      ]);
      setPoints(list);
      setSettings(loadedSettings);
      setStats(loadedStats);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function togglePin(point: api.RestorePoint) {
    setBusyId(point.id);
    setError(null);
    try {
      const updated = await api.setRestorePointPinned(point.id, !point.pinned);
      setPoints((current) => current.map((p) => (p.id === point.id ? { ...p, pinned: updated.pinned } : p)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(point: api.RestorePoint) {
    if (!confirm(t("restore.deleteConfirm", { date: formatDateTime(point.createdAt) }))) {
      return;
    }
    setBusyId(point.id);
    setError(null);
    try {
      await api.deleteRestorePoint(point.id);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  async function setAutomatic(enabled: boolean) {
    if (!settings) return;
    setError(null);
    setSettings({ ...settings, restorePointsAutomatic: enabled });
    try {
      setSettings(await api.updateSettings({ restorePointsAutomatic: enabled }));
    } catch (e) {
      setSettings(settings);
      setError(errorText(e));
    }
  }

  if (loading) return <p className="text-sm text-slate-500">{t("common.loading")}</p>;

  if (!supported) {
    return (
      <div>
        <h1 className="text-2xl font-semibold mb-6">{t("restore.title")}</h1>
        <p className="text-sm text-slate-500">{t("restore.unsupported")}</p>
      </div>
    );
  }

  const used = stats?.restorePointBytes ?? points.reduce((sum, p) => sum + p.sizeBytes, 0);
  const limit = stats?.restorePointLimitBytes;
  const fraction = limit && limit > 0 ? Math.min(used / limit, 1) : 0;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">{t("restore.title")}</h1>
      <p className="text-sm text-slate-500 mb-6">
        {t("restore.intro")}
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings?.restorePointsAutomatic !== false}
            onChange={(e) => void setAutomatic(e.target.checked)}
          />
          {t("restore.automatic")}
        </label>
        <p className="text-xs text-slate-400 mt-1">
          {t("restore.automaticHelp")}
        </p>
        <div className="mt-4 text-xs uppercase tracking-wide text-slate-500">{t("restore.spaceUsed")}</div>
        <div className="text-sm mt-1">
          {formatBytes(used)}
          {limit ? <span className="text-slate-400"> / {formatBytes(limit)}</span> : null}
        </div>
        {limit ? (
          <div className="w-full h-1.5 bg-slate-100 rounded-full mt-2 overflow-hidden">
            <div
              className={`h-full rounded-full ${fraction >= 0.9 ? "bg-red-500" : fraction >= 0.7 ? "bg-amber-500" : "bg-blue-500"}`}
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 overflow-hidden">
        {points.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">{t("restore.none")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-slate-500">
              <tr>
                <th className="px-4 py-2 font-normal">{t("restore.created")}</th>
                <th className="px-4 py-2 font-normal">{t("restore.kindColumn")}</th>
                <th className="px-4 py-2 font-normal">{t("restore.device")}</th>
                <th className="px-4 py-2 font-normal">{t("restore.bookmarks")}</th>
                <th className="px-4 py-2 font-normal">{t("restore.size")}</th>
                <th className="px-4 py-2 font-normal">{t("restore.lastRestored")}</th>
                <th className="px-4 py-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    {formatDateTime(p.createdAt)}
                    {p.pinned && <span className="ms-2 text-xs text-blue-600">{t("restore.pinned")}</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{t(`restore.kind.${p.kind}`, { defaultValue: p.kind })}</td>
                  <td className="px-4 py-3 text-slate-500">{p.deviceName ?? t("restore.removedDevice")}</td>
                  <td className="px-4 py-3 text-slate-500">{formatNumber(p.bookmarkCount)}</td>
                  <td className="px-4 py-3 text-slate-500">{formatBytes(p.sizeBytes)}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {p.lastRestoredAt ? formatDateTime(p.lastRestoredAt) : t("common.never")}
                  </td>
                  <td className="px-4 py-3 text-end whitespace-nowrap">
                    <button
                      className="text-slate-700 hover:underline me-4 disabled:opacity-50"
                      disabled={busyId === p.id}
                      onClick={() => void togglePin(p)}
                    >
                      {p.pinned ? t("restore.unpin") : t("restore.pin")}
                    </button>
                    <button
                      className="text-red-600 hover:underline disabled:opacity-50"
                      disabled={busyId === p.id}
                      onClick={() => void remove(p)}
                    >
                      {t("common.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
