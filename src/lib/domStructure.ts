/**
 * 网址导入的 DOM 结构化预处理：
 * 现代站点（Tailwind 系工具类尤其普遍）常用 div 卡片网格冒充表格，turndown 只能
 * 把它们摊成散行、徽章与标题黏连。这里在 defuddle 提取之前做一遍保守重写：
 *   R1 网格/弹性卡片组（同构、短文本）→ 语义 <table>（≤8 卡）或列表（>8 卡）
 *   R2 flex-wrap 单叶 chips 行 → 项间插入「 · 」分隔
 *   R3 flex 行内名称+徽章（单叶）→ 项间插入 <br> 换行；
 *      标签值对（首叶冒号结尾 / 纵向排列）→ 合并为一行「标签: 值」
 *   R4 纯装饰字符（· / | / - …）组成的 chips 行 → 整块删除
 *   R5 小型交互控件（含 <button> 且可见文本极少，如等级步进器、标签页切换）→ 整块删除
 * 全部基于 class 工具类信号 + 同构性约束，任一不满足即保持原 DOM（等于现有行为）。
 * 最深节点优先处理，已重写区域的子孙不再重复命中。
 */

/** 卡片文本长度上限：超过视为正文段落而非标签/数值卡 */
const MAX_CARD_TEXT = 60;
/** chip 文本长度上限 */
const MAX_CHIP_TEXT = 20;
/** chip 文本下限：单字符多为装饰点/分隔符，不是标签 */
const MIN_CHIP_TEXT = 2;
/** 表格最多列数，超出退化为列表 */
const MAX_TABLE_COLS = 8;
/** 交互控件可见文本上限：超过视为正文卡片（可能只是带按钮），不删 */
const MAX_CONTROL_TEXT = 200;

/** 纯装饰字符（分隔点、竖线、短横线等），单字符或 3 字符内组合 */
const DECORATION_ONLY = /^[·•・\-–—|/]+$/;

const endsWithColon = (t: string): boolean => /[：:]$/.test(t);

const classTokens = (el: Element): string[] =>
  typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [];

/** grid 工具类：grid / grid-cols-N / sm:grid-cols-N（冒号前缀为响应式变体） */
const hasGridClass = (el: Element): boolean =>
  classTokens(el).some(t => /(^|:)grid(-cols-\d+)?$/.test(t));

const hasFlexClass = (el: Element): boolean => classTokens(el).includes('flex');
const hasFlexWrap = (el: Element): boolean => classTokens(el).includes('flex-wrap');
const hasFlexCol = (el: Element): boolean => classTokens(el).some(t => /(^|:)flex-col$/.test(t));
const hasGapClass = (el: Element): boolean => classTokens(el).some(t => /(^|:)gap-\d+/.test(t));

/** 叶子文本元素：无元素子节点且自身带非空白文本（含元素本身是叶子的情况） */
const textLeaves = (el: Element): Element[] => {
  if (el.childElementCount === 0) {
    return (el.textContent ?? '').trim().length > 0 ? [el] : [];
  }
  return Array.from(el.querySelectorAll('*')).filter(
    n => n.childElementCount === 0 && (n.textContent ?? '').trim().length > 0,
  );
};

const normText = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

/** 容器夹带的裸文本（工具类布局不应有；有则说明结构不干净，跳过） */
const hasDirectText = (el: Element): boolean =>
  Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u;

/* ---- R1：网格卡片 → 表格 / 列表 ---- */

interface CardCells {
  label: string;
  value: string;
}

/** 卡片子元素的（标签, 数值）拆分；结构不齐时返回 null */
function cardCells(child: Element): CardCells | null {
  if (child.querySelector('table, ul, ol, h1, h2, h3, h4, h5, h6')) return null;
  const leaves = textLeaves(child);
  if (leaves.length < 2 || leaves.length > 4) return null;
  if (normText(child).length > MAX_CARD_TEXT) return null;
  const texts = leaves.map(l => normText(l));
  return { label: texts.slice(0, -1).join(' '), value: texts[texts.length - 1] };
}

/** 同构卡片组：全部子元素同标签、叶数一致且在 2..4 */
function uniformCards(container: Element): CardCells[] | null {
  const children = Array.from(container.children);
  if (children.length < 2 || children.length > 24) return null;
  if (hasDirectText(container)) return null;
  if (new Set(children.map(c => c.tagName)).size !== 1) return null;
  if (container.querySelector('table')) return null;
  const cells = children.map(cardCells);
  if (cells.some(c => c === null)) return null;
  const leafCounts = children.map(c => textLeaves(c).length);
  if (new Set(leafCounts).size !== 1) return null;
  return cells as CardCells[];
}

function buildTable(doc: Document, cells: CardCells[]): HTMLTableElement {
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const c of cells) {
    const th = doc.createElement('th');
    th.textContent = c.label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = doc.createElement('tbody');
  const bodyRow = doc.createElement('tr');
  for (const c of cells) {
    const td = doc.createElement('td');
    td.textContent = c.value;
    bodyRow.appendChild(td);
  }
  tbody.appendChild(bodyRow);
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function buildDefList(doc: Document, cells: CardCells[]): HTMLUListElement {
  const ul = doc.createElement('ul');
  for (const c of cells) {
    const li = doc.createElement('li');
    const strong = doc.createElement('strong');
    strong.textContent = c.label;
    li.appendChild(strong);
    li.appendChild(doc.createTextNode(`: ${c.value}`));
    ul.appendChild(li);
  }
  return ul;
}

/* ---- R7：表格规整 ----
   turndown-gfm 只转换「首行全 <th>」的表格，其余原样透传成 HTML。
   这里把 colgroup/单元格块级内容规整后，再做二选一：
   - 2 列且首列非空的表 → 标签值列表（<ul><li>标签: 值</li>…）
   - 其余无表头的表 → 首行提升为 <thead> 表头 */

/** 移除 colgroup/caption、摊平单元格块级内容，并按上表策略修复无表头表格 */
export function normalizeTables(doc: Document): void {
  flattenNestedTables(doc);
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    table.querySelectorAll('colgroup, caption').forEach(c => c.remove());
    for (const cell of Array.from(table.querySelectorAll('td, th'))) {
      const blocks = Array.from(cell.children).filter(c => /^(p|div|li)$/i.test(c.tagName));
      if (blocks.length === 0) continue;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (i < blocks.length - 1) b.after(doc.createTextNode(' '));
        b.replaceWith(...Array.from(b.childNodes));
      }
    }
    normalizeTableHead(doc, table);
  }
}

/** 首行是否已是表头（thead 内，或表首行且单元格全为 th） */
function hasHeadingRow(table: HTMLTableElement): boolean {
  const first = table.rows?.[0];
  if (!first) return true;
  if (first.parentElement?.tagName === 'THEAD') return true;
  return first.parentElement?.firstElementChild === first
    && Array.from(first.children).every(c => c.tagName === 'TH');
}

/**
 * 摊平嵌套表格（MediaWiki navbox 模板动辄十几层嵌套）：defuddle 提取深嵌套表格时
 * 序列化不配对，会把内层 <tr>/<td> 拆成孤儿碎片漏进 Markdown。这里把 td 内的内层
 * 表格按行转成段落文本（首格之外的单元格以空格连接），最深优先处理多层嵌套。
 */
function flattenNestedTables(doc: Document): void {
  const nested = Array.from(doc.querySelectorAll('td table, th table'));
  const depthOf = (el: Element): number => {
    let d = 0;
    let cur: Element | null = el;
    while (cur) {
      d += 1;
      cur = cur.parentElement;
    }
    return d;
  };
  nested.sort((a, b) => depthOf(b) - depthOf(a));
  for (const inner of nested) {
    if (!inner.isConnected) continue;
    const container = doc.createDocumentFragment();
    for (const tr of Array.from(inner.querySelectorAll('tr'))) {
      const cells = Array.from(tr.querySelectorAll(':scope > td, :scope > th'));
      if (cells.length === 0) continue;
      const p = doc.createElement('p');
      for (let i = 0; i < cells.length; i++) {
        if (i > 0) p.appendChild(doc.createTextNode(' '));
        for (const n of Array.from(cells[i].childNodes)) p.appendChild(n.cloneNode(true));
      }
      container.appendChild(p);
    }
    inner.replaceWith(container);
  }
}

function normalizeTableHead(doc: Document, table: HTMLTableElement): void {
  if (hasHeadingRow(table)) return;
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return;

  const firstCells = Array.from(rows[0].querySelectorAll(':scope > td, :scope > th'));
  /* 2 列且每行首列非空：标签值列表 */
  if (firstCells.length === 2
    && rows.every(tr => {
      const cells = tr.querySelectorAll(':scope > td, :scope > th');
      return cells.length === 2 && (cells[0].textContent ?? '').trim().length > 0;
    })) {
    const ul = doc.createElement('ul');
    for (const tr of rows) {
      const [label, value] = Array.from(tr.querySelectorAll(':scope > td, :scope > th'));
      const li = doc.createElement('li');
      for (const n of Array.from(label.childNodes)) li.appendChild(n.cloneNode(true));
      li.appendChild(doc.createTextNode(': '));
      for (const n of Array.from(value.childNodes)) li.appendChild(n.cloneNode(true));
      ul.appendChild(li);
    }
    table.replaceWith(ul);
    return;
  }

  /* 首行提升为表头 */
  const thead = doc.createElement('thead');
  const headTr = doc.createElement('tr');
  for (const c of firstCells) {
    const th = doc.createElement('th');
    th.innerHTML = c.innerHTML;
    headTr.appendChild(th);
  }
  thead.appendChild(headTr);
  rows[0].remove();
  table.insertBefore(thead, table.firstChild);
}

/* ---- 提取兜底梯子：defuddle 返回空内容时的最后手段 ---- */

/** 常见正文容器选择器，按优先级；文本量达标即采用 */
const MAIN_SELECTORS = [
  '[role="main"]', 'main', 'article',
  '#content', '#mw-content-text', '.mw-parser-output', '#bodyContent',
];

/** 兜底提取：优先语义正文容器，全部落空则取剔除噪音容器后的 body。返回 innerHTML。 */
export function extractMainContent(doc: Document): string {
  for (const sel of MAIN_SELECTORS) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, '').trim();
    if (text.length >= 200) return el.innerHTML;
  }
  const clone = doc.body.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      'script, style, noscript, nav, header, footer, aside, form, iframe, [role="navigation"], .noprint, .printfooter',
    )
    .forEach(n => n.remove());
  return clone.innerHTML;
}

/* ---- 主入口 ---- */

export interface TabGroupEntry {
  label: string;
  /** 图片面板锚：面板首图的 src（图片组） */
  imgSrc: string;
  /** 文本面板锚：面板首个短文本叶（技能/材料等内容组），用于在 markdown 中定位 */
  textAnchor: string;
}

/**
 * R8/R9：页签组识别（库街区等站点用「标签组 + 等量内容面板」做立绘/资料/技能
 * 切换，平铺提取后图片、文本与标签的对应关系丢失）。两种面板形态：
 *   R8 图片面板盒——全部子元素恰为「单图无文本」；
 *   R9 内容面板盒——2~8 个子元素都有实际内容，且恰好一个可见、
 *      其余为内联 display:none（Vue v-show 式隐藏，序列化 HTML 可读）。
 * 面板盒允许沿单子链下钻找到（库街区面板外包一层 component-content-inner）。
 * 同子树内标签盒子项数与面板盒子元素数一致时，收集（标签, 锚点）配对；
 * 调用方在 markdown 转换后按锚点回插 `<!-- tab:标签 -->` 标记。
 * 注意：只读不改 DOM——defuddle 会剥掉注释与自定义属性，标记必须在
 * markdown 层回插（见 urlImport.insertTabMarkers）。
 */
export function collectTabGroups(doc: Document): TabGroupEntry[][] {
  const groups: TabGroupEntry[][] = [];
  const isLabelBox = (el: Element): boolean => {
    const n = el.childElementCount;
    if (n < 2 || n > 8) return false;
    /* 标签子项允许少量结构性子元素（库街区 .role-tag-item = 文本叶 + 空装饰叶），
       但子项自身及其后代不得夹带图片/链接/按钮，且合并文本须短——否则视为正文 */
    return Array.from(el.children).every(c => {
      if (/^(img|svg|a|button)$/i.test(c.tagName)) return false;
      if (c.querySelector('img, svg, a, button')) return false;
      if (c.childElementCount > 4) return false;
      const t = normText(c);
      return t.length >= 1 && t.length <= 20;
    });
  };
  const isImagePanelBox = (el: Element): boolean => {
    const n = el.childElementCount;
    if (n < 2 || n > 8) return false;
    return Array.from(el.children).every(c => {
      const imgs = c.querySelectorAll('img');
      return imgs.length === 1 && normText(c).length === 0;
    });
  };
  const isInlineHidden = (el: Element): boolean =>
    /(^|;)\s*display\s*:\s*none/i.test(el.getAttribute('style') ?? '');
  const hasRealContent = (el: Element): boolean =>
    normText(el).length >= 6 || el.querySelector('img, table') !== null;
  const isContentPanelBox = (el: Element): boolean => {
    const n = el.childElementCount;
    if (n < 2 || n > 8) return false;
    let visible = 0;
    for (const c of Array.from(el.children)) {
      if (!hasRealContent(c)) return false;
      if (isInlineHidden(c)) continue;
      visible++;
    }
    /* 页签切换态：恰好一个面板可见，其余内联隐藏——普通版式不会这样堆叠 */
    return visible === 1;
  };
  /* 面板盒可能外包多层单子容器（库街区 component-content > inner） */
  const unwrapSingle = (el: Element): Element => {
    let cur = el;
    while (cur.childElementCount === 1) cur = cur.firstElementChild!;
    return cur;
  };
  const firstTextLeaf = (el: Element): string => {
    /* 优先取混合内容元素里的直接短文本（如 <p><img>抓拍</p> 的“抓拍”），
       而非更长的段落叶——短文本在 markdown 中更可能原样保留 */
    const scan = (node: Element): string => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE) {
          const t = (n.textContent ?? '').trim();
          if (t.length >= 2 && t.length <= 24 && !EMOJI_ONLY.test(t)) return t;
        }
      }
      for (const c of Array.from(node.children)) {
        const r = scan(c);
        if (r) return r;
      }
      return '';
    };
    return scan(el);
  };
  for (const lab of Array.from(doc.querySelectorAll('body *'))) {
    if (!isLabelBox(lab)) continue;
    let anc: Element | null = lab.parentElement;
    let hops = 0;
    let found: Element | null = null;
    while (anc && hops < 4 && !found) {
      for (const cand of Array.from(anc.children)) {
        if (cand === lab || cand.contains(lab) || lab.contains(cand)) continue;
        const box = cand.childElementCount === 1 ? unwrapSingle(cand) : cand;
        if (box === lab || box.contains(lab) || lab.contains(box)) continue;
        if (isImagePanelBox(box) || isContentPanelBox(box)) {
          found = box;
          break;
        }
      }
      anc = anc.parentElement;
      hops++;
    }
    if (!found) continue;
    /* 标签文本：末尾的独立 “x/×” 是站点自带的关闭钮文案（GF2 等），剥掉 */
    const labels = Array.from(lab.children).map(c =>
      normText(c).replace(/\s*[×xX]\s*$/, '').trim(),
    );
    const panels = Array.from(found.children);
    if (labels.length !== panels.length) continue;
    const entries = panels.map((p, i) => {
      const img = p.querySelector('img');
      return {
        label: labels[i],
        imgSrc: img?.getAttribute('src') ?? '',
        textAnchor: firstTextLeaf(p),
      };
    });
    /* 空标签（剥 x 后）无法构成页签，整组放弃 */
    if (entries.some(e => !e.label)) continue;
    /* 图片组与内容组都要求锚点可用，否则 markdown 层无法回插 */
    if (entries.some(e => !e.imgSrc && !e.textAnchor)) continue;
    groups.push(entries);
  }
  return groups;
}

export function structuralizeDoc(doc: Document): void {
  const body = doc.body;
  if (!body) return;
  /* 最深优先：内层卡片行先于外层网格处理，重写后的 table 子树不再参与 */
  const all = Array.from(body.querySelectorAll('*')).sort(
    (a, b) => depth(b) - depth(a),
  );
  for (const el of all) {
    if (!el.isConnected) continue;
    if (el.closest('table')) continue;
    const tokens = classTokens(el);
    const isFlex = tokens.includes('flex');

    /* R5：小交互控件（含 <button> 且可见文本极少）整体删除 */
    if (el.querySelector('button') && normText(el).length <= MAX_CONTROL_TEXT) {
      el.remove();
      continue;
    }

    /* R1：网格 / 弹性卡片组（grid 类，或 flex+gap 的横向滚动卡片） */
    if ((hasGridClass(el) || (isFlex && hasGapClass(el) && !hasFlexWrap(el) && !hasFlexCol(el)))
      && !hasFlexCol(el)) {
      const cells = uniformCards(el);
      if (cells) {
        const count = Array.from(el.children).length;
        el.replaceWith(count <= MAX_TABLE_COLS ? buildTable(doc, cells) : buildDefList(doc, cells));
        continue;
      }
    }

    /* R4：纯装饰字符行（分隔点等，不要求 flex-wrap）整块删除 */
    if (isFlex) {
      const children = Array.from(el.children);
      if (children.length >= 2 && !hasDirectText(el)
        && children.every(c => c.childElementCount === 0 && DECORATION_ONLY.test(normText(c)))) {
        el.remove();
        continue;
      }
    }

    /* R2：flex-wrap chips 行 */
    if (isFlex && hasFlexWrap(el)) {
      const children = Array.from(el.children);
      if (children.length >= 3 && !hasDirectText(el)
        && new Set(children.map(c => c.tagName)).size === 1
        && children.every(c => {
          const leaves = textLeaves(c);
          const t = normText(c);
          return leaves.length === 1 && t.length >= MIN_CHIP_TEXT && t.length <= MAX_CHIP_TEXT;
        })) {
        for (let i = 1; i < children.length; i++) {
          el.insertBefore(doc.createTextNode(' · '), children[i]);
        }
        continue;
      }
    }

    /* R3：flex 行内 2~3 个单叶元素。默认拆行（名称+徽章）；
       标签值对（首叶冒号结尾 / 纵向排列）合并为一行「标签: 值」 */
    if (isFlex && !hasFlexWrap(el)) {
      const children = Array.from(el.children);
      if (children.length >= 2 && children.length <= 3 && !hasDirectText(el)
        && children.every(c => {
          if (c.childElementCount !== 0) return false;
          const t = normText(c);
          return t.length >= 2 && !EMOJI_ONLY.test(t);
        })) {
        const first = normText(children[0]);
        const colonPair = endsWithColon(first);
        if (colonPair || hasFlexCol(el)) {
          for (let i = 1; i < children.length; i++) {
            const sep = i === 1 && !colonPair ? ': ' : ' ';
            el.insertBefore(doc.createTextNode(sep), children[i]);
          }
        } else {
          for (let i = 1; i < children.length; i++) {
            el.insertBefore(doc.createElement('br'), children[i]);
          }
        }
        continue;
      }
    }
  }
}

function depth(el: Element): number {
  let d = 0;
  let cur: Element | null = el;
  while (cur) {
    d += 1;
    cur = cur.parentElement;
  }
  return d;
}
