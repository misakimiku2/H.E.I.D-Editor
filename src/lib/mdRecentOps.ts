/**
 * 上一次使用的格式化命令（纯函数 + localStorage 持久化）：
 * 选区浮动工具条上那个「一键重复」按钮的数据源——用过一次格式菜单后，
 * 按钮就变成那条命令（粗体 / H1 …），再点直接套用；从没用过则不显示。
 *
 * MdOp 是带参数的联合类型，这里压成稳定字符串键存盘（heading:2 / mark:blue），
 * 读回时校验：未知 kind、越界 level、非白名单颜色一律视为没有记录——
 * 避免旧版本或手改过的 localStorage 把非法 op 灌进编辑器。
 */
import type { MdOp } from '../components/MarkdownTools';
import { MARK_COLORS } from './remarkExt';

const STORAGE_KEY = 'heid-recent-md-ops';

/** 无参数的 op.kind（heading / mark 带参数，单独编码） */
const PLAIN_KINDS: readonly MdOp['kind'][] = [
  'paragraph', 'bold', 'italic', 'strike', 'inlineCode',
  'link', 'image', 'sup', 'sub', 'math',
  'quote', 'ul', 'ol', 'task', 'codeBlock',
  'table', 'hr', 'footnote', 'mermaid',
  'tabGroup', 'tabStart', 'tabEnd', 'tabClear',
];

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** op → 存储键：heading 带级别、mark 带颜色，其余用 kind */
export function mdOpKey(op: MdOp): string {
  if (op.kind === 'heading') return `heading:${op.level}`;
  if (op.kind === 'mark') return op.color ? `mark:${op.color}` : 'mark';
  return op.kind;
}

/** 存储键 → op；不认识的键返回 null（调用方丢弃该条） */
export function parseMdOpKey(key: string): MdOp | null {
  if (typeof key !== 'string' || !key) return null;
  const [base, arg] = key.split(':');
  if (base === 'heading') {
    const level = Number(arg);
    return arg !== undefined && Number.isInteger(level) && level >= 1 && level <= 6
      ? { kind: 'heading', level }
      : null;
  }
  if (base === 'mark') {
    if (arg === undefined) return { kind: 'mark' };
    return (MARK_COLORS as readonly string[]).includes(arg) ? { kind: 'mark', color: arg } : null;
  }
  if (arg !== undefined) return null;
  return PLAIN_KINDS.includes(base as MdOp['kind']) ? { kind: base } as MdOp : null;
}

/** 上一次使用的格式化命令；无记录或记录非法时返回 null（工具条据此不显示按钮） */
export function loadLastMdOp(storage: Storage | null = defaultStorage()): MdOp | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === 'string' ? parseMdOpKey(data) : null;
  } catch {
    return null;
  }
}

/** 记录本次使用，并原样返回该命令（调用方直接写进 state，省一次读） */
export function recordMdOp(op: MdOp, storage: Storage | null = defaultStorage()): MdOp {
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(mdOpKey(op)));
    } catch {
      /* 存不下只是下次启动少一个快捷按钮，不影响本次使用 */
    }
  }
  return op;
}
