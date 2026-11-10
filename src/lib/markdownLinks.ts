/**
 * 预览里的本地 Markdown 链接解析：把 [第01章.md](第01章.md) 这类相对地址
 * 按当前文档目录拼成可打开的绝对路径，供链接导航守卫「在新标签页打开」用。
 * 只认本地 Markdown 文件；外链、锚点、网页相对路径一律交给原守卫处理。
 */

const MD_FILE_RE = /\.(?:md|markdown|mdown|mkd)$/i;
/** 带协议的地址（http:、mailto:、data:…）与协议相对地址不按本地文件解析 */
const PROTOCOL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/** Windows 盘符路径不是协议（D:/docs/x.md 的 D: 不能被当成 scheme） */
const DRIVE_RE = /^[a-zA-Z]:[\\/]/;
/** UNC / Unix 绝对路径 */
const ABSOLUTE_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * href → 本地绝对路径；不是本地 Markdown 链接、或相对地址缺少基准目录时返回 null。
 * 百分号编码与 #锚点 / ?查询 会先还原/剥掉，再按文档目录解析 . 与 ..
 */
export function resolveMarkdownLinkPath(href: string, baseDir?: string): string | null {
  let raw = (href ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (!DRIVE_RE.test(raw) && PROTOCOL_RE.test(raw) && !/^file:/i.test(raw)) return null;

  raw = raw.replace(/[?#].*$/, '');
  if (!raw) return null;
  try { raw = decodeURIComponent(raw); } catch { /* 含孤立 % 时保留原样 */ }

  /* file:///C:/x.md → C:/x.md；file://server/share/x.md → UNC \\server\share\x.md */
  let path = raw;
  if (/^file:\/\//i.test(path)) {
    const rest = path.replace(/^file:\/\//i, '');
    path = rest.startsWith('/') ? rest.replace(/^\/+/, '') : `\\\\${rest}`;
  }
  if (!MD_FILE_RE.test(path.split(/[\\/]/).pop() ?? '')) return null;

  const windowsStyle = !!baseDir && baseDir.includes('\\')
    || path.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(path);
  const sep = windowsStyle ? '\\' : '/';
  if (ABSOLUTE_RE.test(path)) {
    /* Windows 文档里的 /chapters/x.md：按当前盘符补全（跨盘请写完整路径） */
    const drive = /^([a-zA-Z]:)[\\/]/.exec(baseDir ?? '');
    if (drive && path.startsWith('/') && !path.startsWith('//')) {
      path = drive[1] + path;
    }
    return normalizePath(path, sep);
  }
  if (!baseDir) return null;
  return normalizePath(`${baseDir.replace(/[\\/]+$/, '')}/${path}`, sep);
}

/** 折叠 . / .. 与重复分隔符；不越过盘符/根目录，保留 UNC 前缀 */
function normalizePath(path: string, sep: string): string {
  const unc = path.startsWith('\\\\');
  const unixAbs = !unc && path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path);
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length > 1 || (out.length === 1 && !/^[A-Za-z]:$/.test(out[0]))) out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return '';
  const joined = out.join(sep);
  if (unc) return `\\\\${joined}`;
  return unixAbs ? sep + joined : joined;
}
