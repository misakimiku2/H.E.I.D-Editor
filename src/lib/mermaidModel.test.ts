import { describe, it, expect } from 'vitest';
import {
  parseMermaid,
  generateMermaid,
  defaultModel,
  isModelEmpty,
  nextFlowId,
  DIAGRAM_KINDS,
  type MermaidModel,
} from './mermaidModel';

/** 模型 → 源码 → 模型，应完全一致 */
function roundTrip(model: MermaidModel) {
  const code = generateMermaid(model);
  const parsed = parseMermaid(code);
  expect(parsed.ok, `解析失败：${!parsed.ok ? `${parsed.reason} line ${parsed.line}: ${parsed.text}` : ''}`).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.model).toEqual(model);
  /* 再生成一次应得到同样的源码（幂等） */
  expect(generateMermaid(parsed.model, parsed.extras)).toBe(code);
}

describe('mermaidModel round-trip', () => {
  it('7 种图型的默认模板可无损往返', () => {
    for (const kind of DIAGRAM_KINDS) {
      roundTrip(defaultModel(kind));
    }
  });

  it('流程图：模板与常见写法', () => {
    const code = `flowchart TD
    A[开始] --> B{判断?}
    B -->|是| C[处理]
    B -->|否| D[结束]`;
    const r = parseMermaid(code);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.kind).toBe('flowchart');
    if (r.model.kind !== 'flowchart') return;
    expect(r.model.nodes.map((n) => n.text)).toEqual(['开始', '判断?', '处理', '结束']);
    expect(r.model.nodes[1].shape).toBe('diamond');
    expect(r.model.edges[1]).toMatchObject({ from: 'B', to: 'C', label: '是' });
    expect(generateMermaid(r.model)).toContain('B -->|是| C');
  });

  it('流程图：长形式标签、各种箭头、裸节点与链式', () => {
    const r = parseMermaid(`graph LR
    A -- 文案 --> B
    B -.-> C
    C ==> D
    D --- E
    E --> F --> G
    H`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'flowchart') return;
    expect(r.model.direction).toBe('LR');
    expect(r.model.edges.map((e) => e.arrow)).toEqual([
      'arrow',
      'dottedArrow',
      'thickArrow',
      'open',
      'arrow',
      'arrow',
    ]);
    expect(r.model.edges[0].label).toBe('文案');
    /* 链式 A --> B --> C 与裸节点 H 都要建出节点 */
    expect(r.model.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    /* 未定义文本的节点用 id 兜底 */
    expect(r.model.nodes.find((n) => n.id === 'H')?.text).toBe('H');
  });

  it('流程图：形状与文本转义', () => {
    const r = parseMermaid(`flowchart TD
    A([胶囊]) --> B[(数据库)]
    B --> C((圆形))
    C --> D[[子程序]]
    D --> E>不对称]
    E --> F["含 [ 方括号]"]`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'flowchart') return;
    const byId = Object.fromEntries(r.model.nodes.map((n) => [n.id, n]));
    expect(byId.A.shape).toBe('stadium');
    expect(byId.B.shape).toBe('cylinder');
    expect(byId.C.shape).toBe('circle');
    expect(byId.D.shape).toBe('subroutine');
    expect(byId.E.shape).toBe('asymmetric');
    expect(byId.F.text).toBe('含 [ 方括号]');
    const code = generateMermaid(r.model);
    expect(parseMermaid(code).ok).toBe(true);
  });

  it('流程图：style / classDef 收进 extras 并保留', () => {
    const r = parseMermaid(`flowchart TD
    A[开始] --> B[结束]
    style A fill:#f00
    classDef big font-size:20px`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extras).toHaveLength(2);
    const code = generateMermaid(r.model, r.extras);
    expect(code).toContain('style A fill:#f00');
    expect(code).toContain('classDef big font-size:20px');
  });

  it('流程图：subgraph 等结构语句判为不支持', () => {
    const r = parseMermaid(`flowchart TD
    subgraph 一组
    A --> B
    end`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('syntax');
    expect(r.line).toBe(2);
  });

  it('时序图：参与者与箭头', () => {
    const r = parseMermaid(`sequenceDiagram
    autonumber
    actor U as 用户
    participant S as 服务器
    U->>S: 请求
    S-->>U: 响应
    S-xU: 失败
    U-)S: 异步`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'sequenceDiagram') return;
    expect(r.model.autonumber).toBe(true);
    expect(r.model.participants[0]).toEqual({ id: 'U', label: '用户', actor: true });
    expect(r.model.messages.map((m) => m.arrow)).toEqual([
      'solidArrow',
      'dashedArrow',
      'solidCross',
      'solidAsync',
    ]);
  });

  it('时序图：Note / loop 等块语句判为不支持', () => {
    const r = parseMermaid(`sequenceDiagram
    A->>B: 你好
    Note over A,B: 备注`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.line).toBe(3);
  });

  it('饼图：标题 / showData / 无引号标签', () => {
    const r = parseMermaid(`pie showData title 销量
    "苹果" : 42.5
    香蕉 : 17`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'pie') return;
    expect(r.model.showData).toBe(true);
    expect(r.model.title).toBe('销量');
    expect(r.model.items).toEqual([
      { label: '苹果', value: '42.5' },
      { label: '香蕉', value: '17' },
    ]);
    roundTrip(r.model);
  });

  it('XY 图：轴与多系列', () => {
    const r = parseMermaid(`xychart-beta
    title "季度"
    x-axis "季度" [Q1, Q2, "Q 3"]
    y-axis "金额" -10 --> 100
    bar [1, 2, 3]
    line [3, 2, 1]`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'xychart-beta') return;
    expect(r.model.title).toBe('季度');
    expect(r.model.xTitle).toBe('季度');
    expect(r.model.xLabels).toBe('Q1, Q2, Q 3');
    expect(r.model.yMin).toBe('-10');
    expect(r.model.yMax).toBe('100');
    expect(r.model.series).toEqual([
      { type: 'bar', data: '1, 2, 3' },
      { type: 'line', data: '3, 2, 1' },
    ]);
    roundTrip(r.model);
  });

  it('XY 图：中文轴标签生成时带引号（否则 mermaid 词法错误）', () => {
    const m = defaultModel('xychart-beta');
    const code = generateMermaid(m);
    expect(code).toContain('x-axis ["一季度", "二季度", "三季度"]');
    expect(parseMermaid(code).ok).toBe(true);
  });

  it('甘特图：分组 / id / after / 时长 / 状态', () => {
    const r = parseMermaid(`gantt
    title 项目计划
    dateFormat YYYY-MM-DD
    axisFormat %m-%d
    section 阶段一
    需求分析 :done, a1, 2026-09-01, 7d
    设计开发 :a2, after a1, 14d
    section 阶段二
    上线 :milestone, 2026-10-01, 0d`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'gantt') return;
    expect(r.model.tasks).toHaveLength(3);
    expect(r.model.tasks[0]).toMatchObject({ section: '阶段一', id: 'a1', status: 'done', start: '2026-09-01', duration: '7d' });
    expect(r.model.tasks[1]).toMatchObject({ start: 'after a1', duration: '14d' });
    expect(r.model.tasks[2]).toMatchObject({ section: '阶段二', status: 'milestone' });
    expect(r.extras).toEqual(['    axisFormat %m-%d']);
    roundTrip(r.model);
  });

  it('时间线：分组与多事件', () => {
    const r = parseMermaid(`timeline
    title 里程碑
    section 上半年
    2026 Q1 : 立项 : 需求分析
    2026 Q2 : 开发
    section 下半年
    2026 Q3 : 发布`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'timeline') return;
    expect(r.model.entries).toEqual([
      { section: '上半年', time: '2026 Q1', events: '立项, 需求分析' },
      { section: '上半年', time: '2026 Q2', events: '开发' },
      { section: '下半年', time: '2026 Q3', events: '发布' },
    ]);
    roundTrip(r.model);
  });

  it('思维导图：缩进层级与形状', () => {
    const r = parseMermaid(`mindmap
  root((项目))
    前端
      界面
    后端[服务]`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.model.kind !== 'mindmap') return;
    expect(r.model.root.shape).toBe('circle');
    /* `后端[服务]` 是 mermaid 的「id + 文本」写法，显示文本取方括号内容 */
    expect(r.model.root.children.map((c) => c.text)).toEqual(['前端', '服务']);
    expect(r.model.root.children[0].children[0].text).toBe('界面');
    expect(r.model.root.children[1].shape).toBe('rect');
    roundTrip(r.model);
  });

  it('思维导图：第二个根级节点判为不支持', () => {
    const r = parseMermaid(`mindmap
  根
  兄弟
      孙`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.line).toBe(3);
  });
});

describe('parseMermaid 失败信息', () => {
  it('不支持的图型返回 unsupported 与类型名', () => {
    const r = parseMermaid('classDiagram\n    A <|-- B');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unsupported');
    expect(r.kind).toBe('classDiagram');
  });

  it('无法理解的行返回 syntax 与行号（1 起）', () => {
    const r = parseMermaid('flowchart TD\n    A[开始] --> & B');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('syntax');
    expect(r.line).toBe(2);
  });

  it('空内容返回 syntax', () => {
    const r = parseMermaid('   \n\n');
    expect(r.ok).toBe(false);
  });
});

describe('辅助函数', () => {
  it('isModelEmpty 判定', () => {
    expect(isModelEmpty(defaultModel('flowchart'))).toBe(false);
    expect(isModelEmpty({ kind: 'flowchart', direction: 'TD', nodes: [], edges: [] })).toBe(true);
    expect(isModelEmpty({ kind: 'pie', title: '', showData: false, items: [] })).toBe(true);
    expect(isModelEmpty({ kind: 'mindmap', root: { text: '', shape: '', children: [] } })).toBe(true);
  });

  it('nextFlowId 避开已用 id', () => {
    expect(nextFlowId([])).toBe('A');
    expect(nextFlowId([{ id: 'A' }, { id: 'B' }])).toBe('C');
    expect(nextFlowId([{ id: 'A' }, { id: 'B' }, { id: 'C' }])).toBe('D');
  });

  it('generateMermaid 保留 extras 且不重复追加空行', () => {
    const code = generateMermaid(defaultModel('pie'), ['    %% 备注', '']);
    expect(code.endsWith('%% 备注')).toBe(true);
  });
});
