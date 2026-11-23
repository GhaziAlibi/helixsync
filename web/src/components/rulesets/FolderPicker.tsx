import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/format";
import type { VaultFolder } from "../../vault/types";

const PAGE_SIZE = 100;

/** Folder names from the top down to `folder`, as one line. */
export function folderLabel(folderId: string, folders: Map<string, VaultFolder>): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = folders.get(folderId);
  if (!current) return null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.title);
    current = current.parent === null ? undefined : folders.get(current.parent);
  }
  return names.join(" / ");
}

/** Picks a bookmark folder from the decrypted Vault. A rule keeps the folder's
 * objectId, so it survives a rename or a move. */
export default function FolderPicker({
  folders,
  loading,
  onPick,
}: {
  folders: VaultFolder[];
  loading: boolean;
  onPick: (folderId: string, kind: "excludeFolder" | "includeFolder") => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const entries = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    return folders
      .map((f) => ({ id: f.id, label: folderLabel(f.id, byId) ?? f.title }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [folders]);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => terms.every((term) => e.label.toLowerCase().includes(term)));

  if (loading) return <p className="text-sm text-slate-500">{t("rulesets.foldersLoading")}</p>;
  if (entries.length === 0) return <p className="text-sm text-slate-500">{t("rulesets.noFolders")}</p>;

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setLimit(PAGE_SIZE);
        }}
        placeholder={t("rulesets.folderSearch")}
        aria-label={t("rulesets.folderSearch")}
        className="mb-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
      />
      <ul className="max-h-64 overflow-y-auto rounded border border-slate-200">
        {shown.slice(0, limit).map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2 first:border-t-0">
            <span className="min-w-0 flex-1 truncate text-sm" title={e.label}>
              {e.label || t("vault.untitled")}
            </span>
            <button
              type="button"
              onClick={() => onPick(e.id, "excludeFolder")}
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
            >
              {t("rulesets.folderExclude")}
            </button>
            <button
              type="button"
              onClick={() => onPick(e.id, "includeFolder")}
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
            >
              {t("rulesets.folderInclude")}
            </button>
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
