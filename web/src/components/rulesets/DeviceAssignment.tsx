import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DevicePublic } from "../../api/client";
import { formatNumber } from "../../i18n/format";
import { ignoresRulesets } from "../../rulesets/service";

const PAGE_SIZE = 300;

export function matchesDevice(d: DevicePublic, query: string, browser: string, platform: string): boolean {
  if (browser && (d.browser ?? "") !== browser) return false;
  if (platform && (d.platform ?? "") !== platform) return false;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${d.name} ${d.browser ?? ""} ${d.platform ?? ""}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/** Multi-select over the account's active devices, for ~1000 of them: search,
 * filter by browser and platform, select or clear everything shown. */
export default function DeviceAssignment({
  devices,
  selected,
  onChange,
}: {
  devices: DevicePublic[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [browser, setBrowser] = useState("");
  const [platform, setPlatform] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const browsers = useMemo(() => [...new Set(devices.map((d) => d.browser ?? "").filter(Boolean))].sort(), [devices]);
  const platforms = useMemo(() => [...new Set(devices.map((d) => d.platform ?? "").filter(Boolean))].sort(), [devices]);
  const shown = useMemo(
    () => devices.filter((d) => matchesDevice(d, query, browser, platform)),
    [devices, query, browser, platform],
  );

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  function setShown(on: boolean) {
    const next = new Set(selected);
    for (const d of shown) {
      if (on) next.add(d.id);
      else next.delete(d.id);
    }
    onChange(next);
  }

  if (devices.length === 0) return <p className="text-sm text-slate-500">{t("rulesets.noDevices")}</p>;

  const field = "rounded border border-slate-300 bg-white px-2 py-1.5 text-sm";
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE_SIZE);
          }}
          placeholder={t("rulesets.devicesSearch")}
          aria-label={t("rulesets.devicesSearch")}
          className={`${field} min-w-48 flex-1`}
        />
        <select value={browser} onChange={(e) => setBrowser(e.target.value)} aria-label={t("common.browser")} className={field}>
          <option value="">{t("common.browser")}: {t("rulesets.all")}</option>
          {browsers.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label={t("devices.platform")} className={field}>
          <option value="">{t("devices.platform")}: {t("rulesets.all")}</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={() => setShown(true)} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">
          {t("rulesets.selectShown")} ({formatNumber(shown.length)})
        </button>
        <button type="button" onClick={() => setShown(false)} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">
          {t("rulesets.clearShown")}
        </button>
        <span className="text-slate-500">{t("rulesets.selectedCount", { n: formatNumber(selected.size), total: formatNumber(devices.length) })}</span>
      </div>
      <ul className="max-h-80 overflow-y-auto rounded border border-slate-200">
        {shown.slice(0, limit).map((d) => (
          <li key={d.id} className="border-t border-slate-100 first:border-t-0">
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="hidden text-xs text-slate-500 sm:inline">
                {[d.browser, d.platform].filter(Boolean).join(" · ")}
              </span>
              {selected.has(d.id) && ignoresRulesets(d.extensionVersion) && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900" title={t("rulesets.tooOldNote")}>
                  {t("rulesets.tooOld")}
                </span>
              )}
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t("vault.noResults")}</li>}
      </ul>
      {shown.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE_SIZE)}
          className="mt-2 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          {t("vault.showMore")} ({formatNumber(shown.length - limit)})
        </button>
      )}
    </div>
  );
}
