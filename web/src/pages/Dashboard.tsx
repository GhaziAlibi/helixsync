import { useEffect, useState } from "react";
import * as api from "../api/client";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
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
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const activeDevices = devices?.filter((d) => !d.revokedAt) ?? [];
  const mostRecentSync = activeDevices
    .map((d) => d.lastSeenAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Dashboard</h1>
      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Connection"
          value={version ? "Connected" : "…"}
          sub={version ? `protocol v${version.protocolVersion}` : undefined}
        />
        <StatCard label="Last sync" value={mostRecentSync ? timeAgo(mostRecentSync) : "—"} />
        <StatCard label="Devices" value={activeDevices.length ? String(activeDevices.length) : "0"} />
        <StatCard
          label="Sync health"
          value={activeDevices.length > 0 ? "Healthy" : "No devices"}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        <StatCard label="Bookmarks synced" value={stats ? stats.bookmarks.toLocaleString() : "…"} />
        <StatCard label="History items synced" value={stats ? stats.historyVisits.toLocaleString() : "…"} />
        <StatCard label="Tabs synced" value={stats ? stats.tabs.toLocaleString() : "…"} />
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
        <h2 className="font-medium mb-3">Recent devices</h2>
        {!devices ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : activeDevices.length === 0 ? (
          <p className="text-sm text-slate-500">
            No devices registered yet. Install the HelixSync extension in Helium and connect it to this
            server to get started.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 font-normal">Name</th>
                <th className="py-1 font-normal">Browser</th>
                <th className="py-1 font-normal">Last seen</th>
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
