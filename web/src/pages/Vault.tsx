import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api/client";
import UnlockForm from "../components/UnlockForm";
import { errorText } from "../i18n/errors";
import { formatDateTime, formatNumber } from "../i18n/format";
import { lockVault } from "../vault/keyring";
import { loadVault, useUnlocked, useVaultState } from "../vault/store";
import type { VaultBookmark, VaultData, VaultFolder, VaultVisit } from "../vault/types";
import {
  bookmarkPath,
  buildBookmarkTree,
  filterBookmarks,
  filterHistory,
  groupTabs,
  safeHref,
  searchTerms,
  type BookmarkNode,
} from "../vault/view";

type VaultTab = "bookmarks" | "history" | "tabs";

const PAGE_SIZE = 200;

/** A title and address that is a link when the address is a web address. */
function Entry({ title, url, meta }: { title: string; url: string; meta?: string }) {
  const { t } = useTranslation();
  const href = safeHref(url);
  const label = title || url || t("vault.untitled");
  return (
    <div className="min-w-0 flex-1">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate py-1 text-sm font-medium text-slate-900 hover:underline">
          {label}
        </a>
      ) : (
        <span className="block truncate py-1 text-sm font-medium text-slate-900">{label}</span>
      )}
      <div className="truncate text-xs text-slate-500" dir="ltr">
        {url}
      </div>
      {meta && <div className="truncate text-xs text-slate-400">{meta}</div>}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex items-start gap-3 border-t border-slate-100 px-3 py-2 first:border-t-0 sm:px-4">{children}</li>;
}

function Empty({ text }: { text: string }) {
  return <p className="p-5 text-sm text-slate-500">{text}</p>;
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const { t } = useTranslation();
  if (shown >= total) return null;
  return (
    <div className="border-t border-slate-100 p-3 text-center">
      <button onClick={onMore} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
        {t("vault.showMore")} ({formatNumber(total - shown)})
      </button>
    </div>
  );
}

/** Top-level folders open at first, up to this many, so an account with
 * hundreds of them doesn't build every folder's rows at once. */
const OPEN_TOP_LEVEL_FOLDERS = 3;

function FolderNode({
  node,
  depth,
  position,
}: {
  node: Extract<BookmarkNode, { kind: "folder" }>;
  depth: number;
  /** Index among its siblings. */
  position: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(depth === 0 && position < OPEN_TOP_LEVEL_FOLDERS);
  return (
    <li>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-start text-sm font-medium hover:bg-slate-50 sm:px-4"
        style={{ paddingInlineStart: `${0.75 + depth * 1.25}rem` }}
      >
        <span aria-hidden className="w-3 text-slate-400">
          {open ? "▾" : "▸"}
        </span>
        <span className="truncate">{node.folder.title || t("vault.untitled")}</span>
        <span className="text-xs font-normal text-slate-400">{formatNumber(node.children.length)}</span>
      </button>
      {open && <Tree nodes={node.children} depth={depth + 1} />}
    </li>
  );
}

/** One level of the folder tree. A folder with thousands of bookmarks shows
 * the first page and a "show more" button, so opening it doesn't build
 * thousands of rows at once. */
function Tree({ nodes, depth }: { nodes: BookmarkNode[]; depth: number }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  return (
    <>
      <ul>
        {nodes.slice(0, limit).map((node, index) =>
          node.kind === "folder" ? (
            <FolderNode key={node.folder.id} node={node} depth={depth} position={index} />
          ) : (
            <li
              key={node.bookmark.id}
              className="flex items-start gap-3 border-t border-slate-100 py-2 pe-3 sm:pe-4"
              style={{ paddingInlineStart: `${0.75 + depth * 1.25 + 1.25}rem` }}
            >
              <Entry title={node.bookmark.title} url={node.bookmark.url} />
            </li>
          ),
        )}
      </ul>
      <ShowMore shown={limit} total={nodes.length} onMore={() => setLimit(limit + PAGE_SIZE)} />
    </>
  );
}

function BookmarksPanel({ data, terms }: { data: VaultData; terms: string[] }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const tree = useMemo(() => buildBookmarkTree(data.folders, data.bookmarks), [data.folders, data.bookmarks]);
  const folders = useMemo(() => new Map<string, VaultFolder>(data.folders.map((f) => [f.id, f])), [data.folders]);
  const matches = useMemo<VaultBookmark[]>(
    () => (terms.length === 0 ? [] : filterBookmarks(data.bookmarks, terms)),
    [data.bookmarks, terms],
  );

  useEffect(() => setLimit(PAGE_SIZE), [terms]);

  if (data.bookmarks.length === 0) return <Empty text={t("vault.noBookmarks")} />;
  if (terms.length === 0) return <Tree nodes={tree} depth={0} />;
  if (matches.length === 0) return <Empty text={t("vault.noResults")} />;
  return (
    <>
      <ul>
        {matches.slice(0, limit).map((b) => (
          <Row key={b.id}>
            <Entry title={b.title} url={b.url} meta={bookmarkPath(b, folders).join(" / ") || undefined} />
          </Row>
        ))}
      </ul>
      <ShowMore shown={limit} total={matches.length} onMore={() => setLimit(limit + PAGE_SIZE)} />
    </>
  );
}

function HistoryPanel({ history, terms }: { history: VaultVisit[]; terms: string[] }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const matches = useMemo(() => filterHistory(history, terms), [history, terms]);

  useEffect(() => setLimit(PAGE_SIZE), [terms]);

  if (history.length === 0) return <Empty text={t("vault.noHistory")} />;
  if (matches.length === 0) return <Empty text={t("vault.noResults")} />;
  return (
    <>
      <ul>
        {matches.slice(0, limit).map((v, i) => (
          <Row key={`${v.t}-${i}`}>
            <Entry title={v.title} url={v.url} meta={formatDateTime(new Date(v.t))} />
          </Row>
        ))}
      </ul>
      <ShowMore shown={limit} total={matches.length} onMore={() => setLimit(limit + PAGE_SIZE)} />
    </>
  );
}

function TabsPanel({ data, terms, deviceNames }: { data: VaultData; terms: string[]; deviceNames: Map<string, string> }) {
  const { t } = useTranslation();
  const devices = useMemo(() => groupTabs(data, terms), [data, terms]);

  if (data.tabs.length === 0) return <Empty text={t("vault.noTabs")} />;
  if (devices.length === 0) return <Empty text={t("vault.noResults")} />;
  return (
    <div>
      {devices.map((device) => (
        <section key={device.deviceId} className="border-t border-slate-100 first:border-t-0">
          <h3 className="bg-slate-50 px-3 py-2 text-sm font-semibold sm:px-4">
            {deviceNames.get(device.deviceId) ?? t("vault.unknownDevice", { id: device.deviceId.slice(0, 8) })}
          </h3>
          {device.windows.map((win, n) => (
            <div key={win.windowId}>
              <h4 className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-slate-400 sm:px-4">
                {t(win.window?.focused ? "vault.windowFocused" : "vault.window", { n: n + 1 })}
              </h4>
              {win.groups.map((group, g) => (
                <div key={group.group?.id ?? `none-${g}`}>
                  {group.group && (
                    <div className="px-3 pt-2 text-xs font-medium text-slate-600 sm:px-4">
                      {group.group.title || t("vault.unnamedGroup")}
                    </div>
                  )}
                  <ul>
                    {group.tabs.map((tab) => (
                      <Row key={tab.id}>
                        <Entry title={tab.title} url={tab.url} meta={tab.pinned ? t("vault.pinned") : undefined} />
                      </Row>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function VaultView({ data, loadedAt }: { data: VaultData; loadedAt: number }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<VaultTab>("bookmarks");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const terms = useMemo(() => searchTerms(deferred), [deferred]);
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .listDevices()
      .then((devices) => {
        if (!cancelled) setDeviceNames(new Map(devices.map((d) => [d.id, d.name])));
      })
      .catch(() => {
        // Tabs fall back to a short device id.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tabs: Array<{ id: VaultTab; label: string; count: number }> = [
    { id: "bookmarks", label: t("vault.tabBookmarks"), count: data.bookmarks.length },
    { id: "history", label: t("vault.tabHistory"), count: data.history.length },
    { id: "tabs", label: t("vault.tabTabs"), count: data.tabs.length },
  ];

  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">
        {t("vault.readOnly")} {t("vault.loadedAt", { when: formatDateTime(new Date(loadedAt)) })}
      </p>
      {data.unreadable > 0 && (
        <p className="mb-2 text-sm text-amber-800">{t("vault.unreadableNote", { n: formatNumber(data.unreadable) })}</p>
      )}
      {data.incomplete > 0 && (
        <p className="mb-2 text-sm text-amber-800">{t("vault.incompleteNote", { n: formatNumber(data.incomplete) })}</p>
      )}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("vault.searchPlaceholder")}
        aria-label={t("vault.searchPlaceholder")}
        className="mb-3 w-full rounded border border-slate-300 bg-white px-3 py-2 text-base"
      />
      <div role="tablist" className="mb-3 flex gap-1 overflow-x-auto">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`whitespace-nowrap rounded px-3 py-2 text-sm font-medium ${
              tab === item.id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {item.label} <span className="opacity-70">{formatNumber(item.count)}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xs">
        {tab === "bookmarks" && <BookmarksPanel data={data} terms={terms} />}
        {tab === "history" && <HistoryPanel history={data.history} terms={terms} />}
        {tab === "tabs" && <TabsPanel data={data} terms={terms} deviceNames={deviceNames} />}
      </div>
    </div>
  );
}

export default function Vault() {
  const { t } = useTranslation();
  const unlocked = useUnlocked();
  const state = useVaultState();

  // Unlocked with nothing loaded yet (just signed in, or just unlocked).
  useEffect(() => {
    if (unlocked && state.status === "idle") loadVault();
  }, [unlocked, state.status]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("vault.title")}</h1>
        {unlocked && (
          <div className="flex gap-2">
            <button
              onClick={() => loadVault()}
              disabled={state.status === "loading"}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
            >
              {t("vault.refresh")}
            </button>
            <button onClick={lockVault} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
              {t("vault.lock")}
            </button>
          </div>
        )}
      </div>

      {!unlocked ? (
        <UnlockForm />
      ) : state.status === "ready" ? (
        <VaultView data={state.data} loadedAt={state.loadedAt} />
      ) : state.status === "unsupported" ? (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t("vault.unsupported")}
        </p>
      ) : state.status === "error" ? (
        <div>
          <p role="alert" className="mb-3 text-sm text-red-600">
            {errorText(state.error)}
          </p>
          <button onClick={() => loadVault()} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            {t("vault.retry")}
          </button>
        </div>
      ) : (
        <p className="text-sm text-slate-500">{t("vault.loading")}</p>
      )}
    </div>
  );
}
