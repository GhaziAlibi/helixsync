import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import { errorText } from "../i18n/errors";
import { formatDate, formatDateTime } from "../i18n/format";

export default function Devices() {
  const { t } = useTranslation();
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
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRevoke(id: string) {
    if (!confirm(t("devices.revokeConfirm"))) return;
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
      <h1 className="text-2xl font-semibold mb-6">{t("devices.title")}</h1>
      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      <div className="bg-white rounded-lg shadow-xs border border-slate-200 overflow-hidden">
        {loading ? (
          <p className="p-5 text-sm text-slate-500">{t("common.loading")}</p>
        ) : devices.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">{t("devices.none")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-slate-500">
              <tr>
                <th className="px-4 py-2 font-normal">{t("common.name")}</th>
                <th className="px-4 py-2 font-normal">{t("common.browser")}</th>
                <th className="px-4 py-2 font-normal">{t("devices.platform")}</th>
                <th className="px-4 py-2 font-normal">{t("devices.extension")}</th>
                <th className="px-4 py-2 font-normal">{t("devices.lastSeen")}</th>
                <th className="px-4 py-2 font-normal">{t("devices.created")}</th>
                <th className="px-4 py-2 font-normal">{t("devices.status")}</th>
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
                        className="hover:underline text-start"
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
                    {d.lastSeenAt ? formatDateTime(d.lastSeenAt) : t("common.never")}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(d.createdAt)}</td>
                  <td className="px-4 py-3">
                    {d.revokedAt ? (
                      <span className="text-red-600">{t("devices.revoked")}</span>
                    ) : (
                      <span className="text-emerald-600">{t("devices.active")}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {!d.revokedAt && (
                      <button
                        className="text-red-600 hover:underline"
                        onClick={() => handleRevoke(d.id)}
                      >
                        {t("common.revoke")}
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
