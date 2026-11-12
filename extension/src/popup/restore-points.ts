// The "Restore points" view of the popup: list, create, pin, delete, and the
// restore flow (scope, mode, preview, progress). Titles and device names are
// user data, so everything here is built with DOM APIs and textContent, never
// markup. The work happens in the service worker (restore-points/service.ts);
// this only asks and shows.
import type { RestorePointMeta } from "../api/client";
import type { OutboxItem } from "../restore-points/outbox";
import type { RestoreProgress } from "../restore-points/state";
import { formatDateTime, formatNumber, t, tp } from "../i18n";

export interface ViewContext {
  /** Draws the view again from scratch. */
  rerender: () => Promise<void>;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
}

interface ServiceError {
  code: string;
  message: string;
}
type Reply<T> = ({ ok: true } & T) | { ok: false; error: ServiceError };

function kindLabel(kind: string): string {
  const key = `rp_kind_${kind}`;
  const text = t(key);
  return text === key ? kind : text;
}

/** Words for the codes the worker reports. Anything else shows its message. */
export function describeError(error: ServiceError): string {
  switch (error.code) {
    case "bookmarks_not_ready":
      return t("rp_err_bookmarksNotReady");
    case "restore_point_limit":
      return t("rp_err_limit");
    case "restore_point_pin_limit":
      return t("rp_err_pinLimit");
    case "restore_in_progress":
      return t("rp_err_inProgress");
    case "unreadable":
      return t("rp_err_unreadable");
    case "update_needed":
      return t("rp_err_updateNeeded");
    case "offline":
      return t("rp_err_offline");
    case "reauth":
      return t("rp_err_reauth");
    case "sync_failed":
      return t("rp_err_syncFailed");
    case "pre_restore_failed":
      return t("rp_err_preRestoreFailed");
    case "unavailable":
      return t("rp_err_unavailable");
    case "no_answer":
      return t("rp_err_noAnswer");
    default:
      return error.message || t("rp_err_generic");
  }
}

async function ask<T extends object>(message: Record<string, unknown>): Promise<Reply<T>> {
  try {
    const reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | { error?: string } | undefined;
    if (reply && "ok" in reply) return reply;
    return { ok: false, error: { code: "no_answer", message: "The extension did not answer." } };
  } catch (err) {
    return { ok: false, error: { code: "failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; title?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  return node;
}

function button(text: string, className?: string): HTMLButtonElement {
  const node = el("button", { text, className });
  return node;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const digits = bytes < 10 * 1024 ? 1 : 0;
    return `${formatNumber(bytes / 1024, { minimumFractionDigits: digits, maximumFractionDigits: digits })} KB`;
  }
  return `${formatNumber(bytes / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

const formatDate = formatDateTime;

export async function renderRestorePointsView(app: HTMLElement, ctx: ViewContext): Promise<void> {
  app.replaceChildren(el("div", { className: "meta", text: t("rp_loading") }));

  // A restore may be running (or have just finished) from an earlier open.
  const current = await ask<{ progress: RestoreProgress }>({ type: "GET_RESTORE_PROGRESS" });
  if (current.ok && current.progress.phase !== "idle") {
    renderProgress(app, ctx);
    return;
  }

  const listed = await ask<{ available: boolean; automatic: boolean; points: RestorePointMeta[]; pending: OutboxItem[] }>({
    type: "LIST_RESTORE_POINTS",
  });

  const root = el("div");
  root.append(
    el("h2", { className: "view-title", text: t("rp_title") }),
    el("p", { className: "view-subtitle", text: t("rp_subtitle") }),
  );
  app.replaceChildren(root);

  if (!listed.ok) {
    root.append(el("div", { className: "status-message error", text: describeError(listed.error) }));
    return;
  }
  if (!listed.available) {
    root.append(
      el("div", {
        className: "status-message",
        text: t("rp_unavailable"),
      }),
    );
    return;
  }

  const status = el("div", { className: "status-message" });
  const create = button(t("rp_create"), "primary");
  create.addEventListener("click", async () => {
    create.disabled = true;
    create.textContent = t("rp_saving");
    status.className = "status-message";
    status.textContent = "";
    const reply = await ask<{ id: string; uploaded: boolean }>({ type: "CREATE_RESTORE_POINT" });
    if (!reply.ok) {
      status.className = "status-message error";
      status.textContent = describeError(reply.error);
      create.disabled = false;
      create.textContent = t("rp_create");
      return;
    }
    await ctx.rerender();
  });
  root.append(create, status);

  if (!listed.automatic) {
    root.append(
      el("div", {
        className: "meta",
        text: t("rp_autoOff"),
      }),
    );
  }

  const list = el("ul", { className: "item-list restore-points" });
  list.style.maxHeight = "none";
  for (const item of listed.pending) {
    const row = el("li", { className: "item" });
    row.append(
      el("div", { className: "item-title", text: t("rp_uploading", { kind: kindLabel(item.kind) }) }),
      el("div", { className: "item-meta", text: `${formatDate(item.createdAt)} · ${tp("rp_bookmarks", item.bookmarkCount)}` }),
    );
    list.append(row);
  }
  for (const point of listed.points) list.append(renderPointRow(point, app, ctx, status));
  if (listed.points.length === 0 && listed.pending.length === 0) {
    const empty = el("li", { className: "item" });
    empty.append(el("div", { className: "item-meta", text: t("rp_empty") }));
    list.append(empty);
  }
  root.append(el("div", { className: "section-label", text: t("rp_saved") }), list);
}

function renderPointRow(point: RestorePointMeta, app: HTMLElement, ctx: ViewContext, status: HTMLElement): HTMLElement {
  const row = el("li", { className: "item" });
  const title = el("div", { className: "item-title", text: formatDate(point.createdAt) });
  if (point.pinned) {
    const badge = el("span", { text: ` · ${t("rp_pinned")}` });
    badge.style.color = "var(--accent)";
    title.append(badge);
  }
  const meta = el("div", {
    className: "item-meta",
    text: [
      kindLabel(point.kind),
      point.deviceName ?? t("rp_removedDevice"),
      tp("rp_bookmarks", point.bookmarkCount),
      formatSize(point.sizeBytes),
    ].join(" · "),
  });
  const restoredLine = point.lastRestoredAt
    ? el("div", { className: "item-meta", text: t("rp_lastRestored", { date: formatDate(point.lastRestoredAt) }) })
    : undefined;

  const actions = el("div", { className: "auth-actions" });
  actions.style.marginTop = "6px";
  const restore = button(t("rp_restoreEllipsis"), "primary");
  const pin = button(point.pinned ? t("rp_unpin") : t("rp_pin"));
  const remove = button(t("rp_delete"), "danger");
  for (const b of [restore, pin, remove]) {
    b.style.marginTop = "0";
    b.style.padding = "5px";
    b.style.fontSize = "12px";
  }
  actions.append(restore, pin, remove);

  restore.addEventListener("click", () => void renderRestoreFlow(app, ctx, point));
  pin.addEventListener("click", async () => {
    pin.disabled = true;
    const reply = await ask<{ point: RestorePointMeta }>({
      type: "SET_RESTORE_POINT_PINNED",
      pointId: point.id,
      pinned: !point.pinned,
    });
    if (!reply.ok) {
      status.className = "status-message error";
      status.textContent = describeError(reply.error);
      pin.disabled = false;
      return;
    }
    await ctx.rerender();
  });
  remove.addEventListener("click", async () => {
    const confirmed = await ctx.confirm(
      t("rp_deleteConfirm", { date: formatDate(point.createdAt) }),
      t("rp_delete"),
    );
    if (!confirmed) return;
    remove.disabled = true;
    const reply = await ask<{ deleted: true }>({ type: "DELETE_RESTORE_POINT", pointId: point.id });
    if (!reply.ok) {
      status.className = "status-message error";
      status.textContent = describeError(reply.error);
      remove.disabled = false;
      return;
    }
    await ctx.rerender();
  });

  row.append(title, meta);
  if (restoredLine) row.append(restoredLine);
  row.append(actions);
  return row;
}

// --- Restore flow -----------------------------------------------------------

interface FolderInfo {
  id: string;
  title: string;
  parent: string;
}

async function renderRestoreFlow(app: HTMLElement, ctx: ViewContext, point: RestorePointMeta): Promise<void> {
  app.replaceChildren(el("div", { className: "meta", text: t("rp_opening") }));
  const tree = await ask<{ folders: FolderInfo[]; bookmarkCount: number }>({
    type: "GET_RESTORE_POINT_TREE",
    pointId: point.id,
  });

  const root = el("div");
  app.replaceChildren(root);
  root.append(
    el("h2", { className: "view-title", text: t("rp_restoreTitle") }),
    el("p", { className: "view-subtitle", text: t("rp_from", { date: formatDate(point.createdAt) }) }),
  );

  const back = button(t("rp_back"), "ghost");
  back.addEventListener("click", () => void ctx.rerender());

  if (!tree.ok) {
    root.append(el("div", { className: "status-message error", text: describeError(tree.error) }), back);
    return;
  }

  let scope = "all";
  let scopeTitle = "";
  let mode: "merge" | "exact" = "merge";

  // Scope
  const scopeBox = el("fieldset");
  scopeBox.append(el("legend", { text: t("rp_whatToRestore") }));
  const wholeLabel = el("label", { className: "row" });
  const whole = document.createElement("input");
  whole.type = "radio";
  whole.name = "scope";
  whole.checked = true;
  wholeLabel.append(el("span", { className: "row-label", text: t("rp_allBookmarks") }), whole);
  const folderLabel = el("label", { className: "row" });
  const folderRadio = document.createElement("input");
  folderRadio.type = "radio";
  folderRadio.name = "scope";
  folderLabel.append(el("span", { className: "row-label", text: t("rp_oneFolder") }), folderRadio);
  const picker = el("div");
  picker.hidden = true;
  const chosen = el("div", { className: "item-meta" });
  scopeBox.append(wholeLabel, folderLabel, picker, chosen);

  // Mode
  const modeBox = el("fieldset");
  modeBox.append(el("legend", { text: t("rp_how") }));
  const mergeLabel = el("label", { className: "row" });
  const merge = document.createElement("input");
  merge.type = "radio";
  merge.name = "mode";
  merge.checked = true;
  mergeLabel.append(
    el("span", { className: "row-label", text: t("rp_modeMerge") }),
    merge,
  );
  const exactLabel = el("label", { className: "row" });
  const exact = document.createElement("input");
  exact.type = "radio";
  exact.name = "mode";
  exactLabel.append(
    el("span", { className: "row-label", text: t("rp_modeExact") }),
    exact,
  );
  modeBox.append(mergeLabel, exactLabel);

  const previewBox = el("div", { className: "status-message" });
  const previewButton = button(t("rp_preview"));
  const restoreButton = button(t("rp_restoreAction"), "primary");
  restoreButton.disabled = true;
  root.append(scopeBox, modeBox, previewButton, previewBox, restoreButton, back);

  const resetPreview = () => {
    restoreButton.disabled = true;
    previewBox.className = "status-message";
    previewBox.replaceChildren();
  };

  whole.addEventListener("change", () => {
    scope = "all";
    picker.hidden = true;
    chosen.textContent = "";
    resetPreview();
  });
  folderRadio.addEventListener("change", () => {
    picker.hidden = false;
    scope = "";
    chosen.textContent = t("rp_pickFolderBelow");
    resetPreview();
  });
  merge.addEventListener("change", () => {
    mode = "merge";
    resetPreview();
  });
  exact.addEventListener("change", () => {
    mode = "exact";
    resetPreview();
  });

  renderFolderPicker(picker, tree.folders, (folder) => {
    scope = folder.id;
    scopeTitle = folder.title;
    chosen.textContent = t("rp_folder", { name: folder.title || t("rp_untitled") });
    resetPreview();
  });

  previewButton.addEventListener("click", async () => {
    if (scope === "") {
      previewBox.className = "status-message error";
      previewBox.textContent = t("rp_pickFolderFirst");
      return;
    }
    previewButton.disabled = true;
    previewBox.className = "status-message";
    previewBox.textContent = t("rp_working");
    const reply = await ask<{
      counts: { restored: number; updated: number; moved: number; deleted: number; skipped: number };
      sample: { restored: string[]; updated: string[]; moved: string[]; deleted: string[] };
    }>({ type: "PREVIEW_RESTORE", pointId: point.id, mode, scope });
    previewButton.disabled = false;
    if (!reply.ok) {
      previewBox.className = "status-message error";
      previewBox.textContent = describeError(reply.error);
      return;
    }
    previewBox.replaceChildren();
    const { counts, sample } = reply;
    const lines: Array<[string, number, string[]]> = [
      ["rp_previewRestored", counts.restored, sample.restored],
      ["rp_previewUpdated", counts.updated, sample.updated],
      ["rp_previewMoved", counts.moved, sample.moved],
      ["rp_previewDeleted", counts.deleted, sample.deleted],
    ];
    const total = lines.reduce((sum, [, n]) => sum + n, 0);
    if (total === 0) {
      previewBox.textContent = t("rp_nothingToDo");
      return;
    }
    for (const [labelKey, n, titles] of lines) {
      if (n === 0) continue;
      const line = el("div", { text: tp(labelKey, n) });
      line.style.fontWeight = "500";
      previewBox.append(line);
      if (titles.length > 0) {
        const shown = titles.map((title) => title || t("rp_untitled")).join(", ");
        const text = n > titles.length ? t("rp_sampleMore", { titles: shown, more: formatNumber(n - titles.length) }) : shown;
        previewBox.append(el("div", { className: "item-meta", text }));
      }
    }
    if (counts.skipped > 0) {
      previewBox.append(
        el("div", { className: "item-meta", text: tp("rp_skipped", counts.skipped) }),
      );
    }
    restoreButton.disabled = false;
  });

  restoreButton.addEventListener("click", async () => {
    const date = formatDate(point.createdAt);
    const name = scopeTitle || t("rp_untitled");
    const warning =
      mode === "exact"
        ? scope === "all"
          ? t("rp_confirmExactAll", { date })
          : t("rp_confirmExactFolder", { date, name })
        : scope === "all"
          ? t("rp_confirmMergeAll", { date })
          : t("rp_confirmMergeFolder", { date, name });
    if (!(await ctx.confirm(warning, t("rp_restoreAction")))) return;
    restoreButton.disabled = true;
    const reply = await ask<{ started: true }>({ type: "START_RESTORE", pointId: point.id, mode, scope });
    if (!reply.ok) {
      previewBox.className = "status-message error";
      previewBox.textContent = describeError(reply.error);
      restoreButton.disabled = false;
      return;
    }
    renderProgress(app, ctx);
  });
}

// The "closed" arrow points to where the text continues.
function closedArrow(): string {
  return document.documentElement.dir === "rtl" ? "◂" : "▸";
}

/** Folders as a tree, children drawn only when their parent is opened. */
function renderFolderPicker(
  container: HTMLElement,
  folders: FolderInfo[],
  onPick: (folder: FolderInfo) => void,
): void {
  const byParent = new Map<string, FolderInfo[]>();
  const ids = new Set(folders.map((f) => f.id));
  for (const folder of folders) {
    // Folders directly under a built-in root have a parent that isn't listed.
    const key = ids.has(folder.parent) ? folder.parent : "";
    const siblings = byParent.get(key);
    if (siblings) siblings.push(folder);
    else byParent.set(key, [folder]);
  }

  let selected: HTMLElement | undefined;
  const draw = (parentKey: string, into: HTMLElement, depth: number) => {
    const list = el("ul", { className: "item-list" });
    list.style.maxHeight = "160px";
    list.style.margin = "4px 0";
    if (depth > 0) list.style.marginInlineStart = "12px";
    for (const folder of byParent.get(parentKey) ?? []) {
      const item = el("li", { className: "item" });
      const line = el("div", { className: "restore-item" });
      const hasChildren = (byParent.get(folder.id)?.length ?? 0) > 0;
      const toggle = button(hasChildren ? closedArrow() : "·", "ghost");
      toggle.style.width = "22px";
      toggle.style.padding = "0";
      toggle.style.marginTop = "0";
      toggle.disabled = !hasChildren;
      const name = button(folder.title || t("rp_untitled"), "ghost");
      name.style.textAlign = "start";
      name.style.marginTop = "0";
      name.style.padding = "3px 4px";
      line.append(toggle, name);
      item.append(line);
      list.append(item);

      let opened: HTMLElement | undefined;
      toggle.addEventListener("click", () => {
        if (opened) {
          opened.remove();
          opened = undefined;
          toggle.textContent = closedArrow();
          return;
        }
        opened = el("div");
        item.append(opened);
        draw(folder.id, opened, depth + 1);
        toggle.textContent = "▾";
      });
      name.addEventListener("click", () => {
        if (selected) selected.style.background = "";
        selected = item;
        item.style.background = "var(--surface-subtle)";
        onPick(folder);
      });
    }
    into.append(list);
  };
  if ((byParent.get("")?.length ?? 0) === 0) {
    container.append(el("div", { className: "item-meta", text: t("rp_noFolders") }));
    return;
  }
  draw("", container, 0);
}

// --- Progress -----------------------------------------------------------------

const PROGRESS_POLL_MS = 700;

function renderProgress(app: HTMLElement, ctx: ViewContext): void {
  const root = el("div");
  app.replaceChildren(root);
  root.append(el("h2", { className: "view-title", text: t("rp_restoring") }));
  const message = el("p", { className: "view-subtitle" });
  const bar = document.createElement("progress");
  bar.style.width = "100%";
  bar.max = 1;
  bar.value = 0;
  const result = el("div", { className: "status-message" });
  const done = button(t("rp_doneButton"), "primary");
  done.hidden = true;
  // A finished restore stays reported until dismissed here; without this the
  // view would show it again on every open, and Done would loop back to it.
  done.addEventListener("click", async () => {
    await ask({ type: "DISMISS_RESTORE_PROGRESS" });
    await ctx.rerender();
  });
  root.append(message, bar, result, done);

  let stopped = false;
  const tick = async () => {
    if (stopped || !app.contains(root)) return;
    const reply = await ask<{ progress: RestoreProgress }>({ type: "GET_RESTORE_PROGRESS" });
    if (stopped || !app.contains(root)) return;
    if (reply.ok) {
      const p = reply.progress;
      bar.max = Math.max(p.total, 1);
      bar.value = p.applied;
      if (p.phase === "preparing") message.textContent = t("rp_prepare");
      else if (p.phase === "applying") {
        message.textContent = t("rp_applying", { applied: formatNumber(p.applied), total: formatNumber(p.total) });
      } else if (p.phase === "finishing") message.textContent = t("rp_finishing");
      else if (p.phase === "done") {
        stopped = true;
        message.textContent = t("rp_done");
        bar.value = bar.max;
        const c = p.counts;
        result.textContent = c
          ? t("rp_doneCounts", {
              restored: formatNumber(c.restored),
              updated: formatNumber(c.updated),
              moved: formatNumber(c.moved),
              deleted: formatNumber(c.deleted),
            })
          : "";
        done.hidden = false;
        return;
      } else if (p.phase === "error") {
        stopped = true;
        message.textContent = t("rp_stopped");
        result.className = "status-message error";
        result.textContent = p.error ? describeError(p.error) : t("rp_err_generic");
        done.hidden = false;
        return;
      } else if (p.phase === "idle") {
        stopped = true;
        void ctx.rerender();
        return;
      }
    }
    setTimeout(() => void tick(), PROGRESS_POLL_MS);
  };
  void tick();
}
