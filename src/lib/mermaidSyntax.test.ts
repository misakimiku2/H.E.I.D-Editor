// @vitest-environment jsdom
/**
 * 用 mermaid 自己「渲染」一遍模型生成的源码，确认它不仅语法可读、还能真的画出来。
 *
 * 为什么不止用 mermaid.parse：parse 只做语法分析，图表的编译期校验（如甘特图按
 * 逗号后 token 数解释 开始/时长/id、日期解析失败抛 Invalid date）要到 render 才跑。
 * jsdom 里 mindmap 需要 canvas 量文本尺寸，这类环境报错视为通过。
 */
import { describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { DIAGRAM_KINDS, defaultModel, generateMermaid, type MermaidModel } from './mermaidModel';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

/* jsdom 没有 SVG 测量 API，补最小实现让布局能跑完（不影响语法/编译期校验） */
const svgProto = (globalThis as unknown as { SVGElement?: { prototype: Record<string, unknown> } }).SVGElement?.prototype;
if (svgProto) {
  if (!svgProto.getBBox) svgProto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
  if (!svgProto.getComputedTextLength) svgProto.getComputedTextLength = () => 50;
  if (!svgProto.getSubStringLength) svgProto.getSubStringLength = () => 50;
}

let seq = 0;

/** 渲染源码；返回 null 表示通过（或仅因 jsdom 缺 canvas 失败），否则返回错误信息 */
async function renderError(code: string): Promise<string | null> {
  try {
    await mermaid.render(`syn-${++seq}`, code);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Could not create canvas|getBBox|not implemented/i.test(msg)) return null;
    return msg;
  }
}

describe('生成的源码可被 mermaid 真正渲染', () => {
  it('7 种图型的默认模板', async () => {
    for (const kind of DIAGRAM_KINDS) {
      const code = generateMermaid(defaultModel(kind));
      const err = await renderError(code);
      expect(err, `${kind} 渲染失败：${err}\n${code}`).toBeNull();
    }
  }, 30000);

  it('含中英文混排与特殊字符的字段', async () => {
    const models: MermaidModel[] = [
      {
        kind: 'flowchart',
        direction: 'LR',
        nodes: [
          { id: 'A', text: '开始 (第 1 步)', shape: 'round' },
          { id: 'B', text: 'a|b', shape: 'diamond' },
        ],
        edges: [{ from: 'A', to: 'B', label: '是/否', arrow: 'dottedArrow' }],
      },
      {
        kind: 'pie',
        title: '占比 "2026"',
        showData: true,
        items: [
          { label: '甲,乙', value: '60' },
          { label: '丙', value: '40' },
        ],
      },
      {
        kind: 'xychart-beta',
        title: '季度',
        xTitle: '时间',
        xLabels: '一季度, Q2, 三 季度',
        yTitle: '金额',
        yMin: '0',
        yMax: '100',
        series: [
          { type: 'bar', data: '1, 2, 3' },
          { type: 'line', data: '3, 2, 1' },
        ],
      },
      {
        kind: 'sequenceDiagram',
        autonumber: true,
        participants: [
          { id: 'U', label: '用户 (甲)', actor: true },
          { id: 'S', label: 'Server', actor: false },
        ],
        messages: [{ from: 'U', to: 'S', text: '请求: 获取数据', arrow: 'dashedArrow' }],
      },
      {
        kind: 'mindmap',
        root: {
          text: '根 (root)',
          shape: 'circle',
          children: [
            { text: '子 [项]', shape: '', children: [] },
            { text: '普通子项', shape: '', children: [] },
          ],
        },
      },
      {
        kind: 'gantt',
        title: '排期',
        dateFormat: 'YYYY-MM-DD',
        tasks: [
          { section: '一组', name: '甲', id: '', start: '', duration: '7d', status: '' },
          { section: '一组', name: '乙', id: 'b1', start: '2026-03-02', duration: '3d', status: 'done' },
          { section: '二组', name: '丙', id: 'c1', start: 'after b1', duration: '2d', status: 'milestone' },
        ],
      },
    ];
    for (const model of models) {
      const code = generateMermaid(model);
      const err = await renderError(code);
      expect(err, `${model.kind} 渲染失败：${err}\n${code}`).toBeNull();
    }
  }, 30000);

  it('甘特图回归：没有开始时间时不再输出 id（旧实现被当成日期解析报 Invalid date）', async () => {
    const model: MermaidModel = {
      kind: 'gantt',
      title: '',
      dateFormat: 'YYYY-MM-DD',
      tasks: [
        { section: '', name: '需求分析', id: 'a1', start: '', duration: '7d', status: '' },
        { section: '', name: '设计开发', id: 'a2', start: 'after a1', duration: '14d', status: '' },
      ],
    };
    const code = generateMermaid(model);
    /* 第一个任务补了起点日期，于是 id 也能保留（3 token 形式） */
    expect(code).toMatch(/需求分析 : a1, \d{4}-\d{2}-\d{2}, 7d/);
    /* 第二个任务保持 after 引用 */
    expect(code).toContain('设计开发 : a2, after a1, 14d');
    const err = await renderError(code);
    expect(err, `渲染失败：${err}\n${code}`).toBeNull();
    /* 反向确认：手动拼出的旧写法确实会被 mermaid 拒绝 */
    const broken = 'gantt\n    dateFormat YYYY-MM-DD\n    需求分析 : a1, 7d';
    expect(await renderError(broken)).toMatch(/Invalid date/);
  }, 30000);

  it('确认校验本身有效：无引号的中文轴标签会被拒绝', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await renderError('xychart-beta\n    x-axis [一季度, 二季度]');
    spy.mockRestore();
    expect(err).not.toBeNull();
  });
});
