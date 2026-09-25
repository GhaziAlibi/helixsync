import { useEffect, useState } from "react";
import * as api from "../api/client";

export default function Devices() {
  const [devices, setDevices] = useState<api.DevicePublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function load() {
    setLoading(true);
    try {
      setDevices(await api.listDevices());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this device? It will immediately lose sync access.")) return;
    await api.revokeDevice(id);
    await load();
  }

  async function handleRenameSubmit(id: string) {
    await api.renameDevice(id, renameValue);
    setRenamingId(null);
    await load();
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Devices</h1>
      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <p className="p-5 text-sm text-slate-500">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">No devices registered yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-normal">Name</th>
                <th className="px-4 py-2 font-normal">Browser</th>
                <th className="px-4 py-2 font-normal">Platform</th>
                <th className="px-4 py-2 font-normal">Extension</th>
                <th className="px-4 py-2 font-normal">Last seen</th>
                <th className="px-4 py-2 font-normal">Created</th>
                <th className="px-4 py-2 font-normal">Status</th>
                <th className="px-4 py-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    {renamingId === d.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleRenameSubmit(d.id)}
                        onBlur={() => handleRenameSubmit(d.id)}
                        className="border border-slate-300 rounded px-2 py-1 text-sm"
                      />
                    ) : (
                      <button
                        className="hover:underline text-left"
                        onClick={() => {
                          setRenamingId(d.id);
                          setRenameValue(d.name);
                        }}
                      >
                        {d.name}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{d.browser ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{d.platform ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{d.extensionVersion ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{new Date(d.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {d.revokedAt ? (
                      <span className="text-red-600">Revoked</span>
                    ) : (
                      <span className="text-emerald-600">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {!d.revokedAt && (
                      <button
                        className="text-red-600 hover:underline"
                        onClick={() => handleRevoke(d.id)}
                      >
                        Revoke
                      </button>
                    )}
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
