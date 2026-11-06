import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import { formatBytes } from "../util/format-bytes";
import { errorText } from "../i18n/errors";
import { formatNumber, timeAgo } from "../i18n/format";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function StorageCard({ usedBytes, limitBytes }: { usedBytes: number; limitBytes: number }) {
  const { t } = useTranslation();
  const fraction = limitBytes > 0 ? Math.min(usedBytes / limitBytes, 1) : 0;
  const percent = Math.round(fraction * 100);
  const barColor = fraction >= 0.9 ? "bg-red-500" : fraction >= 0.7 ? "bg-amber-500" : "bg-blue-500";
  return (
    <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5">
      <div className="text-xs uppercase tracking-wide text-slate-500">{t("dashboard.storageUsed")}</div>
      <div className="text-2xl font-semibold mt-1">
        {formatBytes(usedBytes)}
        <span className="text-sm font-normal text-slate-400"> / {formatBytes(limitBytes)}</span>
      </div>
      <div className="w-full h-1.5 bg-slate-100 rounded-full mt-3 overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-xs text-slate-400 mt-1">{t("dashboard.percentOfLimit", { percent })}</div>
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<api.DevicePublic[] | null>(null);
  const [version, setVersion] = useState<api.ServerVersion | null>(null);
  const [stats, setStats] = useState<api.SyncStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listDevices(), api.getServerVersion(), api.getSyncStats()])
      .then(([d, v, s]) => {
        setDevices(d);
        setVersion(v);
        setStats(s);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  const activeDevices = devices?.filter((d) => !d.revokedAt) ?? [];
  const mostRecentSync = activeDevices
    .map((d) => d.lastSeenAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">{t("dashboard.title")}</h1>
      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label={t("dashboard.connection")}
          value={version ? t("dashboard.connected") : "…"}
          sub={version ? t("dashboard.protocol", { version: version.protocolVersion }) : undefined}
        />
        <StatCard label={t("dashboard.lastSync")} value={mostRecentSync ? timeAgo(mostRecentSync) : "—"} />
        <StatCard label={t("dashboard.devices")} value={formatNumber(activeDevices.length)} />
        <StatCard
          label={t("dashboard.syncHealth")}
          value={activeDevices.length > 0 ? t("dashboard.healthy") : t("dashboard.noDevices")}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label={t("dashboard.bookmarksSynced")} value={stats ? formatNumber(stats.bookmarks) : "…"} />
        <StatCard label={t("dashboard.historySynced")} value={stats ? formatNumber(stats.historyVisits) : "…"} />
        <StatCard label={t("dashboard.tabsSynced")} value={stats ? formatNumber(stats.tabs) : "…"} />
        {stats && <StorageCard usedBytes={stats.storageBytes} limitBytes={stats.storageLimitBytes} />}
      </div>

      <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5">
        <h2 className="font-medium mb-3">{t("dashboard.recentDevices")}</h2>
        {!devices ? (
          <p className="text-sm text-slate-500">{t("common.loading")}</p>
        ) : activeDevices.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t("dashboard.noneRegistered")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-slate-500">
                <th className="py-1 font-normal">{t("common.name")}</th>
                <th className="py-1 font-normal">{t("common.browser")}</th>
                <th className="py-1 font-normal">{t("dashboard.lastSeen")}</th>
              </tr>
            </thead>
            <tbody>
              {activeDevices.slice(0, 5).map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="py-2">{d.name}</td>
                  <td className="py-2 text-slate-500">{d.browser ?? "—"}</td>
                  <td className="py-2 text-slate-500">{timeAgo(d.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
