/**
 * JSON / YAML 结构化视图纯函数层：解析、格式化（缩进规范化）、通用节点树构建。
 * JSON 用原生 JSON.parse；YAML 动态 import js-yaml（懒加载 chunk，不进主包）。
 * 两种格式统一归一为 JsonNode 树供 JsonTreeViewer 渲染；键一律 String 化，
 * 循环引用以 seen 集合截断为占位节点（YAML anchor 理论可产生，JSON 不会）。
 */

export type StructKind = 'json' | 'yaml';

export type JsonNode =
  | { kind: 'object'; key: string; children: JsonNode[] }
  | { kind: 'array'; key: string; children: JsonNode[] }
  | { kind: 'value'; key: string; type: 'string' | 'number' | 'boolean' | 'null'; raw: string };

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** 超过该字符数的文档不提供树视图（解析与建树成本随规模线性增长） */
export const TREE_MAX_CHARS = 2_000_000;

/** 单个对象/数组的直接子节点渲染上限：超出部分折叠提示（展开态才渲染，防御万级子节点） */
export const TREE_CHILD_RENDER_LIMIT = 500;

export function kindFromPath(path: string): StructKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  return null;
}

/** 空白文档 js-yaml 会抛「expected a document」，先行短路 */
const isBlank = (text: string) => text.trim() === '';

export async function parseStructured(text: string, kind: StructKind): Promise<ParseResult> {
  if (kind === 'json') {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  if (isBlank(text)) return { ok: true, value: null };
  const yaml = await import('js-yaml');
  try {
    return { ok: true, value: yaml.load(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 标量展示：字符串保留原文（长串截断由视图层做），undefined（YAML 空值）按 null 记 */
function scalarNode(key: string, v: unknown): JsonNode {
  if (v === null || v === undefined) return { kind: 'value', key, type: 'null', raw: 'null' };
  if (typeof v === 'number') return { kind: 'value', key, type: 'number', raw: String(v) };
  if (typeof v === 'boolean') return { kind: 'value', key, type: 'boolean', raw: String(v) };
  return { kind: 'value', key, type: 'string', raw: String(v) };
}

/** 任意解析产物 → JsonNode 树；根键固定 'root'（视图层不显示） */
export function buildTree(value: unknown): JsonNode {
  return buildNode('root', value, new Set());
}

function buildNode(key: string, value: unknown, seen: Set<object>): JsonNode {
  if (value === null || value === undefined || typeof value !== 'object') {
    return scalarNode(key, value);
  }
  /* 循环引用截断：标出占位而非递归（YAML anchor &alias 同文档引用） */
  if (seen.has(value)) {
    return { kind: 'value', key, type: 'string', raw: '<循环引用>' };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const children = value.map((v, i) => buildNode(String(i), v, new Set(seen)));
    seen.delete(value);
    return { kind: 'array', key, children };
  }
  const children = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => buildNode(k, v, new Set(seen)));
  seen.delete(value);
  return { kind: 'object', key, children };
}

/** 数组/对象子节点的显示键：数组用下标，调用方一般配 count 徽标 */
export function nodeCount(node: JsonNode): number {
  return node.kind === 'object' || node.kind === 'array' ? node.children.length : 0;
}

/**
 * 格式化（缩进规范化）：JSON 按指定缩进 stringify（先解析再序列化，顺带校验）；
 * YAML 固定 2 空格（YAML 规范禁 Tab）。解析失败原样抛出错误文案。
 */
export async function formatStructured(text: string, kind: StructKind, indent: string): Promise<string> {
  if (kind === 'json') {
    const parsed = JSON.parse(text); // 解析失败抛 SyntaxError，由调用方提示
    return JSON.stringify(parsed, null, indent) + '\n';
  }
  if (isBlank(text)) return '';
  const yaml = await import('js-yaml');
  const parsed = yaml.load(text);
  if (parsed === undefined) return '';
  return yaml.dump(parsed, { indent: 2, lineWidth: 120, noRefs: true }) ;
}

/** 格式化默认缩进：设置里空格缩进取宽度，Tab 缩进用制表符 */
export function indentFromSettings(insertSpaces: boolean, tabSize: number): string {
  return insertSpaces ? ' '.repeat(Math.max(2, Math.min(8, tabSize))) : '\t';
}
