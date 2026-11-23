import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import * as api from "../../api/client";
import { errorText } from "../../i18n/errors";
import { RulesetTooLargeError } from "../../rulesets/codec";
import {
  DEFAULT_RULESET_NAME,
  createRuleset,
  saveRuleset,
  type DecryptedRuleset,
} from "../../rulesets/service";
import { MAX_NAME_LENGTH, MAX_PATTERN_LENGTH, type Rule, type RuleKind, type RulesetPlaintext } from "../../rulesets/types";
import { checkNewRule, checkRuleset, newRuleId, normalizeRule } from "../../rulesets/validate";
import type { VaultFolder } from "../../vault/types";
import DeviceAssignment from "./DeviceAssignment";
import FolderPicker, { folderLabel } from "./FolderPicker";

export function describeRule(rule: Rule, folders: Map<string, VaultFolder>, t: TFunction): string {
  switch (rule.kind) {
    case "excludeFolder":
    case "includeFolder": {
      const folder = folderLabel(rule.folderId, folders) ?? t("rulesets.unknownFolder");
      return t(rule.kind === "excludeFolder" ? "rulesets.ruleExcludeFolder" : "rulesets.ruleIncludeFolder", { folder });
    }
    case "blockDomain":
      return t("rulesets.ruleBlockDomain", { domain: rule.domain });
    case "blockPattern":
      return t("rulesets.ruleBlockPattern", { pattern: rule.pattern });
    case "blockLocal":
      return t("rulesets.ruleBlockLocal");
  }
}

/** Edits one ruleset: its name, its rules and its devices. `ruleset` is null
 * for a ruleset that doesn't exist yet. */
export default function RulesetEditor({
  ruleset,
  accountKey,
  folders,
  foldersLoading,
  devices,
  onChanged,
  onCreated,
  onDeleted,
  justCreated = false,
}: {
  ruleset: DecryptedRuleset | null;
  accountKey: Uint8Array;
  folders: VaultFolder[];
  foldersLoading: boolean;
  /** Active devices. */
  devices: api.DevicePublic[];
  /** The server changed (saved, assigned): reload the list. */
  onChanged: () => Promise<void>;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  /** Mounted for a ruleset just created in the editor before it: shows "Saved.". */
  justCreated?: boolean;
}) {
  const { t } = useTranslation();
  const isNew = ruleset === null;
  const isDefault = ruleset?.isDefault ?? false;
  const readable = isNew || ruleset.plaintext !== null;

  const [name, setName] = useState(ruleset?.plaintext?.name ?? "");
  const [rules, setRules] = useState<Rule[]>(ruleset?.plaintext?.rules ?? []);
  const [selected, setSelected] = useState<Set<string>>(new Set(ruleset?.deviceIds ?? []));
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState<string | null>(justCreated ? t("rulesets.saved") : null);
  const [busy, setBusy] = useState(false);

  const [kind, setKind] = useState<RuleKind>("blockDomain");
  const [text, setText] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);

  // A different ruleset, or a fresh copy after a save or reload, starts clean.
  useEffect(() => {
    setName(ruleset?.plaintext?.name ?? "");
    setRules(ruleset?.plaintext?.rules ?? []);
    setSelected(new Set(ruleset?.deviceIds ?? []));
    setError(null);
    setConflict(false);
    // Not the status: a save reloads the list, and its "Saved." must stay.
    setText("");
    setRuleError(null);
  }, [ruleset]);

  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const savedRules = ruleset?.plaintext?.rules;
  const rulesDirty = isNew ? rules.length > 0 || name !== "" : JSON.stringify(rules) !== JSON.stringify(savedRules) || (!isDefault && name !== ruleset?.plaintext?.name);
  const devicesDirty = useMemo(() => {
    const saved = new Set(ruleset?.deviceIds ?? []);
    return saved.size !== selected.size || [...selected].some((id) => !saved.has(id));
  }, [ruleset, selected]);

  function addRule(rule: Rule): boolean {
    const problem = checkNewRule(rules, rule);
    if (problem) {
      setRuleError(t(`rulesets.problem.${problem}`));
      return false;
    }
    setRuleError(null);
    setRules([...rules, normalizeRule(rule)]);
    return true;
  }

  function onAddText(e: React.FormEvent) {
    e.preventDefault();
    const rule: Rule =
      kind === "blockPattern"
        ? { id: newRuleId(), kind: "blockPattern", pattern: text }
        : { id: newRuleId(), kind: "blockDomain", domain: text };
    if (addRule(rule)) setText("");
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof api.ApiError && e.code === "revision_conflict") setConflict(true);
      else if (e instanceof RulesetTooLargeError) setError(t("rulesets.problem.tooLarge"));
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function onSave() {
    const plaintext: RulesetPlaintext = { v: 1, name: isDefault ? DEFAULT_RULESET_NAME : name.trim(), rules };
    const problem = checkRuleset(plaintext);
    if (problem) {
      setError(t(`rulesets.problem.${problem}`));
      return;
    }
    void run(async () => {
      if (ruleset) {
        await saveRuleset(accountKey, ruleset, plaintext);
        await onChanged();
      } else {
        const id = await createRuleset(accountKey, plaintext);
        await onChanged();
        onCreated(id);
      }
      setStatus(t("rulesets.saved"));
    });
  }

  function onSaveDevices() {
    if (!ruleset) return;
    void run(async () => {
      await api.setRulesetDevices(ruleset.id, [...selected]);
      await onChanged();
      setStatus(t("rulesets.devicesSaved"));
    });
  }

  function onDelete() {
    if (!ruleset || ruleset.isDefault || !confirm(t("rulesets.deleteConfirm"))) return;
    void run(async () => {
      await api.deleteRuleset(ruleset.id);
      await onChanged();
      onDeleted();
    });
  }

  if (!readable) {
    return (
      <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {t("rulesets.unreadable")}
      </p>
    );
  }

  const field = "rounded border border-slate-300 bg-white px-3 py-2 text-sm";
  const button = "rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60";
  const primary = "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60";

  return (
    <div className="flex flex-col gap-6">
      {conflict && (
        <div role="alert" className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t("rulesets.conflict")}{" "}
          <button type="button" className="font-medium underline" onClick={() => void onChanged()}>
            {t("rulesets.reload")}
          </button>
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
        <label className="mb-1 block text-sm font-medium" htmlFor="ruleset-name">
          {t("common.name")}
        </label>
        {isDefault ? (
          <>
            <div className="text-sm">{t("rulesets.defaultName")}</div>
            <p className="mt-1 text-xs text-slate-500">{t("rulesets.defaultNote")}</p>
          </>
        ) : (
          <input
            id="ruleset-name"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(e) => setName(e.target.value)}
            className={`${field} w-full max-w-md`}
          />
        )}

        <h3 className="mb-2 mt-5 text-sm font-medium">{t("rulesets.rulesHeading")}</h3>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-500">{t("rulesets.noRules")}</p>
        ) : (
          <ul className="rounded border border-slate-200">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-t border-slate-100 px-3 py-2 first:border-t-0">
                <span className="min-w-0 flex-1 break-words text-sm" dir="auto">
                  {describeRule(r, folderMap, t)}
                </span>
                <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>
                  {t("rulesets.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mb-2 mt-5 text-sm font-medium">{t("rulesets.addRule")}</h3>
        <form onSubmit={onAddText} className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as RuleKind);
              setRuleError(null);
            }}
            aria-label={t("rulesets.addRule")}
            className={field}
          >
            <option value="blockDomain">{t("rulesets.kindBlockDomain")}</option>
            <option value="blockPattern">{t("rulesets.kindBlockPattern")}</option>
            <option value="blockLocal">{t("rulesets.kindBlockLocal")}</option>
            <option value="excludeFolder">{t("rulesets.kindFolder")}</option>
          </select>
          {(kind === "blockDomain" || kind === "blockPattern") && (
            <>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={kind === "blockPattern" ? MAX_PATTERN_LENGTH + 1 : 300}
                placeholder={t(kind === "blockPattern" ? "rulesets.patternPlaceholder" : "rulesets.domainPlaceholder")}
                aria-label={t(kind === "blockPattern" ? "rulesets.patternPlaceholder" : "rulesets.domainPlaceholder")}
                dir="ltr"
                className={`${field} min-w-56 flex-1`}
              />
              <button type="submit" className={button}>
                {t("rulesets.add")}
              </button>
            </>
          )}
          {kind === "blockLocal" && (
            <button type="button" className={button} onClick={() => addRule({ id: newRuleId(), kind: "blockLocal" })}>
              {t("rulesets.add")}
            </button>
          )}
        </form>
        {kind === "blockLocal" && <p className="mt-1 text-xs text-slate-500">{t("rulesets.localNote")}</p>}
        {kind === "blockPattern" && <p className="mt-1 text-xs text-slate-500">{t("rulesets.patternNote")}</p>}
        {ruleError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {ruleError}
          </p>
        )}
        {kind === "excludeFolder" && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-slate-500">{t("rulesets.folderNote")}</p>
            <FolderPicker
              folders={folders}
              loading={foldersLoading}
              onPick={(folderId, folderKind) => addRule({ id: newRuleId(), kind: folderKind, folderId })}
            />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onSave} disabled={busy || (!isNew && !rulesDirty)} className={primary}>
            {busy ? t("rulesets.saving") : isNew ? t("rulesets.create") : t("rulesets.save")}
          </button>
          {ruleset && !isDefault && (
            <button type="button" onClick={onDelete} disabled={busy} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60">
              {t("rulesets.deleteRuleset")}
            </button>
          )}
          {status && <span className="text-sm text-emerald-700">{status}</span>}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
      </section>

      {ruleset && (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h3 className="mb-3 text-sm font-medium">{t("rulesets.devicesHeading")}</h3>
          <DeviceAssignment devices={devices} selected={selected} onChange={setSelected} />
          <div className="mt-4">
            <button type="button" onClick={onSaveDevices} disabled={busy || !devicesDirty} className={primary}>
              {t("rulesets.devicesSave")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
