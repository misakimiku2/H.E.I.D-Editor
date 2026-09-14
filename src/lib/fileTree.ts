/**
 * 文件树侧栏：纯树状态（懒加载：目录 children 为 null 表示未加载）+ 目录提供者接口。
 * 平台差异收敛在 DirLister 两个实现里：
 * - 桌面：plugin-dialog 选目录 + plugin-fs readDir（全部动态 import，不进主包）
 * - 安卓：HeidBridge SAF（openTree 选目录 + listTree 列子项，DocumentsContract）
 *   安卓目录 path 采用 `treeUri\x00相对路径` 的不透明标识；文件 path = 可直接打开的 document URI
 */

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  expanded: boolean;
  /** null = 尚未加载过；[] = 加载成功但为空 */
  children: TreeNode[] | null;
  error: string | null;
}

/** 目录优先、同组按名称排序（大小写不敏感，区域设置感知） */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  const cmp = new Intl.Collator(undefined, { sensitivity: 'accent', numeric: true });
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return cmp.compare(a.name, b.name);
  });
}

function pathTail(p: string): string {
  const tail = p.split(/[\\/]/).filter(Boolean).pop();
  return tail || p;
}

export function makeRoot(rootPath: string): TreeNode {
  return { path: rootPath, name: pathTail(rootPath), isDir: true, expanded: true, children: null, error: null };
}

/** 不可变更新：按 path 定位目录节点并应用变换（找不到返回原树） */
function updateNode(node: TreeNode, dirPath: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (node.path === dirPath) return fn(node);
  if (!node.children) return node;
  let changed = false;
  const children = node.children.map(c => {
    const next = updateNode(c, dirPath, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

const toChildNodes = (entries: DirEntry[]): TreeNode[] =>
  sortEntries(entries).map(e => ({
    path: e.path,
    name: e.name,
    isDir: e.isDir,
    expanded: false,
    children: null,
    error: null,
  }));

/** 填充 dirPath 的子节点（排序；目录 children 保持 null 待懒加载） */
export function withChildren(node: TreeNode, dirPath: string, entries: DirEntry[]): TreeNode {
  return updateNode(node, dirPath, n => ({ ...n, children: toChildNodes(entries), error: null }));
}

export function withError(node: TreeNode, dirPath: string, message: string): TreeNode {
  return updateNode(node, dirPath, n => ({ ...n, error: message, children: n.children ?? null }));
}

/** 展开/收起；收起保留已加载 children（再次展开不重复 I/O） */
export function toggleDir(node: TreeNode, dirPath: string): TreeNode {
  return updateNode(node, dirPath, n => ({ ...n, expanded: !n.expanded }));
}

/** tab 路径是否位于 root 下（根自身也算在根下）；桌面绝对路径与 SAF URI 通用前缀匹配 */
export function isUnderRoot(tabPath: string, root: string): boolean {
  if (tabPath === root) return true;
  return tabPath.startsWith(root.endsWith('/') || root.endsWith('\\') ? root : root + '/');
}

/* ---------- 目录提供者接口与平台实现 ---------- */

export interface DirLister {
  /** 打开系统目录选择器；取消返回 null。桌面=绝对路径，安卓=SAF tree URI */
  chooseRoot(): Promise<string | null>;
  /** 列出目录子项；失败抛错（信息展示在节点上） */
  list(dirPath: string): Promise<DirEntry[]>;
  /** 根目录显示名（tree URI 取尾段并去掉 storage 前缀） */
  displayName(rootPath: string): string;
}

const SAF_SEP = '\u0000';

/** 安卓 SAF：目录 path = `treeUri\x00相对路径`；文件 path = document URI（可直接 openPathIntoTab） */
export const safDirLister: DirLister = {
  async chooseRoot() {
    const bridge = (window as any).HeidBridge;
    if (!bridge?.openTree) return null;
    return new Promise<string | null>(resolve => {
      const timeout = setTimeout(() => { window.removeEventListener('heid-saf', handler); resolve(null); }, 120_000);
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<{ kind: string; canceled?: boolean; path?: string | null }>).detail;
        if (detail?.kind !== 'tree') return;
        clearTimeout(timeout);
        window.removeEventListener('heid-saf', handler);
        resolve(detail.canceled ? null : (detail.path ?? null));
      };
      window.addEventListener('heid-saf', handler);
      bridge.openTree();
    });
  },
  async list(dirPath) {
    const bridge = (window as any).HeidBridge;
    if (!bridge?.listTree) throw new Error('SAF bridge unavailable');
    const sepIdx = dirPath.indexOf(SAF_SEP);
    const treeUri = sepIdx >= 0 ? dirPath.slice(0, sepIdx) : dirPath;
    const relPath = sepIdx >= 0 ? dirPath.slice(sepIdx + 1) : '';
    const raw = bridge.listTree(treeUri, relPath);
    const items: Array<{ name: string; isDir: boolean; uri: string }> = JSON.parse(raw);
    return items.map(it => ({
      name: it.name,
      isDir: it.isDir,
      path: it.isDir ? `${treeUri}${SAF_SEP}${relPath ? relPath + '/' : ''}${it.name}` : it.uri,
    }));
  },
  displayName(rootPath) {
    try {
      const seg = decodeURIComponent(rootPath.split('/').pop() ?? rootPath);
      return seg.replace(/^primary:/, '').replace(/^[^:]+:/, '') || rootPath;
    } catch {
      return rootPath;
    }
  },
};

/** 桌面 Tauri：dialog 选目录 + plugin-fs readDir */
export const tauriDirLister: DirLister = {
  async chooseRoot() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === 'string' ? selected : null;
  },
  async list(dirPath) {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const raw = await readDir(dirPath);
    return raw.map(it => ({
      name: it.name,
      isDir: it.isDirectory,
      path: joinPath(dirPath, it.name),
    }));
  },
  displayName(rootPath) {
    return pathTail(rootPath);
  },
};

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

/** 当前运行环境的目录提供者；浏览器（无 Tauri）返回 null */
export function getDirLister(isTauri: boolean, isAndroidApp: boolean): DirLister | null {
  if (isAndroidApp) return safDirLister;
  if (isTauri) return tauriDirLister;
  return null;
}

/* ---------- 根目录记忆（localStorage）：启动零 I/O，抽屉本身每次启动保持关闭 ---------- */

const TREE_ROOT_KEY = 'heid-tree-root';

export function loadTreeRoot(storage: Storage | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(TREE_ROOT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveTreeRoot(path: string | null, storage: Storage | null = defaultStorage()): void {
  try {
    if (path) storage?.setItem(TREE_ROOT_KEY, path);
    else storage?.removeItem(TREE_ROOT_KEY);
  } catch { /* 忽略持久化失败 */ }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
