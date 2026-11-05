// An in-memory stand-in for chrome.bookmarks, with Chromium's tree semantics
// (ids, ordering, `move` index meaning, removeTree) so restore tests can run
// the real bookmark code end to end. Events are not emitted: the code under
// test mutates through its suppression guard anyway.
interface FakeNode {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  children: string[];
}

type Tree = chrome.bookmarks.BookmarkTreeNode;
type Listener = { addListener: () => void };

export interface FakeBookmarksApi {
  getTree(): Promise<Tree[]>;
  get(id: string | string[]): Promise<Tree[]>;
  getChildren(id: string): Promise<Tree[]>;
  getSubTree(id: string): Promise<Tree[]>;
  create(details: { parentId: string; title?: string; url?: string; index?: number }): Promise<Tree>;
  update(id: string, changes: { title?: string; url?: string }): Promise<Tree>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<Tree>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
  onCreated: Listener;
  onRemoved: Listener;
  onChanged: Listener;
  onMoved: Listener;
}

export interface FakeBookmarks {
  api: FakeBookmarksApi;
  /** Adds a node directly, as the user would; returns its Chromium id. */
  add(parentId: string, title: string, url?: string, index?: number): string;
  remove(id: string): void;
  has(id: string): boolean;
  /** Titles of a folder's children, in order. */
  titles(parentId: string): string[];
  childIds(parentId: string): string[];
  find(parentId: string, title: string): string | undefined;
  count(): number;
}

export function createFakeBookmarks(): FakeBookmarks {
  const nodes = new Map<string, FakeNode>();
  let nextId = 10;
  nodes.set("0", { id: "0", title: "", children: ["1", "2", "3"] });
  nodes.set("1", { id: "1", title: "Bookmarks bar", parentId: "0", children: [] });
  nodes.set("2", { id: "2", title: "Other bookmarks", parentId: "0", children: [] });
  nodes.set("3", { id: "3", title: "Mobile bookmarks", parentId: "0", children: [] });

  const must = (id: string): FakeNode => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Can't find bookmark for id ${id}.`);
    return node;
  };
  const view = (node: FakeNode, withChildren: boolean): chrome.bookmarks.BookmarkTreeNode => {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    const out: Record<string, unknown> = {
      id: node.id,
      title: node.title,
      syncing: false,
      ...(node.url !== undefined ? { url: node.url } : {}),
      ...(node.parentId !== undefined ? { parentId: node.parentId, index: parent!.children.indexOf(node.id) } : {}),
    };
    if (withChildren && node.url === undefined) out.children = node.children.map((c) => view(must(c), true));
    return out as unknown as chrome.bookmarks.BookmarkTreeNode;
  };
  const detach = (node: FakeNode) => {
    const parent = must(node.parentId!);
    parent.children.splice(parent.children.indexOf(node.id), 1);
  };
  const dropSubtree = (id: string) => {
    for (const child of must(id).children) dropSubtree(child);
    nodes.delete(id);
  };
  const add = (parentId: string, title: string, url?: string, index?: number): string => {
    const parent = must(parentId);
    const id = String(nextId++);
    nodes.set(id, { id, title, ...(url !== undefined ? { url } : {}), parentId, children: [] });
    parent.children.splice(index ?? parent.children.length, 0, id);
    return id;
  };

  const api: FakeBookmarksApi = {
    getTree: async () => [view(must("0"), true)],
    get: async (id: string | string[]) => (Array.isArray(id) ? id : [id]).map((i) => view(must(i), false)),
    getChildren: async (id: string) => must(id).children.map((c) => view(must(c), false)),
    getSubTree: async (id: string) => [view(must(id), true)],
    create: async (details: { parentId: string; title?: string; url?: string; index?: number }) => {
      const id = add(details.parentId, details.title ?? "", details.url, details.index);
      return view(must(id), false);
    },
    update: async (id: string, changes: { title?: string; url?: string }) => {
      const node = must(id);
      if (changes.title !== undefined) node.title = changes.title;
      if (changes.url !== undefined) node.url = changes.url;
      return view(node, false);
    },
    move: async (id: string, destination: { parentId?: string; index?: number }) => {
      const node = must(id);
      const parentId = destination.parentId ?? node.parentId!;
      const oldParent = must(node.parentId!);
      const oldIndex = oldParent.children.indexOf(id);
      let index = destination.index ?? must(parentId).children.length;
      // Chromium reads the index as if the node were still where it was.
      if (parentId === node.parentId && index > oldIndex) index -= 1;
      detach(node);
      node.parentId = parentId;
      must(parentId).children.splice(index, 0, id);
      return view(node, false);
    },
    remove: async (id: string) => {
      const node = must(id);
      if (node.children.length > 0) throw new Error("Can't remove non-empty folder (use removeTree instead).");
      detach(node);
      nodes.delete(id);
    },
    removeTree: async (id: string) => {
      const node = must(id);
      detach(node);
      dropSubtree(id);
    },
    onCreated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onChanged: { addListener: () => {} },
    onMoved: { addListener: () => {} },
  };

  return {
    api,
    add,
    remove: (id) => {
      detach(must(id));
      dropSubtree(id);
    },
    has: (id) => nodes.has(id),
    titles: (parentId) => must(parentId).children.map((c) => must(c).title),
    childIds: (parentId) => [...must(parentId).children],
    find: (parentId, title) => must(parentId).children.find((c) => must(c).title === title),
    count: () => nodes.size - 4,
  };
}

/** A chrome.storage area backed by a Map. */
export function createFakeStorageArea() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (keys?: string | string[]) => {
      const list = keys === undefined ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (store.has(key)) out[key] = store.get(key);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  };
}
