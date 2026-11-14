import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import { formatBytes } from "../util/format-bytes";
import { errorText } from "../i18n/errors";
import { formatDateTime } from "../i18n/format";

const EVENT_STYLE: Record<api.BackupEvent["event"], string> = {
  completed: "text-green-700",
  failed: "text-red-600",
  restored: "text-blue-700",
};

export default function Backups() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<api.BackupStatus | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const version = await api.getServerVersion();
      if (version.backups !== true) {
        setSupported(false);
        return;
      }
      setStatus(await api.getBackupStatus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <p className="text-sm text-slate-500">{t("common.loading")}</p>;

  if (!supported) {
    return (
      <div>
        <h1 className="text-2xl font-semibold mb-6">{t("backups.title")}</h1>
        <p className="text-sm text-slate-500">{t("backups.unsupported")}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-semibold">{t("backups.title")}</h1>
        <button
          className="text-sm text-slate-700 hover:underline"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          {t("backups.refresh")}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-6">{t("backups.intro")}</p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {status && !status.enabled && (
        <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 text-sm text-slate-600">
          {t("backups.off")}
        </div>
      )}

      {status?.enabled && (
        <>
          <div className="bg-white rounded-lg shadow-xs border border-slate-200 p-5 mb-6 grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">{t("backups.schedule")}</div>
              <div dir="ltr" className="text-sm mt-1 font-mono text-start">{t("backups.cronValue", { cron: status.cron })}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">{t("backups.nextRun")}</div>
              <div className="text-sm mt-1">{status.nextRunAt ? formatDateTime(status.nextRunAt) : "–"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">{t("backups.keepLast")}</div>
              <div className="text-sm mt-1">{status.keepLast}</div>
            </div>
          </div>

          <h2 className="text-lg font-semibold mb-3">{t("backups.recentTitle")}</h2>
          <div className="bg-white rounded-lg shadow-xs border border-slate-200 overflow-hidden mb-8">
            {status.files.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">{t("backups.noFiles")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-start text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-normal">{t("backups.created")}</th>
                    <th className="px-4 py-2 font-normal">{t("backups.kindColumn")}</th>
                    <th className="px-4 py-2 font-normal">{t("backups.size")}</th>
                    <th className="px-4 py-2 font-normal">{t("backups.file")}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.files.map((f) => (
                    <tr key={f.name} className="border-t border-slate-100">
                      <td className="px-4 py-3">{formatDateTime(f.createdAt)}</td>
                      <td className="px-4 py-3 text-slate-500">{t(`backups.kind.${f.kind}`, { defaultValue: f.kind })}</td>
                      <td className="px-4 py-3 text-slate-500">{formatBytes(f.sizeBytes)}</td>
                      <td className="px-4 py-3 text-slate-400 font-mono text-xs break-all">{f.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2 className="text-lg font-semibold mb-3">{t("backups.historyTitle")}</h2>
          <div className="bg-white rounded-lg shadow-xs border border-slate-200 overflow-hidden">
            {status.history.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">{t("backups.noHistory")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-start text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-normal">{t("backups.time")}</th>
                    <th className="px-4 py-2 font-normal">{t("backups.result")}</th>
                    <th className="px-4 py-2 font-normal">{t("backups.kindColumn")}</th>
                    <th className="px-4 py-2 font-normal">{t("backups.size")}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.history.map((h, i) => (
                    <tr key={`${h.at}-${i}`} className="border-t border-slate-100">
                      <td className="px-4 py-3">{formatDateTime(h.at)}</td>
                      <td className={`px-4 py-3 font-medium ${EVENT_STYLE[h.event] ?? ""}`}>
                        {t(`backups.event.${h.event}`, { defaultValue: h.event })}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {h.kind ? t(`backups.kind.${h.kind}`, { defaultValue: h.kind }) : "–"}
                      </td>
                      <td className="px-4 py-3 text-slate-500">{h.bytes != null ? formatBytes(h.bytes) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {status.history.some((h) => h.event === "failed") && (
            <p className="text-xs text-slate-400 mt-3">{t("backups.failedHelp")}</p>
          )}
        </>
      )}
    </div>
  );
}
