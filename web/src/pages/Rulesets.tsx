import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import RulesetEditor from "../components/rulesets/RulesetEditor";
import DeviceView from "../components/rulesets/DeviceView";
import UnlockForm from "../components/UnlockForm";
import { errorText } from "../i18n/errors";
import { formatNumber } from "../i18n/format";
import { loadRulesets, ruleCount, type DecryptedRuleset } from "../rulesets/service";
import { getAccountKey } from "../vault/keyring";
import { loadVault, useUnlocked, useVaultState } from "../vault/store";

type Tab = "rulesets" | "devices";
const NEW = "new";

function RulesetsView() {
  const { t } = useTranslation();
  const vault = useVaultState();
  const [rulesets, setRulesets] = useState<DecryptedRuleset[] | null>(null);
  const [devices, setDevices] = useState<api.DevicePublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("rulesets");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The folder picker reads the decrypted bookmarks.
  useEffect(() => {
    if (vault.status === "idle") loadVault();
  }, [vault.status]);

  const reload = useCallback(async () => {
    const key = getAccountKey();
    if (!key) return;
    try {
      const [list, allDevices] = await Promise.all([loadRulesets(key), api.listDevices()]);
      setRulesets(list);
      setDevices(allDevices.filter((d) => !d.revokedAt));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (rulesets && selectedId === null && rulesets.length > 0) setSelectedId(rulesets[0].id);
  }, [rulesets, selectedId]);

  const accountKey = getAccountKey();
  if (error && !rulesets) {
    return (
      <div>
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
        <button onClick={() => void reload()} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
          {t("vault.retry")}
        </button>
      </div>
    );
  }
  if (!rulesets || !accountKey) return <p className="text-sm text-slate-500">{t("common.loading")}</p>;

  const folders = vault.status === "ready" ? vault.data.folders : [];
  const selected = selectedId === NEW ? null : (rulesets.find((r) => r.id === selectedId) ?? null);

  return (
    <div>
      <p className="mb-2 max-w-3xl text-sm text-slate-600">{t("rulesets.intro")}</p>
      <p className="mb-4 max-w-3xl text-xs text-slate-500">{t("rulesets.forwardOnly")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      )}

      <div role="tablist" className="mb-4 flex gap-1">
        {(["rulesets", "devices"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded px-3 py-2 text-sm font-medium ${tab === id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
          >
            {t(id === "rulesets" ? "rulesets.tabRulesets" : "rulesets.tabDevices")}
          </button>
        ))}
      </div>

      {tab === "devices" ? (
        <DeviceView devices={devices} rulesets={rulesets} folders={folders} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div>
            <ul className="mb-3 rounded-lg border border-slate-200 bg-white">
              {rulesets.map((r) => (
                <li key={r.id} className="border-t border-slate-100 first:border-t-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-pressed={r.id === selectedId}
                    className={`block w-full px-4 py-3 text-start hover:bg-slate-50 ${r.id === selectedId ? "bg-slate-100" : ""}`}
                  >
                    <div className="truncate text-sm font-medium">
                      {r.isDefault ? t("rulesets.defaultName") : (r.plaintext?.name ?? t("rulesets.unreadableName"))}
                    </div>
                    <div className="text-xs text-slate-500">
                      {t("rulesets.ruleCount", { n: formatNumber(ruleCount(r)) })} · {t("rulesets.deviceCount", { n: formatNumber(r.deviceIds.length) })}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setSelectedId(NEW)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              {t("rulesets.newRuleset")}
            </button>
          </div>
          <div className="min-w-0">
            {(selectedId === NEW || selected) && (
              <RulesetEditor
                key={selectedId ?? NEW}
                ruleset={selected}
                accountKey={accountKey}
                folders={folders}
                foldersLoading={vault.status === "idle" || vault.status === "loading"}
                devices={devices}
                onChanged={reload}
                onCreated={setSelectedId}
                onDeleted={() => setSelectedId(null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Rulesets() {
  const { t } = useTranslation();
  const unlocked = useUnlocked();
  return (
    <div>
      <h1 className="mb-5 text-2xl font-semibold">{t("rulesets.title")}</h1>
      {unlocked ? <RulesetsView /> : <UnlockForm />}
    </div>
  );
}
