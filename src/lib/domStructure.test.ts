// @vitest-environment jsdom
/**
 * structuralizeDoc：网址导入前的 DOM 结构化重写。
 * fixture 均取自真实页面（arknights-endfield.wiki 干员页）的关键片段，
 * 保证启发式命中的是真实站点的 DOM 形态而非理想化样例。
 */
import { describe, expect, it } from 'vitest';
import TurndownService from 'turndown';
import * as turndownPluginGfm from 'turndown-plugin-gfm';
import { structuralizeDoc, normalizeTables, extractMainContent, collectTabGroups } from './domStructure';
import { importFromHtml, importFromFetched, insertTabMarkers, markdownCoverage, type UrlImportResult } from './urlImport';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function toMarkdown(html: string): string {
  const doc = parse(html);
  structuralizeDoc(doc);
  normalizeTables(doc);
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndownPluginGfm.gfm(td);
  return td.turndown(doc.body.innerHTML).trim();
}

const URL = 'https://arknights-endfield.wiki/zh/operators/ardelia';

/* ---- 真实片段：基础属性网格（grid 容器 + 同构 3 叶卡片：图标/标签/数值） ---- */
const GRID3 = `<div id="root-frag"><div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"><div class="p-3 sm:p-4 rounded-lg bg-card border border-border border-l-4 border-l-red-500"><div class="flex items-center gap-2 mb-1"><span class="text-lg sm:text-xl">❤️</span><span class="text-xs sm:text-sm text-muted-foreground">生命值</span></div><div class="text-xl sm:text-2xl font-bold text-foreground">500</div></div><div class="p-3 sm:p-4 rounded-lg bg-card border border-border border-l-4 border-l-orange-500"><div class="flex items-center gap-2 mb-1"><span class="text-lg sm:text-xl">⚔️</span><span class="text-xs sm:text-sm text-muted-foreground">攻击力</span></div><div class="text-xl sm:text-2xl font-bold text-foreground">30</div></div><div class="p-3 sm:p-4 rounded-lg bg-card border border-border border-l-4 border-l-blue-500"><div class="flex items-center gap-2 mb-1"><span class="text-lg sm:text-xl">🛡️</span><span class="text-xs sm:text-sm text-muted-foreground">防御力</span></div><div class="text-xl sm:text-2xl font-bold text-foreground">0</div></div></div></div>`;

/* ---- 真实片段：能力值横向滚动条（flex 容器 + 同构 2 叶卡片：标签/数值） ---- */
const FLEX4 = `<div id="root-frag"><div class="flex gap-3 overflow-x-auto pb-2 -mx-2 px-2"><div class="flex-shrink-0 bg-card border border-border px-4 py-2 rounded-lg min-w-[100px]"><div class="text-xs text-muted-foreground">力量</div><div class="text-lg font-bold text-foreground">10</div></div><div class="flex-shrink-0 bg-card border border-border px-4 py-2 rounded-lg min-w-[100px]"><div class="text-xs text-muted-foreground">敏捷</div><div class="text-lg font-bold text-foreground">9</div></div><div class="flex-shrink-0 bg-card border border-border px-4 py-2 rounded-lg min-w-[100px]"><div class="text-xs text-muted-foreground">智识</div><div class="text-lg font-bold text-foreground">20</div></div><div class="flex-shrink-0 bg-card border border-border px-4 py-2 rounded-lg min-w-[100px]"><div class="text-xs text-muted-foreground">意志</div><div class="text-lg font-bold text-foreground">16</div></div></div></div>`;

/* ---- 真实片段：标签 chips 行（flex-wrap + 单叶 span） ---- */
const CHIPS = `<div id="root-frag"><div class="flex flex-wrap justify-center sm:justify-start gap-2 mt-4"><span class="px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">辅助</span><span class="px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-green-500/10 text-green-400 border border-green-500/20">自然</span><span class="px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-muted/50 text-muted-foreground border border-border/50">施术单元</span><span class="px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-green-500/10 text-green-400 border border-green-500/20">罗德岛</span></div></div>`;

/* ---- 真实片段：技能名 + 类型徽章（flex 行内两个单叶 span，无换行会黏连） ---- */
const NAME_ROW = `<div id="root-frag"><section class="content-card"><div class="flex items-center gap-2 mb-2"><span class="text-lg font-bold">岩石的轻语</span><span class="px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">普通攻击</span></div></section></div>`;

describe('structuralizeDoc：网格卡片 → 语义表格', () => {
  it('grid 容器内同构卡片（图标/标签/数值）重写为表头+数值行的表格', () => {
    const doc = parse(GRID3);
    structuralizeDoc(doc);
    const table = doc.querySelector('table');
    expect(table).not.toBeNull();
    const heads = Array.from(table!.querySelectorAll('th')).map(c => c.textContent!.trim());
    expect(heads).toEqual(['❤️ 生命值', '⚔️ 攻击力', '🛡️ 防御力']);
    const cells = Array.from(table!.querySelectorAll('tbody td')).map(c => c.textContent!.trim());
    expect(cells).toEqual(['500', '30', '0']);
    expect(doc.querySelector('.grid')).toBeNull();
  });

  it('flex 容器内同构卡片（标签/数值）同样重写为表格', () => {
    const doc = parse(FLEX4);
    structuralizeDoc(doc);
    const table = doc.querySelector('table');
    expect(table).not.toBeNull();
    const heads = Array.from(table!.querySelectorAll('th')).map(c => c.textContent!.trim());
    expect(heads).toEqual(['力量', '敏捷', '智识', '意志']);
    const cells = Array.from(table!.querySelectorAll('tbody td')).map(c => c.textContent!.trim());
    expect(cells).toEqual(['10', '9', '20', '16']);
  });

  it('重写后的表格经 turndown 输出规整的 GFM 表格', () => {
    const md = toMarkdown(GRID3);
    expect(md).toMatch(/❤️ 生命值\s*\|\s*⚔️ 攻击力\s*\|\s*🛡️ 防御力/);
    expect(md).toMatch(/\|\s*500\s*\|\s*30\s*\|\s*0\s*\|/);
  });
});

describe('structuralizeDoc：chips / 行内徽章', () => {
  it('flex-wrap 单叶 chips 之间插入分隔符，不再黏连', () => {
    const md = toMarkdown(CHIPS);
    expect(md).toMatch(/辅助\s*·\s*自然\s*·\s*施术单元\s*·\s*罗德岛/);
  });

  it('纯装饰 chip 行整块删除（而非加分隔符）', () => {
    const html = `<div id="root-frag"><div class="flex flex-wrap gap-2"><span>·</span><span>·</span><span>·</span></div><p>正文保留</p></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.body.textContent).toContain('正文保留');
    expect(doc.body.textContent!.match(/·/g)?.length ?? 0).toBe(0);
  });

  it('flex 行内的名称+徽章拆为两行，不再黏连', () => {
    const md = toMarkdown(NAME_ROW);
    expect(md).toMatch(/岩石的轻语 {2}\n普通攻击/);
    expect(md).not.toMatch(/岩石的轻语[^\n]*普通攻击/);
  });

  it('图标+标签的两叶 flex 行不受徽章拆分影响（图标不与标签断开）', () => {
    const html = `<div id="root-frag"><div class="flex items-center gap-2 mb-1"><span class="text-lg">❤️</span><span class="text-xs">生命值</span></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.body.querySelector('br')).toBeNull();
    expect(doc.body.textContent).toContain('❤️');
    expect(doc.body.textContent).toContain('生命值');
  });
});

describe('structuralizeDoc：负例（命中约束不足时保持原 DOM）', () => {
  it('子元素叶数不一致（非同构）的 grid 不重写', () => {
    const html = `<div id="root-frag"><div class="grid grid-cols-2 gap-4"><div><span>标题甲</span><div>内容甲内容甲内容甲内容甲内容甲内容甲</div></div><div><span>乙</span></div><div><span>丙</span></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.querySelector('table')).toBeNull();
    expect(doc.querySelector('.grid')).not.toBeNull();
  });

  it('卡片文本超长的 grid 不重写', () => {
    const longText = '很长的正文段落'.repeat(20);
    const html = `<div id="root-frag"><div class="grid grid-cols-2 gap-4"><div><span>标题</span><div>${longText}</div></div><div><span>标题</span><div>${longText}</div></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.querySelector('table')).toBeNull();
  });

  it('无 grid/flex 工具类信号的容器一律不动', () => {
    const html = `<div id="root-frag"><div class="cards"><div><span>生命值</span><div>500</div></div><div><span>攻击力</span><div>30</div></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.querySelector('table')).toBeNull();
  });
});

describe('structuralizeDoc：清理规则（标签对 / 控件 / 装饰）', () => {
  it('冒号结尾标签+值的 flex 行合并为一行「Range: 远程」', () => {
    const html = `<div id="root-frag"><div class="flex flex-wrap gap-3"><div class="flex items-center gap-1"><span class="text-muted-foreground">Range:</span><span class="font-semibold">远程</span></div></div></div>`;
    const md = toMarkdown(html);
    expect(md).toMatch(/Range: 远程/);
    expect(md).not.toMatch(/Range:[\s\S]*\n[\s\S]*远程/);
  });

  it('flex-col 标签值对合并为「伤害倍率: 0.45」，不再黏连', () => {
    const html = `<div id="root-frag"><div class="flex flex-col sm:flex-row sm:justify-between gap-1 p-2 rounded-lg"><span class="font-medium uppercase">伤害倍率</span><span class="font-mono">0.45</span></div></div>`;
    const md = toMarkdown(html);
    expect(md).toMatch(/伤害倍率: 0\.45/);
    expect(md).not.toMatch(/伤害倍率0\.45/);
  });

  it('含按钮的小型交互控件（等级步进器）整块删除', () => {
    const html = `<div id="root-frag"><section class="content-card"><div class="relative rounded-xl border"><div class="relative flex items-center gap-3 p-4"><button aria-label="Decrease level" class="w-10 h-10"><span>−</span></button><div class="flex-1 text-center"><div class="text-xs mb-1">等级</div><div class="text-3xl font-bold">1</div><div class="text-xs mt-1">/ <!-- -->12</div></div><button aria-label="Increase level" class="w-10 h-10"><span>+</span></button></div></div><h3>岩石的轻语</h3></section></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.body.textContent).not.toContain('等级');
    expect(doc.querySelector('button')).toBeNull();
    expect(doc.body.textContent).toContain('岩石的轻语');
  });

  it('纯装饰字符组成的 chips 行整块删除', () => {
    const html = `<div id="root-frag"><div class="flex justify-center gap-3 mt-8"><span>·</span><span>·</span><span>·</span></div><p>正文保留</p></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.body.textContent).toContain('正文保留');
    expect(doc.body.textContent!.match(/·/g)?.length ?? 0).toBe(0);
  });

  it('含按钮但文本量大（正文卡片）不删除', () => {
    const longText = '这是一段真实的正文内容，不应当被误删。'.repeat(15);
    const html = `<div id="root-frag"><div class="card"><p>${longText}</p><button>展开全文</button></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(doc.body.textContent).toContain('这是一段真实的正文内容');
  });
});

describe('normalizeTables：colgroup / 单元格块级内容规整（R7）', () => {
  it('2 列标签值表移除 colgroup 并转为列表，不再透传原始 HTML', () => {
    const html = `<div id="root-frag"><table><colgroup><col><col></colgroup><tbody><tr><td><p><strong>身份</strong></p></td><td><p>拉海洛特别对策组专员</p></td></tr><tr><td><p><strong>中文CV</strong></p></td><td><p>李蝉妃</p></td></tr></tbody></table></div>`;
    const doc = parse(html);
    normalizeTables(doc);
    expect(doc.querySelector('colgroup')).toBeNull();
    expect(doc.querySelector('table')).toBeNull();
    expect(doc.querySelectorAll('li').length).toBe(2);
    const md = toMarkdown(html);
    expect(md).toMatch(/-\s+\*\*身份\*\*: 拉海洛特别对策组专员/);
    expect(md).toMatch(/-\s+\*\*中文CV\*\*: 李蝉妃/);
    expect(md).not.toContain('<table');
    expect(md).not.toContain('<colgroup');
  });

  it('多列无表头表格首行提升为表头，转出 GFM 表格；单元格多段内容以空格连接', () => {
    const html = `<div id="root-frag"><table><colgroup><col><col><col></colgroup><tbody><tr><td><p>招式</p></td><td><p>倍率</p></td><td><p>备注</p></td></tr><tr><td><p><strong>主力输出</strong></p><p>拥有较强的输出能力</p></td><td>1.0</td><td>补充</td></tr></tbody></table></div>`;
    const doc = parse(html);
    normalizeTables(doc);
    expect(doc.querySelector('thead')).not.toBeNull();
    const md = toMarkdown(html);
    expect(md).toMatch(/\|\s*招式\s*\|\s*倍率\s*\|\s*备注\s*\|/);
    expect(md).toMatch(/\|\s*\*\*主力输出\*\* 拥有较强的输出能力\s*\|\s*1\.0\s*\|\s*补充\s*\|/);
    expect(md).not.toContain('<td');
  });
});

describe('normalizeTables：嵌套表格摊平', () => {
  it('td 内嵌套的内层表格摊平为段落文本，不再透传原始 HTML', () => {
    const html = `<div id="root-frag"><table class="navbox"><thead><tr><th>阵营导航</th></tr></thead><tbody><tr><td>格里芬</td><td><table><tbody><tr><td>AR小队</td><td><a href="https://x/a">洛贝拉</a> • <a href="https://x/b">索普</a></td></tr><tr><td></td></tr><tr><td>忤逆小队</td><td><a href="https://x/c">埃芙</a></td></tr></tbody></table></td></tr></tbody></table></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    normalizeTables(doc);
    expect(doc.querySelector('table table')).toBeNull();
    const md = toMarkdown(html);
    expect(md).not.toMatch(/<table|<td|<tr/);
    expect(md).toContain('洛贝拉');
    expect(md).toContain('AR小队');
    expect(md).toContain('忤逆小队');
  });
});

describe('structuralizeDoc：标签组 + 图片面板 → tab 标记（R8）', () => {
  /* 真实形态取自库街区角色页：.role-tag 标签组 + .role-images 单图面板组 */
  const TABS_FIXTURE = `<div id="root-frag"><div class="component-content-inner"><div class="role-tag"><div class="role-tag-item role-tag-active">基础信息</div><div class="role-tag-item">编队立绘</div><div class="role-tag-item">海报立绘</div></div><div class="role-images"><div class="figure figure-visible"><img src="a.png"></div><div class="figure"><img src="b.png"></div><div class="figure"><img src="c.png"></div></div></div></div>`;

  /* 库街区线上实际 DOM：标签子项内层还有文本叶 + 空装饰叶两层结构 */
  const TABS_FIXTURE_NESTED = `<div id="root-frag"><div class="component-content-inner"><div class="role-images"><div class="figure figure-visible first-figure"><img src="a.png"></div><div class="figure"><img src="b.png"></div><div class="figure"><img src="c.png"></div></div><div class="role-profile"><div>洛瑟菈</div></div><div class="role-tag"><div class="mb-12 role-tag-item role-tag-active"><div class="role-tag-item-inner text-ellipsis">基础信息</div><div class="role-tag-item-extra"></div></div><div class="mb-12 role-tag-item"><div class="role-tag-item-inner text-ellipsis">编队立绘</div><div class="role-tag-item-extra"></div></div><div class="mb-12 role-tag-item"><div class="role-tag-item-inner text-ellipsis">海报立绘</div><div class="role-tag-item-extra"></div></div></div></div></div>`;

  it('同子树内等量的标签组与单图面板组，收集（标签, 图片src）配对', () => {
    const doc = parse(TABS_FIXTURE);
    structuralizeDoc(doc);
    expect(collectTabGroups(doc)).toEqual([[
      { label: '基础信息', imgSrc: 'a.png', textAnchor: '' },
      { label: '编队立绘', imgSrc: 'b.png', textAnchor: '' },
      { label: '海报立绘', imgSrc: 'c.png', textAnchor: '' },
    ]]);
  });

  it('标签子项含内层装饰结构（库街区线上形态）同样识别', () => {
    const doc = parse(TABS_FIXTURE_NESTED);
    structuralizeDoc(doc);
    expect(collectTabGroups(doc)).toEqual([[
      { label: '基础信息', imgSrc: 'a.png', textAnchor: '' },
      { label: '编队立绘', imgSrc: 'b.png', textAnchor: '' },
      { label: '海报立绘', imgSrc: 'c.png', textAnchor: '' },
    ]]);
  });

  it('R9 内容面板盒：恰好一个可见、其余内联隐藏，配对收集面板首文本锚', () => {
    /* 真实形态取自库街区「技能介绍」：.tabs 标签盒 + tabs-component 面板容器
       （单子链下钻到 inner，7 个 component-content-text，仅第一个可见） */
    const html = `<div id="root-frag"><div class="component-wrapper"><div class="component-title">技能介绍</div><div class="tab-wrapper"><div class="tabs"><div class="tab tab-active">常态攻击</div><div class="tab">共鸣技能</div></div></div><div class="component-content component-content-tabs-component"><div class="component-content-inner"><div class="component-content-text"><p><img src="icon-a.png">抓拍</p><p>进行最多3段的连续攻击，造成冷凝伤害。</p></div><div class="component-content-text" style="display: none;"><p><img src="icon-b.png">幻象定帧</p><p>牵引周围的目标，造成冷凝伤害。</p></div></div></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(collectTabGroups(doc)).toEqual([[
      { label: '常态攻击', imgSrc: 'icon-a.png', textAnchor: '抓拍' },
      { label: '共鸣技能', imgSrc: 'icon-b.png', textAnchor: '幻象定帧' },
    ]]);
  });

  it('R9 多个子元素都可见的容器不是内容面板盒', () => {
    const html = `<div id="root-frag"><div class="wrap"><div class="tabs"><div class="tab">甲</div><div class="tab">乙</div></div><div class="panels"><div><p>第一段可见内容，足够长。</p></div><div><p>第二段可见内容，足够长。</p></div></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(collectTabGroups(doc)).toEqual([]);
  });

  it('标签子项夹带链接/按钮/图片时不收集', () => {
    const html = `<div id="root-frag"><div class="wrap"><div class="tags"><a href="#1">甲</a><span>乙</span></div><div class="panels"><div><img src="a.png"></div><div><img src="b.png"></div></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(collectTabGroups(doc)).toEqual([]);
  });

  it('数量不等的标签组与图片面板不收集', () => {
    const html = `<div id="root-frag"><div class="wrap"><div class="tags"><span>甲</span><span>乙</span></div><div class="panels"><div><img src="a.png"></div><div><img src="b.png"></div><div><img src="c.png"></div></div></div></div>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    expect(collectTabGroups(doc)).toEqual([]);
  });

  it('整链贯通：配对在 markdown 转换后按图片 src 回插 tab 注释，组尾带结束标记', async () => {
    const page = `<!DOCTYPE html><html><head><title>干员</title></head><body>${TABS_FIXTURE}</body></html>`;
    const result = await importFromHtml(page, URL);
    expect(result.markdown).toContain('<!-- tab:基础信息 -->');
    expect(result.markdown).toContain('<!-- tab:编队立绘 -->');
    expect(result.markdown).toContain('<!-- tab:海报立绘 -->');
    expect(result.markdown).toContain('a.png');
    /* 页签区块只包住图片组，结束标记后不再有页签内容 */
    const endIdx = result.markdown.indexOf('<!-- /tab -->');
    expect(endIdx).toBeGreaterThan(0);
    expect(result.markdown.slice(endIdx)).not.toContain('<!-- tab:');
  });
});

describe('insertTabMarkers：页签标记回插', () => {
  it('每组标记包住图片组，组尾回插结束标记；其后正文不受影响', () => {
    const md = '前言\n\n![](https://x/a.png)\n\n![](https://x/b.png)\n\n正文开始';
    const out = insertTabMarkers(md, [[
      { label: '甲', imgSrc: 'https://x/a.png', textAnchor: '' },
      { label: '乙', imgSrc: 'https://x/b.png', textAnchor: '' },
    ]]);
    expect(out).toBe(
      '前言\n\n<!-- tab:甲 -->\n\n![](https://x/a.png)\n\n<!-- tab:乙 -->\n\n![](https://x/b.png)\n\n<!-- /tab -->\n\n正文开始',
    );
  });

  it('图片不在 markdown 中（被提取丢弃）时跳过，不产生孤立标记', () => {
    const md = '正文，没有图片';
    const out = insertTabMarkers(md, [[
      { label: '甲', imgSrc: 'https://x/missing.png', textAnchor: '' },
    ]]);
    expect(out).toBe(md);
  });

  it('文本面板组按面板首文本锚回插；任一锚点缺失则整组放弃', () => {
    const md = '常态攻击\n共鸣技能\n\n抓拍\n普攻描述\n\n幻象定帧\n牵引描述';
    const out = insertTabMarkers(md, [[
      { label: '常态攻击', imgSrc: '', textAnchor: '抓拍' },
      { label: '共鸣技能', imgSrc: '', textAnchor: '幻象定帧' },
    ]]);
    expect(out).toContain('<!-- tab:常态攻击 -->');
    expect(out).toContain('<!-- tab:共鸣技能 -->');
    expect(out).toContain('<!-- /tab -->');
    const noMatch = insertTabMarkers('只有一段', [[
      { label: '常态攻击', imgSrc: '', textAnchor: '抓拍' },
      { label: '共鸣技能', imgSrc: '', textAnchor: '幻象定帧' },
    ]]);
    expect(noMatch).toBe('只有一段');
  });

  it('标签与图片在 md 中顺序相反时，整组放弃（不产生半残页签）', () => {
    const md = '![](https://x/b.png)\n\n![](https://x/a.png)';
    const out = insertTabMarkers(md, [[
      { label: '甲', imgSrc: 'https://x/a.png', textAnchor: '' },
      { label: '乙', imgSrc: 'https://x/b.png', textAnchor: '' },
    ]]);
    expect(out).toBe(md);
  });
});

describe('markdownCoverage：渲染可见文本覆盖率', () => {
  it('内容完整覆盖为 1，完全缺失为 0', () => {
    const visible = '第一段足够长的可见文本内容。\n第二段足够长的可见文本内容。';
    expect(markdownCoverage(visible, '前言\n第一段足够长的可见文本内容。\n第二段足够长的可见文本内容。\n结尾')).toBe(1);
    expect(markdownCoverage(visible, '完全无关的内容，什么都不匹配。')).toBe(0);
  });

  it('markdown 链接语法不影响匹配（[文本](url) 按文本算）', () => {
    const visible = '洛贝拉 • 索普 • 阿斯缇亚都在名单里';
    expect(markdownCoverage(visible, '[洛贝拉](https://x/a) • [索普](https://x/b) • [阿斯缇亚](https://x/c)都在名单里')).toBe(1);
  });

  it('过短的可见行不参与采样', () => {
    expect(markdownCoverage('短\n另一个短', '')).toBe(1);
  });
});

describe('importFromFetched：渲染结果缺可见内容时改用全文兜底', () => {
  /** 桩：defuddle 形态——只提取基础区，丢掉语音区 */
  const convertDropsVoice = async (html: string): Promise<UrlImportResult> => ({
    title: '干员页',
    site: '',
    markdown: `基础资料`,
    bodyMd: html.includes('voice') ? '基础资料内容' : '基础资料内容',
    filename: '干员页.md',
  });
  /** 桩：全文兜底形态——基础区+语音区都在 */
  const convertDeepKeepsAll = async (): Promise<UrlImportResult> => ({
    title: '干员页',
    site: '',
    markdown: `基础资料内容\n语音内容一，这是足够长的一行语音文本。\n语音内容二，这是另一条语音。`,
    bodyMd: `基础资料内容\n语音内容一，这是足够长的一行语音文本。\n语音内容二，这是另一条语音。`,
    filename: '干员页.md',
  });

  it('defuddle 结果对可见文本覆盖率过低时，改用全文兜底结果', async () => {
    const visibleText = `基础资料内容\n语音内容一，这是足够长的一行语音文本。\n语音内容二，这是另一条语音。`;
    let deepCalled = false;
    const r = await importFromFetched(
      `<html><body><div id="root"></div></body></html>`,
      URL,
      async () => ({ html: '<table></table>', finalUrl: URL, visibleText }),
      undefined,
      { convert: convertDropsVoice, convertDeep: async () => { deepCalled = true; return convertDeepKeepsAll(); } },
    );
    expect(deepCalled).toBe(true);
    expect(r.markdown).toContain('语音内容一');
    expect(r.markdown).toContain('语音内容二');
  });

  it('覆盖率足够时不触发全文兜底', async () => {
    const visibleText = `基础资料内容`;
    let deepCalled = false;
    const r = await importFromFetched(
      `<html><body><div id="root"></div></body></html>`,
      URL,
      async () => ({ html: '<table></table>', finalUrl: URL, visibleText }),
      undefined,
      {
        convert: async () => ({ title: '干员页', site: '', markdown: '基础资料内容', bodyMd: '基础资料内容', filename: '干员页.md' }),
        convertDeep: async () => { deepCalled = true; return convertDeepKeepsAll(); },
      },
    );
    expect(deepCalled).toBe(false);
    expect(r.markdown).toBe('基础资料内容');
  });
});

describe('importFromFetched：静态/渲染择优编排', () => {
  it('静态正文足够时不触发渲染', async () => {
    let called = false;
    const page = `<html><body><main>${'很长的正文内容。'.repeat(120)}</main></body></html>`;
    const r = await importFromFetched(page, URL, async () => { called = true; return null; });
    expect(called).toBe(false);
    expect(r.markdown).toContain('很长的正文内容');
  });

  it('静态正文过短时尝试渲染并采纳更优结果', async () => {
    const thin = `<html><body><div id="root"></div></body></html>`;
    const rendered = `<html><body><main>${'渲染后的完整正文内容。'.repeat(80)}</main></body></html>`;
    let called = false;
    const r = await importFromFetched(thin, URL, async () => {
      called = true;
      return { html: rendered, finalUrl: URL };
    });
    expect(called).toBe(true);
    expect(r.markdown).toContain('渲染后的完整正文内容');
  });

  it('渲染失败或更差时回退静态结果', async () => {
    const thin = `<html><body><main>短正文内容。</main></body></html>`;
    const r = await importFromFetched(thin, URL, async () => null);
    expect(r.markdown).toContain('短正文内容');
  });

  it('静态与渲染均失败时，错误信息包含渲染失败原因', async () => {
    const thin = `<html><body><div id="root"></div></body></html>`;
    await expect(
      importFromFetched(thin, URL, async () => {
        throw new Error('渲染超时：页面加载未在限时内完成');
      }),
    ).rejects.toThrow(/渲染超时/);
  });
});

describe('extractMainContent：defuddle 失效时的正文兜底梯子', () => {
  it('命中 role=main 容器', () => {
    const html = `<html><body><nav>首页 随机页面 最近更改</nav><div role="main"><h1>目标正文标题</h1><p>${'正文段落内容。'.repeat(50)}</p></div><footer>免责声明</footer></body></html>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    const content = extractMainContent(doc);
    expect(content).toContain('目标正文标题');
    expect(content).not.toContain('免责声明');
  });

  it('无语义容器时退化为 body 清理（剔除 nav/footer/script）', () => {
    const html = `<html><body><nav>导航导航导航</nav><script>var x=1;</script><div class="content"><p>${'文章正文内容。'.repeat(50)}</p></div><footer>页脚页脚页脚</footer></body></html>`;
    const doc = parse(html);
    structuralizeDoc(doc);
    const content = extractMainContent(doc);
    expect(content).toContain('文章正文内容');
    expect(content).not.toContain('页脚页脚页脚');
    expect(content).not.toContain('导航导航导航');
  });
});

describe('importFromHtml 集成：结构化重写贯通整条管线', () => {
  it('真实片段整页导入后，grid 成为 GFM 表格、chips 带分隔、徽章不黏连', async () => {
    const page = `<!DOCTYPE html><html><head><title>艾尔黛拉</title></head><body><main>${GRID3}${FLEX4}${CHIPS}${NAME_ROW}</main></body></html>`;
    const result = await importFromHtml(page, URL);
    expect(result.markdown).toMatch(/❤️ 生命值\s*\|\s*⚔️ 攻击力\s*\|\s*🛡️ 防御力/);
    expect(result.markdown).toMatch(/\|\s*500\s*\|\s*30\s*\|\s*0\s*\|/);
    expect(result.markdown).toMatch(/辅助\s*·\s*自然\s*·\s*施术单元\s*·\s*罗德岛/);
    expect(result.markdown).toMatch(/岩石的轻语 {2}\n普通攻击/);
    expect(result.title).toBe('艾尔黛拉');
  });
});
