import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { DevicePublic } from "../../api/client";
import { formatNumber } from "../../i18n/format";
import { findBlockingRule, ignoresRulesets, rulesetsOfDevice, type DecryptedRuleset } from "../../rulesets/service";
import type { VaultFolder } from "../../vault/types";
import { matchesDevice } from "./DeviceAssignment";
import { describeRule } from "./RulesetEditor";

function rulesetTitle(r: DecryptedRuleset, t: TFunction): string {
  return r.isDefault ? t("rulesets.defaultName") : (r.plaintext?.name ?? t("rulesets.unreadableName"));
}

/** Per device: which rulesets it is in, and a box to test which rule (and
 * ruleset) blocks an address on it. */
export default function DeviceView({
  devices,
  rulesets,
  folders,
}: {
  devices: DevicePublic[];
  rulesets: DecryptedRuleset[];
  folders: VaultFolder[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [tested, setTested] = useState<string | null>(null);

  const shown = useMemo(() => devices.filter((d) => matchesDevice(d, query, "", "")), [devices, query]);
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const device = devices.find((d) => d.id === selectedId) ?? null;
  const inRulesets = device ? rulesetsOfDevice(device.id, rulesets) : [];
  const result = device && tested !== null ? findBlockingRule(tested, device.id, rulesets) : null;

  if (devices.length === 0) return <p className="text-sm text-slate-500">{t("rulesets.noDevices")}</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("rulesets.devicesSearch")}
          aria-label={t("rulesets.devicesSearch")}
          className="mb-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <ul className="max-h-[32rem] overflow-y-auto rounded border border-slate-200 bg-white">
          {shown.slice(0, 300).map((d) => {
            const count = rulesetsOfDevice(d.id, rulesets).length;
            return (
              <li key={d.id} className="border-t border-slate-100 first:border-t-0">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(d.id);
                    setTested(null);
                  }}
                  aria-pressed={d.id === selectedId}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-start text-sm hover:bg-slate-50 ${d.id === selectedId ? "bg-slate-100" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  {ignoresRulesets(d.extensionVersion) && count > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{t("rulesets.tooOld")}</span>
                  )}
                  <span className="text-xs text-slate-500">{formatNumber(count)}</span>
                </button>
              </li>
            );
          })}
          {shown.length > 300 && <li className="px-3 py-2 text-xs text-slate-500">{t("rulesets.refineSearch")}</li>}
          {shown.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t("vault.noResults")}</li>}
        </ul>
      </div>

      <div>
        {!device ? (
          <p className="text-sm text-slate-500">{t("rulesets.pickDevice")}</p>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
            <h3 className="mb-1 text-base font-semibold">{device.name}</h3>
            <p className="mb-3 text-xs text-slate-500">
              {[device.browser, device.platform, device.extensionVersion && `v${device.extensionVersion}`].filter(Boolean).join(" · ")}
            </p>
            {ignoresRulesets(device.extensionVersion) && inRulesets.length > 0 && (
              <p role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {t("rulesets.tooOldNote")}
              </p>
            )}
            <h4 className="mb-1 text-sm font-medium">{t("rulesets.deviceRulesets")}</h4>
            {inRulesets.length === 0 ? (
              <p className="text-sm text-slate-500">{t("rulesets.notInAny")}</p>
            ) : (
              <ul className="mb-4 flex flex-col gap-2">
                {inRulesets.map((r) => (
                  <li key={r.id} className="rounded border border-slate-200 px-3 py-2 text-sm">
                    <div className="font-medium">{rulesetTitle(r, t)}</div>
                    <ul className="mt-1 text-xs text-slate-600" dir="auto">
                      {(r.plaintext?.rules ?? []).map((rule) => (
                        <li key={rule.id} className="break-words">
                          {describeRule(rule, folderMap, t)}
                        </li>
                      ))}
                      {(r.plaintext?.rules.length ?? 0) === 0 && <li>{t("rulesets.noRules")}</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            )}

            <h4 className="mb-1 text-sm font-medium">{t("rulesets.testHeading")}</h4>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) setTested(url);
              }}
              className="flex flex-wrap gap-2"
            >
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("rulesets.testPlaceholder")}
                aria-label={t("rulesets.testPlaceholder")}
                dir="ltr"
                className="min-w-48 flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              />
              <button type="submit" className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                {t("rulesets.testButton")}
              </button>
            </form>
            {tested !== null && (
              <p role="status" className={`mt-2 text-sm ${result ? "text-red-700" : "text-emerald-700"}`}>
                {result
                  ? t("rulesets.testBlocked", { rule: describeRule(result.rule, folderMap, t), ruleset: rulesetTitle(result.ruleset, t) })
                  : t("rulesets.testAllowed")}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500">{t("rulesets.testFolderNote")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
