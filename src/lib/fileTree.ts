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

/** 目录路径与子项名拼接（沿用根路径已有的分隔符风格） */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

/** 新建/重命名条目名校验：非空、不含路径分隔与 Windows 保留字符、不以空格或点结尾 */
export function isValidEntryName(name: string): boolean {
  if (!name || name !== name.trim() || /[\\/:*?"<>|]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (/[. ]$/.test(name)) return false;
  return true;
}

/** 目标目录已存在同名时按「name - 副本 / name - 副本 2…」推导不冲突的名字 */
export function uniqueEntryName(name: string, existing: readonly string[], suffix: string): string {
  const names = new Set(existing);
  if (!names.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${stem} - ${suffix}${ext}` : `${stem} - ${suffix} ${i}${ext}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** 绝对路径转相对根目录的显示路径；不在根下时原样返回 */
export function relativePathUnderRoot(path: string, root: string): string {
  const normRoot = root.replace(/[\\/]+$/, '');
  if (!path.startsWith(normRoot)) return path;
  const rest = path.slice(normRoot.length).replace(/^[\\/]+/, '');
  return rest || path;
}

/** 父目录路径（末段剥除；根级路径原样返回） */
export function parentPathOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

/** 按 path 深度查找节点（树内右键/新建定位父目录用） */
export function findNode(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node;
  for (const c of node.children ?? []) {
    const found = findNode(c, path);
    if (found) return found;
  }
  return null;
}

/* ---------- 图片文件判定（文件树图标与点击打开查看器） ---------- */

/** 可直接由 <img>/图片查看器展示的扩展名（与 lib/imageSrc 的 MIME 表一致）。
    SVG 例外：它同时是可编辑的代码，走源码标签页 + 可视化工作台（isSvgPath） */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];

/** 图片文件路径判定；安卓 SAF URI 先解码再取扩展名 */
export function isImagePath(path: string): boolean {
  let p = path;
  try { p = decodeURIComponent(path); } catch { /* 含孤立 % 时按原文处理 */ }
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.includes(ext);
}

/** SVG 路径判定：按代码文件打开（XML 高亮）并进入可视化编辑工作台 */
export function isSvgPath(path: string): boolean {
  let p = path;
  try { p = decodeURIComponent(path); } catch { /* 含孤立 % 时按原文处理 */ }
  return p.split('.').pop()?.toLowerCase() === 'svg';
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

/* ---------- 侧栏宽度记忆（localStorage）：桌面端拖拽调宽，重启后保留 ---------- */

const TREE_SIDEBAR_WIDTH_KEY = 'heid-tree-sidebar-width';

/** 默认宽度 = 最小宽度（原 w-64 的 256px），拖拽上限 400px */
export const TREE_SIDEBAR_MIN_WIDTH = 256;
export const TREE_SIDEBAR_MAX_WIDTH = 400;

/** 收敛到 [256, 400] 并取整 */
export function clampTreeSidebarWidth(width: number): number {
  return Math.min(TREE_SIDEBAR_MAX_WIDTH, Math.max(TREE_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function loadTreeSidebarWidth(storage: Storage | null = defaultStorage()): number {
  try {
    const raw = storage?.getItem(TREE_SIDEBAR_WIDTH_KEY) ?? null;
    const parsed = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) return clampTreeSidebarWidth(parsed);
  } catch { /* 忽略持久化失败 */ }
  return TREE_SIDEBAR_MIN_WIDTH;
}

export function saveTreeSidebarWidth(width: number, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(TREE_SIDEBAR_WIDTH_KEY, String(clampTreeSidebarWidth(width)));
  } catch { /* 忽略持久化失败 */ }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
