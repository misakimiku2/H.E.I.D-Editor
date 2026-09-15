/**
 * Mermaid 结构化模型：在「源码 ⇄ 表单模型」之间双向转换，供可视化图表编辑器使用。
 *
 * 覆盖 7 种常用图型：流程图 / 时序图 / 饼图 / XY 统计图 / 甘特图 / 时间线 / 思维导图；
 * 其余图型解析返回 unsupported，由调用方提示用户直接编辑 Markdown 源码。
 *
 * 约定：
 * - 解析只接受能无损表达为模型的语句，无法理解的语句一律「解析失败」而不是猜测，
 *   避免可视化编辑保存后图形语义被悄悄改写。少数与位置无关的高级语句（style /
 *   classDef / axisFormat 等）收进 extras，生成时原样附在末尾；与结构强相关的
 *   （subgraph / Note / loop / alt 等）同样视为不支持。
 * - 表单里的数值 / 列表字段用字符串保存（如 "30, 60"、"A, B"），生成时才规范化为
 *   Mermaid 语法。这样用户输入过程中的半截状态（空值、逗号结尾）不会丢字符。
 */

/* ============================ 公共类型 ============================ */

export type DiagramKind =
  | 'flowchart'
  | 'sequenceDiagram'
  | 'pie'
  | 'xychart-beta'
  | 'gantt'
  | 'timeline'
  | 'mindmap';

/** 可视化编辑器支持的图型（下拉顺序） */
export const DIAGRAM_KINDS: DiagramKind[] = [
  'flowchart',
  'sequenceDiagram',
  'pie',
  'xychart-beta',
  'gantt',
  'timeline',
  'mindmap',
];

export type MermaidModel =
  | FlowModel
  | SeqModel
  | PieModel
  | XyModel
  | GanttModel
  | TimelineModel
  | MindModel;

/** 解析失败：unsupported = 图型不支持；syntax = 某行无法理解 */
export type ParseResult =
  | { ok: true; model: MermaidModel; extras: string[] }
  | { ok: false; reason: 'unsupported' | 'syntax'; kind: string | null; line: number; text: string };

/* ============================ 流程图 ============================ */

/* TB 与 TD 在 Mermaid 里同为「从上到下」，选项只保留 TD；解析到 TB 时归一为 TD（parseDirection） */
export const FLOW_DIRECTIONS = ['TD', 'LR', 'RL', 'BT'] as const;
export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];

export const FLOW_SHAPES = [
  'rect',
  'round',
  'stadium',
  'subroutine',
  'cylinder',
  'circle',
  'diamond',
  'hexagon',
  'asymmetric',
  'parallelogram',
  'parallelogramAlt',
  'trapezoid',
  'trapezoidAlt',
] as const;
export type FlowShape = (typeof FLOW_SHAPES)[number];

/** 形状定界符；同名开定界符依赖闭定界符区分（如 [/…/] 与 [/…\]） */
const FLOW_SHAPE_SYNTAX: Record<FlowShape, [string, string]> = {
  rect: ['[', ']'],
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  asymmetric: ['>', ']'],
  parallelogram: ['[/', '/]'],
  parallelogramAlt: ['[\\', '\\]'],
  trapezoid: ['[/', '\\]'],
  trapezoidAlt: ['[\\', '/]'],
};

/** 解析时形状尝试顺序：开定界符长者优先，歧义形状先试常见写法 */
const FLOW_SHAPE_TRY: FlowShape[] = [
  'subroutine',
  'cylinder',
  'stadium',
  'circle',
  'hexagon',
  'parallelogram',
  'parallelogramAlt',
  'trapezoid',
  'trapezoidAlt',
  'asymmetric',
  'rect',
  'round',
  'diamond',
];

export const FLOW_ARROWS = ['arrow', 'open', 'dottedArrow', 'dotted', 'thickArrow', 'thick'] as const;
export type FlowArrow = (typeof FLOW_ARROWS)[number];

const FLOW_ARROW_SYNTAX: Record<FlowArrow, string> = {
  arrow: '-->',
  open: '---',
  dottedArrow: '-.->',
  dotted: '-.-',
  thickArrow: '==>',
  thick: '===',
};

export interface FlowNode {
  id: string;
  text: string;
  shape: FlowShape;
}
export interface FlowEdge {
  from: string;
  to: string;
  label: string;
  arrow: FlowArrow;
}
export interface FlowModel {
  kind: 'flowchart';
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/* ============================ 时序图 ============================ */

export const SEQ_ARROWS = [
  'solidArrow',
  'dashedArrow',
  'solidOpen',
  'dashedOpen',
  'solidCross',
  'dashedCross',
  'solidAsync',
  'dashedAsync',
] as const;
export type SeqArrow = (typeof SEQ_ARROWS)[number];

const SEQ_ARROW_SYNTAX: Record<SeqArrow, string> = {
  solidArrow: '->>',
  dashedArrow: '-->>',
  solidOpen: '->',
  dashedOpen: '-->',
  solidCross: '-x',
  dashedCross: '--x',
  solidAsync: '-)',
  dashedAsync: '--)',
};

/** 解析用：长 token 优先 */
const SEQ_ARROW_TOKENS: [string, SeqArrow][] = [
  ['-->>', 'dashedArrow'],
  ['->>', 'solidArrow'],
  ['-->', 'dashedOpen'],
  ['--x', 'dashedCross'],
  ['--)', 'dashedAsync'],
  ['->', 'solidOpen'],
  ['-x', 'solidCross'],
  ['-)', 'solidAsync'],
];

export interface SeqParticipant {
  id: string;
  label: string;
  actor: boolean;
}
export interface SeqMessage {
  from: string;
  to: string;
  text: string;
  arrow: SeqArrow;
}
export interface SeqModel {
  kind: 'sequenceDiagram';
  autonumber: boolean;
  participants: SeqParticipant[];
  messages: SeqMessage[];
}

/* ============================ 饼图 ============================ */

export interface PieItem {
  label: string;
  value: string;
}
export interface PieModel {
  kind: 'pie';
  title: string;
  showData: boolean;
  items: PieItem[];
}

/* ============================ XY 统计图 ============================ */

export interface XySeries {
  type: 'line' | 'bar';
  /** 逗号分隔的数值 */
  data: string;
}
export interface XyModel {
  kind: 'xychart-beta';
  title: string;
  xTitle: string;
  /** 逗号分隔的 x 轴标签 */
  xLabels: string;
  yTitle: string;
  yMin: string;
  yMax: string;
  series: XySeries[];
}

/* ============================ 甘特图 ============================ */

export const GANTT_STATUSES = ['', 'done', 'active', 'crit', 'milestone'] as const;
export type GanttStatus = (typeof GANTT_STATUSES)[number];

export interface GanttTask {
  /** 所属 section，空表示无分组；相邻同值合并 */
  section: string;
  name: string;
  /** 任务 id，供 after 引用 */
  id: string;
  /** 开始：日期或 after <id> */
  start: string;
  /** 时长，如 7d */
  duration: string;
  status: GanttStatus;
}
export interface GanttModel {
  kind: 'gantt';
  title: string;
  dateFormat: string;
  tasks: GanttTask[];
}

/* ============================ 时间线 ============================ */

export interface TimelineEntry {
  section: string;
  time: string;
  /** 逗号分隔的事件 */
  events: string;
}
export interface TimelineModel {
  kind: 'timeline';
  title: string;
  entries: TimelineEntry[];
}

/* ============================ 思维导图 ============================ */

export const MIND_SHAPES = ['', 'rect', 'round', 'circle', 'bang', 'hexagon', 'cloud'] as const;
export type MindShape = (typeof MIND_SHAPES)[number];

const MIND_SHAPE_SYNTAX: Record<Exclude<MindShape, ''>, [string, string]> = {
  circle: ['((', '))'],
  bang: ['))', '(('],
  hexagon: ['{{', '}}'],
  rect: ['[', ']'],
  cloud: [')', '('],
  round: ['(', ')'],
};

const MIND_SHAPE_TRY: Exclude<MindShape, ''>[] = ['circle', 'bang', 'hexagon', 'rect', 'cloud', 'round'];

export interface MindNode {
  text: string;
  shape: MindShape;
  children: MindNode[];
}
export interface MindModel {
  kind: 'mindmap';
  root: MindNode;
}

/* ============================ 解析辅助 ============================ */

type Parsed<T> = { ok: true; value: T } | { ok: false; line: number; raw: string };

/** 节点 id：不以 - 结尾（否则 A-->B 会把 -- 吞进 id） */
const ID_SRC = '[A-Za-z0-9_\\u4e00-\\u9fa5](?:[\\w\\u4e00-\\u9fa5.]|-(?=[\\w\\u4e00-\\u9fa5.]))*';
const ID_RE = new RegExp('^' + ID_SRC);

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/** 去引号并还原 mermaid 的 #quot; 转义 */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/#quot;/g, '"');
  }
  return t.replace(/#quot;/g, '"');
}

/** 逗号分隔列表 → 规范化字符串 */
function joinList(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(', ');
}

function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/* ============================ 流程图：解析 ============================ */

interface RawNode {
  id: string;
  text: string;
  shape: FlowShape | null;
  explicit: boolean;
  end: number;
}

function parseFlowNode(src: string, pos: number): RawNode | null {
  const m = ID_RE.exec(src.slice(pos));
  if (!m) return null;
  const id = m[0];
  const afterId = pos + id.length;
  const rest = src.slice(afterId);
  for (const shape of FLOW_SHAPE_TRY) {
    const [open, close] = FLOW_SHAPE_SYNTAX[shape];
    if (!rest.startsWith(open)) continue;
    const body = rest.slice(open.length);
    /* 引号包裹：闭合定界符取 "]，这样文本里的 ] 不会截断 */
    const lead = body.search(/\S/);
    if (lead >= 0 && body[lead] === '"') {
      const endQuote = body.indexOf('"' + close, lead + 1);
      if (endQuote >= 0) {
        const text = unquote(body.slice(lead, endQuote + 1)) || id;
        return { id, text, shape, explicit: true, end: afterId + open.length + endQuote + 1 + close.length };
      }
    }
    const closeAt = body.indexOf(close);
    if (closeAt < 0) continue;
    const text = unquote(body.slice(0, closeAt)) || id;
    return { id, text, shape, explicit: true, end: afterId + open.length + closeAt + close.length };
  }
  return { id, text: id, shape: null, explicit: false, end: afterId };
}

interface RawEdge {
  arrow: FlowArrow;
  label: string;
  end: number;
}

function parseFlowEdge(src: string, pos: number): RawEdge | null {
  const s = src.slice(pos);
  let arrow: FlowArrow | null = null;
  let label = '';
  let len = 0;

  /* 长形式：运算符中夹带文字（A -- 文字 --> B） */
  let m = /^--\s+(.+?)\s+-->/.exec(s);
  if (m) {
    arrow = 'arrow';
    label = m[1].trim();
    len = m[0].length;
  }
  if (!arrow) {
    m = /^-\.\s+(.+?)\s+\.->/.exec(s);
    if (m) {
      arrow = 'dottedArrow';
      label = m[1].trim();
      len = m[0].length;
    }
  }
  if (!arrow) {
    m = /^==\s+(.+?)\s+==>/.exec(s);
    if (m) {
      arrow = 'thickArrow';
      label = m[1].trim();
      len = m[0].length;
    }
  }
  if (!arrow) {
    m = /^--\s+(.+?)\s+---(?!>)/.exec(s);
    if (m) {
      arrow = 'open';
      label = m[1].trim();
      len = m[0].length;
    }
  }

  /* 紧凑形式，长 token 优先 */
  if (!arrow) {
    const tokens: [string, FlowArrow][] = [
      ['--->', 'arrow'],
      ['-.->', 'dottedArrow'],
      ['==>', 'thickArrow'],
      ['-->', 'arrow'],
      ['---', 'open'],
      ['-.-', 'dotted'],
      ['===', 'thick'],
    ];
    for (const [tok, a] of tokens) {
      if (s.startsWith(tok)) {
        arrow = a;
        len = tok.length;
        break;
      }
    }
  }
  if (!arrow) return null;

  /* 内联标签 |文字| */
  const inline = /^\s*\|([^|]*)\|/.exec(s.slice(len));
  if (inline) {
    if (!label) label = inline[1].trim();
    len += inline[0].length;
  }
  return { arrow, label, end: pos + len };
}

function parseFlowLine(line: string): { nodes: RawNode[]; edges: FlowEdge[] } | null {
  const nodes: RawNode[] = [];
  const edges: FlowEdge[] = [];
  let pos = 0;
  const first = parseFlowNode(line, pos);
  if (!first) return null;
  nodes.push(first);
  let prev = first;
  pos = skipWs(line, first.end);
  while (pos < line.length) {
    const e = parseFlowEdge(line, pos);
    if (!e) return null;
    pos = skipWs(line, e.end);
    const n = parseFlowNode(line, pos);
    if (!n) return null;
    nodes.push(n);
    edges.push({ from: prev.id, to: n.id, label: e.label, arrow: e.arrow });
    prev = n;
    pos = skipWs(line, n.end);
  }
  return { nodes, edges };
}

function parseFlowchart(lines: string[]): Parsed<{ model: FlowModel; extras: string[] }> {
  let direction: FlowDirection = 'TD';
  let headSeen = false;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const extras: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (!headSeen) {
      const m = /^(?:flowchart|graph)\b\s*([A-Za-z]{2})?/.exec(line);
      if (m) {
        const d = (m[1] || 'TD').toUpperCase();
        /* TB 是 TD 的旧同义词：归一为 TD，避免模型里出现不在选项里的方向 */
        direction = d === 'TB' ? 'TD'
          : (FLOW_DIRECTIONS as readonly string[]).includes(d) ? (d as FlowDirection)
          : 'TD';
        headSeen = true;
        continue;
      }
    }
    if (line.startsWith('%%')) {
      if (line.startsWith('%%{')) return { ok: false, line: i, raw };
      extras.push(raw);
      continue;
    }
    /* 与结构强相关的语句不支持可视化编辑 */
    if (/^(subgraph|end|direction)\b/i.test(line)) return { ok: false, line: i, raw };
    if (/^(style|classDef|class|linkStyle|click)\b/i.test(line)) {
      extras.push(raw);
      continue;
    }

    const parsed = parseFlowLine(line);
    if (!parsed) return { ok: false, line: i, raw };
    for (const rn of parsed.nodes) {
      const exist = nodes.find((n) => n.id === rn.id);
      if (!exist) nodes.push({ id: rn.id, text: rn.text, shape: rn.shape ?? 'rect' });
      else if (rn.explicit && rn.shape) {
        exist.text = rn.text;
        exist.shape = rn.shape;
      }
    }
    edges.push(...parsed.edges);
  }

  /* 连线端点若从未定义，补一个默认节点 */
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!nodes.some((n) => n.id === id)) nodes.push({ id, text: id, shape: 'rect' });
    }
  }
  return { ok: true, value: { model: { kind: 'flowchart', direction, nodes, edges }, extras } };
}

/* ============================ 时序图：解析 ============================ */

/* 参与者可省略声明直接被消息引用；from/to 用与流程图一致的 id 约束，
   否则 S-->>U 会被贪婪解析成 from=S- + 箭头 ->> */
const SEQ_MSG_RE = new RegExp(
  '^(' + ID_SRC + ')\\s*(-->>|->>|-->|--x|--\\)|->|-x|-\\))\\s*(' + ID_SRC + ')\\s*:\\s*(.*)$',
);

function parseSequence(lines: string[]): Parsed<{ model: SeqModel; extras: string[] }> {
  let headSeen = false;
  let autonumber = false;
  const participants: SeqParticipant[] = [];
  const messages: SeqMessage[] = [];
  const extras: string[] = [];

  const ensure = (id: string) => {
    if (!participants.some((p) => p.id === id)) participants.push({ id, label: id, actor: false });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (!headSeen) {
      if (/^sequenceDiagram\b/.test(line)) {
        headSeen = true;
        continue;
      }
    }
    if (line.startsWith('%%')) {
      if (line.startsWith('%%{')) return { ok: false, line: i, raw };
      extras.push(raw);
      continue;
    }
    if (/^autonumber\b/i.test(line)) {
      autonumber = true;
      continue;
    }
    /* 参与者声明 */
    const pm = /^(participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (pm) {
      const id = pm[2];
      const label = (pm[3] ?? '').trim() || id;
      const exist = participants.find((p) => p.id === id);
      if (exist) {
        exist.label = label;
        exist.actor = /^actor/i.test(pm[1]);
      } else {
        participants.push({ id, label, actor: /^actor/i.test(pm[1]) });
      }
      continue;
    }
    /* 消息 */
    const mm = SEQ_MSG_RE.exec(line);
    if (mm) {
      const arrow = SEQ_ARROW_TOKENS.find(([tok]) => tok === mm[2])?.[1];
      if (!arrow) return { ok: false, line: i, raw };
      ensure(mm[1]);
      ensure(mm[3]);
      messages.push({ from: mm[1], to: mm[3], text: mm[4].trim(), arrow });
      continue;
    }
    return { ok: false, line: i, raw };
  }
  if (!headSeen) return { ok: false, line: 0, raw: lines[0] ?? '' };
  return { ok: true, value: { model: { kind: 'sequenceDiagram', autonumber, participants, messages }, extras } };
}

/* ============================ 饼图：解析 ============================ */

function parsePie(lines: string[]): Parsed<{ model: PieModel; extras: string[] }> {
  let headSeen = false;
  let title = '';
  let showData = false;
  const items: PieItem[] = [];
  const extras: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (!headSeen) {
      if (/^pie\b/i.test(line)) {
        headSeen = true;
        let rest = line.replace(/^pie\b/i, '');
        if (/\bshowData\b/i.test(rest)) {
          showData = true;
          rest = rest.replace(/\bshowData\b/i, '');
        }
        const tm = /title\s+(.+)$/i.exec(rest.trim());
        if (tm) title = unquote(tm[1]);
        continue;
      }
    }
    if (line.startsWith('%%')) {
      extras.push(raw);
      continue;
    }
    const m = /^(?:"([^"]*)"|'([^']*)'|([^:]+?))\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) return { ok: false, line: i, raw };
    items.push({ label: (m[1] ?? m[2] ?? m[3] ?? '').trim(), value: (m[4] ?? '').trim() });
  }
  if (!headSeen) return { ok: false, line: 0, raw: lines[0] ?? '' };
  return { ok: true, value: { model: { kind: 'pie', title, showData, items }, extras } };
}

/* ============================ XY 统计图：解析 ============================ */

function parseXyList(body: string): string {
  return joinList(body.split(','));
}

function parseXychart(lines: string[]): Parsed<{ model: XyModel; extras: string[] }> {
  let headSeen = false;
  const model: XyModel = {
    kind: 'xychart-beta',
    title: '',
    xTitle: '',
    xLabels: '',
    yTitle: '',
    yMin: '',
    yMax: '',
    series: [],
  };
  const extras: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (!headSeen) {
      if (/^xychart-beta\b/i.test(line)) {
        headSeen = true;
        continue;
      }
    }
    if (line.startsWith('%%')) {
      extras.push(raw);
      continue;
    }
    const tm = /^title\s+(.+)$/i.exec(line);
    if (tm) {
      model.title = unquote(tm[1]);
      continue;
    }
    if (/^x-axis\b/i.test(line)) {
      let rest = line.replace(/^x-axis\b/i, '').trim();
      if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1);
        if (end > 0) {
          model.xTitle = rest.slice(1, end);
          rest = rest.slice(end + 1).trim();
        }
      }
      const lb = rest.indexOf('[');
      if (lb >= 0) {
        const rb = rest.lastIndexOf(']');
        rest = rb > lb ? rest.slice(lb + 1, rb) : rest.slice(lb + 1);
      }
      model.xLabels = joinList(rest.split(',').map((x) => unquote(x)));
      continue;
    }
    if (/^y-axis\b/i.test(line)) {
      let rest = line.replace(/^y-axis\b/i, '').trim();
      if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1);
        if (end > 0) {
          model.yTitle = rest.slice(1, end);
          rest = rest.slice(end + 1).trim();
        }
      }
      const rm = /(-?[\d.]+)\s*-->\s*(-?[\d.]+)/.exec(rest);
      if (rm) {
        model.yMin = rm[1];
        model.yMax = rm[2];
      }
      continue;
    }
    const sm = /^(line|bar)\b\s*(?:\[(.*)\])?\s*$/i.exec(line);
    if (sm) {
      model.series.push({ type: sm[1].toLowerCase() as 'line' | 'bar', data: parseXyList(sm[2] ?? '') });
      continue;
    }
    return { ok: false, line: i, raw };
  }
  if (!headSeen) return { ok: false, line: 0, raw: lines[0] ?? '' };
  return { ok: true, value: { model, extras } };
}

/* ============================ 甘特图：解析 ============================ */

const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|d|w|h|m)$/i;

function parseGantt(lines: string[]): Parsed<{ model: GanttModel; extras: string[] }> {
  let headSeen = false;
  let title = '';
  let dateFormat = '';
  let section = '';
  const tasks: GanttTask[] = [];
  const extras: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (!headSeen) {
      if (/^gantt\b/i.test(line)) {
        headSeen = true;
        continue;
      }
    }
    if (line.startsWith('%%')) {
      extras.push(raw);
      continue;
    }
    const tm = /^title\s+(.+)$/i.exec(line);
    if (tm) {
      title = unquote(tm[1]);
      continue;
    }
    const dfm = /^dateFormat\s+(\S+)$/i.exec(line);
    if (dfm) {
      dateFormat = dfm[1];
      continue;
    }
    if (/^(axisFormat|excludes|tickInterval|weekday|todayMarker)\b/i.test(line)) {
      extras.push(raw);
      continue;
    }
    const sm = /^section\s+(.+)$/i.exec(line);
    if (sm) {
      section = sm[1].trim();
      continue;
    }

    /* 任务行：名称 : meta */
    const ci = line.indexOf(':');
    if (ci < 0) return { ok: false, line: i, raw };
    const name = line.slice(0, ci).trim();
    if (!name) return { ok: false, line: i, raw };
    const task: GanttTask = { section, name, id: '', start: '', duration: '', status: '' };
    const toks = line.slice(ci + 1).split(',').map((t) => t.trim()).filter(Boolean);
    for (const tok of toks) {
      if (/^(done|active|crit|milestone)$/i.test(tok)) {
        if (task.status) return { ok: false, line: i, raw }; /* 多个状态标签不猜测 */
        task.status = tok.toLowerCase() as GanttStatus;
        continue;
      }
      const am = /^after\s+(\S+)$/i.exec(tok);
      if (am) {
        task.start = `after ${am[1]}`;
        continue;
      }
      if (DURATION_RE.test(tok)) {
        task.duration = tok;
        continue;
      }
      if (DATE_RE.test(tok)) {
        if (!task.start) task.start = tok;
        else if (!task.duration) task.duration = tok;
        else return { ok: false, line: i, raw };
        continue;
      }
      if (!task.id && /^[A-Za-z][\w-]*$/.test(tok)) {
        task.id = tok;
        continue;
      }
      return { ok: false, line: i, raw };
    }
    tasks.push(task);
  }
  if (!headSeen) return { ok: false, line: 0, raw: lines[0] ?? '' };
  return { ok: true, value: { model: { kind: 'gantt', title, dateFormat, tasks }, extras } };
}

/* ============================ 时间线：解析 ============================ */

function parseTimeline(lines: string[]): Parsed<{ model: TimelineModel; extras: string[] }> {
  let headSeen = false;
  let title = '';
  let section = '';
  const entries: TimelineEntry[] = [];
  const extras: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (!headSeen) {
      if (/^timeline\b/i.test(line)) {
        headSeen = true;
        continue;
      }
    }
    if (line.startsWith('%%')) {
      extras.push(raw);
      continue;
    }
    const tm = /^title\s+(.+)$/i.exec(line);
    if (tm) {
      title = unquote(tm[1]);
      continue;
    }
    const sm = /^section\s+(.+)$/i.exec(line);
    if (sm) {
      section = sm[1].trim();
      continue;
    }
    const parts = /\s:\s/.test(line) ? line.split(/\s+:\s+/) : line.split(':');
    if (parts.length < 2) return { ok: false, line: i, raw };
    const time = parts[0].trim();
    if (!time) return { ok: false, line: i, raw };
    entries.push({ section, time, events: joinList(parts.slice(1)) });
  }
  if (!headSeen) return { ok: false, line: 0, raw: lines[0] ?? '' };
  return { ok: true, value: { model: { kind: 'timeline', title, entries }, extras } };
}

/* ============================ 思维导图：解析 ============================ */

/** 整串是否为一个形状包裹（((x)) / [x] / )x( …） */
function parseMindShapeBody(s: string): { text: string; shape: MindShape } | null {
  for (const shape of MIND_SHAPE_TRY) {
    const [open, close] = MIND_SHAPE_SYNTAX[shape];
    if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length + 1) {
      const text = unquote(s.slice(open.length, s.length - close.length));
      if (text) return { text, shape };
    }
  }
  return null;
}

function parseMindNode(s: string): MindNode | null {
  /* 支持 `root((项目))` 的「id + 形状」写法（id 不参与编辑，丢弃） */
  const idm = ID_RE.exec(s);
  if (idm && idm[0].length < s.length) {
    const body = parseMindShapeBody(s.slice(idm[0].length));
    if (body) return { text: body.text, shape: body.shape, children: [] };
  }
  const whole = parseMindShapeBody(s);
  if (whole) return { text: whole.text, shape: whole.shape, children: [] };
  if (/^[\[\](){}]/.test(s) || !s.trim()) return null;
  return { text: unquote(s), shape: '', children: [] };
}

function parseMindmap(lines: string[]): Parsed<{ model: MindModel; extras: string[] }> {
  let headSeen = false;
  let root: MindNode | null = null;
  const stack: { indent: number; node: MindNode }[] = [];
  const extras: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    if (!headSeen) {
      if (/^mindmap\b/i.test(raw.trim())) {
        headSeen = true;
        continue;
      }
    }
    if (raw.trim().startsWith('%%')) {
      extras.push(raw);
      continue;
    }
    if (/::icon\b|:::/.test(raw)) return { ok: false, line: i, raw };

    const indent = (/^[ \t]*/.exec(raw) ?? [''])[0].replace(/\t/g, '    ').length;
    const node = parseMindNode(raw.trim());
    if (!node) return { ok: false, line: i, raw };

    if (!root) {
      root = node;
      stack.push({ indent, node });
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent || parent.indent >= indent) return { ok: false, line: i, raw };
    parent.node.children.push(node);
    stack.push({ indent, node });
  }
  if (!headSeen || !root) return { ok: false, line: 0, raw: lines[0] ?? '' };
  return { ok: true, value: { model: { kind: 'mindmap', root }, extras } };
}

/* ============================ 顶层解析 ============================ */

export function parseMermaid(code: string): ParseResult {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const head = lines.find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? '';
  if (!head) return { ok: false, reason: 'syntax', kind: null, line: 1, text: '' };

  const run = <T>(r: Parsed<{ model: T; extras: string[] }>): ParseResult =>
    r.ok
      ? { ok: true, model: r.value.model as MermaidModel, extras: r.value.extras }
      : { ok: false, reason: 'syntax', kind: null, line: r.line + 1, text: r.raw };

  if (/^(?:flowchart|graph)\b/i.test(head)) return run(parseFlowchart(lines));
  if (/^sequenceDiagram\b/.test(head)) return run(parseSequence(lines));
  if (/^pie\b/i.test(head)) return run(parsePie(lines));
  if (/^xychart-beta\b/i.test(head)) return run(parseXychart(lines));
  if (/^gantt\b/i.test(head)) return run(parseGantt(lines));
  if (/^timeline\b/i.test(head)) return run(parseTimeline(lines));
  if (/^mindmap\b/i.test(head)) return run(parseMindmap(lines));

  return { ok: false, reason: 'unsupported', kind: /^[A-Za-z][\w-]*/.exec(head)?.[0] ?? null, line: 1, text: head };
}

/* ============================ 生成 ============================ */

function quoteIfNeeded(text: string): string {
  const body = text.replace(/"/g, '#quot;');
  if (/[\[\](){}|]/.test(text) || text.trim() !== text) return `"${body}"`;
  return body;
}

function genFlowNode(n: FlowNode): string {
  const [open, close] = FLOW_SHAPE_SYNTAX[n.shape];
  return n.id + open + quoteIfNeeded(n.text || n.id) + close;
}

function genEdgeLabel(arrow: FlowArrow, label: string): string {
  const base = FLOW_ARROW_SYNTAX[arrow];
  if (!label) return base;
  if (base.startsWith('--') && base.length === 3) return `${base}|${label.replace(/\|/g, '/')}|`;
  if (base === '-.->') return `-. ${label.replace(/\|/g, '/')} .->`;
  if (base === '==>') return `== ${label.replace(/\|/g, '/')} ==`;
  return `${base}|${label.replace(/\|/g, '/')}|`;
}

function genFlowchart(m: FlowModel): string {
  const out = [`flowchart ${m.direction}`];
  for (const n of m.nodes) out.push('    ' + genFlowNode(n));
  for (const e of m.edges) out.push(`    ${e.from} ${genEdgeLabel(e.arrow, e.label)} ${e.to}`);
  return out.join('\n');
}

function genSequence(m: SeqModel): string {
  const out = ['sequenceDiagram'];
  if (m.autonumber) out.push('    autonumber');
  for (const p of m.participants) {
    out.push('    ' + (p.actor ? 'actor' : 'participant') + ' ' + p.id + (p.label && p.label !== p.id ? ` as ${p.label}` : ''));
  }
  for (const msg of m.messages) {
    out.push(`    ${msg.from}${SEQ_ARROW_SYNTAX[msg.arrow]}${msg.to}: ${msg.text}`);
  }
  return out.join('\n');
}

function genPie(m: PieModel): string {
  let head = 'pie';
  if (m.showData) head += ' showData';
  if (m.title) head += ` title ${m.title}`;
  const out = [head];
  for (const it of m.items) {
    if (!it.label && !it.value) continue;
    out.push(`    "${it.label.replace(/"/g, '#quot;')}" : ${it.value || 0}`);
  }
  return out.join('\n');
}

function genXychart(m: XyModel): string {
  const out = ['xychart-beta'];
  if (m.title) out.push(`    title "${m.title.replace(/"/g, '#quot;')}"`);
  /* 标签一律加引号：中文/空格/标点在 xychart 里不加引号会直接报词法错误 */
  const labels = splitList(m.xLabels).map((l) => `"${l.replace(/"/g, '#quot;')}"`);
  if (labels.length) {
    const prefix = m.xTitle ? `"${m.xTitle.replace(/"/g, '#quot;')}" ` : '';
    out.push(`    x-axis ${prefix}[${labels.join(', ')}]`);
  }
  if (m.yTitle || m.yMin || m.yMax) {
    const parts: string[] = [];
    if (m.yTitle) parts.push(`"${m.yTitle.replace(/"/g, '#quot;')}"`);
    if (m.yMin !== '' || m.yMax !== '') parts.push(`${m.yMin || 0} --> ${m.yMax || 0}`);
    out.push('    y-axis ' + parts.join(' '));
  }
  for (const s of m.series) {
    const nums = splitList(s.data);
    if (!nums.length) continue;
    out.push(`    ${s.type} [${nums.join(', ')}]`);
  }
  return out.join('\n');
}

function genGantt(m: GanttModel): string {
  const out = ['gantt'];
  if (m.title) out.push(`    title ${m.title}`);
  if (m.dateFormat) out.push(`    dateFormat ${m.dateFormat}`);
  let section = '';
  let emitted = 0;
  for (const t of m.tasks) {
    if (!t.name.trim()) continue;
    if (t.section !== section) {
      section = t.section;
      if (section) out.push(`    section ${section}`);
    }
    /* mermaid 按「冒号后逗号分隔的 token 数」决定语义：
       1 个 = 接着上一个任务、2 个 = 开始,结束、3 个 = id,开始,结束。
       由此两条硬约束：
       - id 只有 3 token 形式才有位置，没填开始时间时必须丢掉 id，
         否则它会被当成开始时间解析（Invalid date:<id>）；
       - 第一个任务没有「上一个任务」可接（mermaid 会读 undefined.endTime 崩掉），必须给个起点。 */
    const id = t.id.trim();
    let start = t.start.trim();
    if (!start && emitted === 0) start = todayStr();
    const end = t.duration.trim() || '0d';
    const body = id && start ? `${id}, ${start}, ${end}` : start ? `${start}, ${end}` : end;
    out.push(`    ${t.name} : ${t.status ? `${t.status}, ` : ''}${body}`);
    emitted += 1;
  }
  return out.join('\n');
}

function genTimeline(m: TimelineModel): string {
  const out = ['timeline'];
  if (m.title) out.push(`    title ${m.title}`);
  let section = '';
  for (const e of m.entries) {
    if (!e.time.trim()) continue;
    if (e.section !== section) {
      section = e.section;
      if (section) out.push(`    section ${section}`);
    }
    const events = splitList(e.events);
    out.push(`    ${e.time}${events.length ? ' : ' + events.join(' : ') : ''}`);
  }
  return out.join('\n');
}

/* mindmap 文本里的定界符/引号会让解析器误判或报错：形状内需引号包裹，
   而「无形状」的纯文本行连引号都不能用（mermaid 会 Parse error），只能退化成带 id 的方框 */
const MIND_TEXT_QUOTE_RE = /[\[\](){}<>"]/;

function mindTextExpr(text: string): string {
  if (!MIND_TEXT_QUOTE_RE.test(text) && text.trim() === text) return text;
  return `"${text.replace(/"/g, '#quot;')}"`;
}

function genMindNode(n: MindNode, depth: number, out: string[], counter: { n: number }): void {
  const pad = '  '.repeat(depth + 1);
  const raw = n.text.trim() ? n.text : ' ';
  if (n.shape) {
    const [open, close] = MIND_SHAPE_SYNTAX[n.shape];
    out.push(pad + open + mindTextExpr(raw) + close);
  } else if (MIND_TEXT_QUOTE_RE.test(raw) || raw === ' ') {
    counter.n += 1;
    out.push(`${pad}m${counter.n}[${mindTextExpr(raw)}]`);
  } else {
    out.push(pad + raw);
  }
  for (const c of n.children) genMindNode(c, depth + 1, out, counter);
}

function genMindmap(m: MindModel): string {
  const out = ['mindmap'];
  genMindNode(m.root, 0, out, { n: 0 });
  return out.join('\n');
}

export function generateMermaid(model: MermaidModel, extras: string[] = []): string {
  let body: string;
  switch (model.kind) {
    case 'flowchart':
      body = genFlowchart(model);
      break;
    case 'sequenceDiagram':
      body = genSequence(model);
      break;
    case 'pie':
      body = genPie(model);
      break;
    case 'xychart-beta':
      body = genXychart(model);
      break;
    case 'gantt':
      body = genGantt(model);
      break;
    case 'timeline':
      body = genTimeline(model);
      break;
    case 'mindmap':
      body = genMindmap(model);
      break;
  }
  const tail = extras.map((l) => l.replace(/\s+$/, '')).filter(Boolean).join('\n');
  return tail ? `${body}\n${tail}` : body;
}

/* ============================ 默认模板 / 空判定 ============================ */

/** 今天（本地时区，YYYY-MM-DD）：甘特图模板与新增任务的默认开始日期 */
export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function defaultModel(kind: DiagramKind): MermaidModel {
  switch (kind) {
    case 'flowchart':
      return {
        kind: 'flowchart',
        direction: 'TD',
        nodes: [
          { id: 'A', text: '开始', shape: 'rect' },
          { id: 'B', text: '判断?', shape: 'diamond' },
          { id: 'C', text: '处理', shape: 'rect' },
          { id: 'D', text: '结束', shape: 'rect' },
        ],
        edges: [
          { from: 'A', to: 'B', label: '', arrow: 'arrow' },
          { from: 'B', to: 'C', label: '是', arrow: 'arrow' },
          { from: 'B', to: 'D', label: '否', arrow: 'arrow' },
        ],
      };
    case 'sequenceDiagram':
      return {
        kind: 'sequenceDiagram',
        autonumber: false,
        participants: [
          { id: 'U', label: '用户', actor: true },
          { id: 'S', label: '服务器', actor: false },
        ],
        messages: [
          { from: 'U', to: 'S', text: '发送请求', arrow: 'solidArrow' },
          { from: 'S', to: 'U', text: '返回结果', arrow: 'dashedArrow' },
        ],
      };
    case 'pie':
      return {
        kind: 'pie',
        title: '访问来源',
        showData: false,
        items: [
          { label: '直接访问', value: '40' },
          { label: '搜索引擎', value: '35' },
          { label: '外部链接', value: '25' },
        ],
      };
    case 'xychart-beta':
      return {
        kind: 'xychart-beta',
        title: '季度销售额',
        xTitle: '',
        xLabels: '一季度, 二季度, 三季度',
        yTitle: '金额',
        yMin: '0',
        yMax: '100',
        series: [{ type: 'line', data: '30, 60, 88' }],
      };
    case 'gantt':
      return {
        kind: 'gantt',
        title: '项目计划',
        dateFormat: 'YYYY-MM-DD',
        tasks: [
          { section: '阶段一', name: '需求分析', id: 'a1', start: todayStr(), duration: '7d', status: '' },
          { section: '阶段一', name: '设计开发', id: 'a2', start: 'after a1', duration: '14d', status: '' },
        ],
      };
    case 'timeline':
      return {
        kind: 'timeline',
        title: '里程碑',
        entries: [
          { section: '', time: '2026 Q1', events: '立项, 需求分析' },
          { section: '', time: '2026 Q2', events: '开发, 测试' },
          { section: '', time: '2026 Q3', events: '发布' },
        ],
      };
    case 'mindmap':
      return {
        kind: 'mindmap',
        root: {
          text: '项目',
          shape: 'circle',
          children: [
            { text: '前端', shape: '', children: [{ text: '界面', shape: '', children: [] }, { text: '逻辑', shape: '', children: [] }] },
            { text: '后端', shape: '', children: [{ text: '接口', shape: '', children: [] }, { text: '数据', shape: '', children: [] }] },
          ],
        },
      };
  }
}

function isMindEmpty(n: MindNode): boolean {
  return !n.text.trim() && n.children.length === 0;
}

/** 模型是否没有任何实质内容（用于「切换图型是否需要确认」） */
export function isModelEmpty(m: MermaidModel): boolean {
  switch (m.kind) {
    case 'flowchart':
      return m.nodes.length === 0 && m.edges.length === 0;
    case 'sequenceDiagram':
      return m.participants.length === 0 && m.messages.length === 0;
    case 'pie':
      return m.items.length === 0 && !m.title;
    case 'xychart-beta':
      return m.series.length === 0 && !m.title && !m.xLabels;
    case 'gantt':
      return m.tasks.length === 0 && !m.title;
    case 'timeline':
      return m.entries.length === 0 && !m.title;
    case 'mindmap':
      return isMindEmpty(m.root);
  }
}

/** 生成一份新节点的唯一 id（A、B、…、Z、A1、B1…） */
export function nextFlowId(existing: { id: string }[]): string {
  const used = new Set(existing.map((n) => n.id));
  for (let round = 0; round < 100; round++) {
    for (let i = 0; i < 26; i++) {
      const id = String.fromCharCode(65 + i) + (round || '');
      if (!used.has(id)) return id;
    }
  }
  return `N${Date.now()}`;
}
