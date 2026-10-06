// @vitest-environment jsdom
/**
 * DiffModal 冒烟：外部修改合并成条 + 对比区 hunk 折叠
 * ① 长文件里改一行，对比区只铺变更块 ± 3 行，未变更区域折成可点开的条；
 * ② 折叠条点开就地展开、再点收起把手折回；「展开未变更区域」一次铺开整份；
 * ③ 工具条报出变更处数，两处远离的变更各自成块；
 * ④ 一条外部变更由多次写入合并而来时，左侧显示合并次数，展开能逐步下钻；
 * ⑤ 下钻到某一步时接受/撤销仍然作用于整条（回调拿到的是条目 id）；
 * ⑥ 分批间隔只出现在「外部修改」页。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffModal } from './DiffModal';
import { I18nProvider } from '../lib/i18nContext';
import {
  appendExternalChange,
  type CoalesceWindow,
  type ExternalDiffEntry,
} from '../lib/diffTimeline';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FILE = '/tmp/demo.txt';
/** 40 行基准文件 L1..L40 */
const BASE = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
/** 把第 n 行（1-based）换成 given */
const withLine = (text: string, n: number, given: string) => text.replace(`L${n}\n`, `${given}\n`);

/**
 * 让同一个文件被外部连写 count 次（每次改一行），按现在的语义合成一条待处理变更。
 * 默认改第 5/15/25/35 行——彼此隔开 9 行，超过 2×上下文，各自成一处变更。
 */
function mergedTimeline(count: number, at: (i: number) => number = i => 5 + i * 10): Record<string, ExternalDiffEntry[]> {
  let tl = appendExternalChange([], BASE, withLine(BASE, at(0), 'E0'), 1000);
  for (let i = 1; i < count; i++) {
    const prev = tl[0].after;
    tl = appendExternalChange(tl, prev, withLine(prev, at(i), `E${i}`), 1000 + i);
  }
  return { [FILE]: tl };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
const accept = vi.fn();
const acceptAll = vi.fn();
const revert = vi.fn();

interface Overrides {
  externalTimelines?: Record<string, ExternalDiffEntry[]>;
  internalTimelines?: Record<string, ExternalDiffEntry[]>;
  batchWindow?: CoalesceWindow;
  externalWatch?: boolean;
  asPage?: boolean;
  onClose?: () => void;
}

function renderModal(o: Overrides = {}) {
  accept.mockClear();
  acceptAll.mockClear();
  revert.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider lang="zh">
        <DiffModal
          externalTimelines={o.externalTimelines ?? mergedTimeline(1)}
          internalTimelines={o.internalTimelines ?? {}}
          isDarkMode={false}
          focusPath={null}
          maxEntries={30}
          onChangeMaxEntries={vi.fn()}
          batchWindow={o.batchWindow ?? 0}
          externalWatch={o.externalWatch ?? true}
          asPage={o.asPage ?? false}
          onChangeBatchWindow={vi.fn()}
          onClose={o.onClose ?? vi.fn()}
          onAccept={accept}
          onAcceptAll={acceptAll}
          onRevert={revert}
        />
      </I18nProvider>
    );
  });
}

/** 让 useMediaQuery 认为处于窄壳；必须在 renderModal 之前装好（初始值就读 matchMedia） */
function setNarrow(on: boolean) {
  (window as any).matchMedia = (q: string) => ({
    matches: on && /max-width/.test(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  delete (window as any).matchMedia;
});

const buttons = () => [...container!.querySelectorAll('button')];
const byTitle = (title: string) => buttons().find(b => b.title === title);
const byText = (needle: string) => buttons().find(b => (b.textContent ?? '').includes(needle));
/** 文案完全相等（页脚现在同时有「全部接受」和「接受」，includes 会认错） */
const byExact = (needle: string) => buttons().find(b => (b.textContent ?? '').trim() === needle);
/** 对比区里当前铺出来的行数 */
const visibleRows = () => container!.querySelectorAll('[data-diff-row]').length;
/** 所有折叠条 */
const foldBars = () => buttons().filter(b => (b.textContent ?? '').includes('行未变更'));
/** 过程子列表里的步按钮 */
const stepButtons = () => buttons().filter(b => /^第 \d+ 步/.test((b.textContent ?? '').trim()));
const text = () => container!.textContent ?? '';

function click(el: Element | null | undefined) {
  act(() => { (el as HTMLElement | undefined)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('DiffModal：对比区 hunk 折叠', () => {
  it('40 行里改第 20 行：只铺变更块 ± 3 行，首尾各一条折叠', () => {
    const one = appendExternalChange([], BASE, withLine(BASE, 20, 'CHANGED'), 1000);
    renderModal({ externalTimelines: { [FILE]: one } });
    expect(visibleRows()).toBe(7);
    const folds = foldBars();
    expect(folds).toHaveLength(2);
    expect(folds[0].textContent).toContain('展开 16 行未变更');
    expect(folds[1].textContent).toContain('展开 17 行未变更');
    expect(text()).toContain('1 处变更');
  });

  it('点折叠条就地展开那一段，再点收起把手折回去', () => {
    const one = appendExternalChange([], BASE, withLine(BASE, 20, 'CHANGED'), 1000);
    renderModal({ externalTimelines: { [FILE]: one } });
    click(foldBars()[0]);
    expect(visibleRows()).toBe(7 + 16);
    expect(foldBars()).toHaveLength(1);                  // 尾部那条还折着
    click(byText('折叠未变更区域'));
    expect(visibleRows()).toBe(7);
    expect(foldBars()).toHaveLength(2);
  });

  it('「展开未变更区域」一次铺开整份，再点折回', () => {
    const one = appendExternalChange([], BASE, withLine(BASE, 20, 'CHANGED'), 1000);
    renderModal({ externalTimelines: { [FILE]: one } });
    click(byTitle('展开未变更区域'));
    expect(visibleRows()).toBe(40);
    expect(foldBars()).toHaveLength(0);
    click(byTitle('折叠未变更区域'));
    expect(visibleRows()).toBe(7);
  });

  it('两处远离的变更各自成块，工具条报 2 处', () => {
    const two = appendExternalChange([], BASE, withLine(withLine(BASE, 3, 'A'), 35, 'B'), 1000);
    renderModal({ externalTimelines: { [FILE]: two } });
    expect(text()).toContain('2 处变更');
    expect(foldBars()).toHaveLength(2);                  // 中间那段 + 尾部
    expect(visibleRows()).toBe(6 + 7);
  });

  it('内容完全相同：报「无变更」，整份折成一段，一行都不铺', () => {
    const same: ExternalDiffEntry = { id: 'same', before: BASE, after: BASE, detectedAt: 1000 };
    renderModal({ externalTimelines: { [FILE]: [same] } });
    expect(text()).toContain('无变更');
    expect(visibleRows()).toBe(0);
    expect(foldBars()).toHaveLength(1);
    expect(foldBars()[0].textContent).toContain('展开 40 行未变更');
  });
});

describe('DiffModal：多次写入合并成一条待处理变更', () => {
  it('左侧显示合并次数，角标是一件事而不是四次写入', () => {
    renderModal({ externalTimelines: mergedTimeline(4) });
    expect(text()).toContain('合并 4 次写入');
    expect(text()).toContain('1 条未处理');
    /* 整条的对比是基线 → 最新：四处分散的改动 = 四处变更 */
    expect(text()).toContain('4 处变更');
  });

  it('展开过程子列表能逐步下钻，对比区换成那一次写入', () => {
    renderModal({ externalTimelines: mergedTimeline(3) });
    expect(stepButtons()).toHaveLength(0);
    click(byTitle('展开过程'));
    expect(stepButtons()).toHaveLength(3);

    click(stepButtons()[1]);
    /* 下钻到第 2 步：对比区只剩这一步的一处变更，并说清接受/撤销作用于整条 */
    expect(text()).toContain('1 处变更');
    expect(text()).toContain('正在看第 2 步；接受与撤销作用于整条（共 3 次写入）');
  });

  it('下钻到某一步时，接受报的仍然是整条的 id', () => {
    const timelines = mergedTimeline(3);
    const entryId = timelines[FILE][0].id;
    renderModal({ externalTimelines: timelines });
    click(byTitle('展开过程'));
    click(stepButtons()[2]);

    click(byExact('接受'));
    click(byExact('确认'));                               // 过二次确认
    expect(accept).toHaveBeenCalledWith('external', FILE, entryId);
  });

  it('只写过一次的条目不显示合并次数，也没有过程可展开', () => {
    renderModal({ externalTimelines: mergedTimeline(1) });
    expect(text()).not.toContain('次写入');
    expect(byTitle('展开过程')).toBeUndefined();
  });
});

describe('DiffModal：分批间隔设置', () => {
  it('外部修改页给出分批间隔下拉，当前档位可读', () => {
    renderModal({ batchWindow: 15 });
    expect(text()).toContain('分批间隔');
    expect(text()).toContain('15 分钟');
  });

  it('默认档位是「不分批」', () => {
    renderModal();
    expect(text()).toContain('不分批');
  });

  it('切到软件内修改页就收起（内部时间线按编辑爆发归条，用不上）', () => {
    renderModal({
      externalTimelines: mergedTimeline(1),
      internalTimelines: mergedTimeline(1),
    });
    click(byText('软件内修改'));
    expect(text()).not.toContain('分批间隔');
  });

  it('这台设备没有外部监听时不出现（安卓 / 浏览器模式），页脚因此不会被挤爆', () => {
    renderModal({ externalWatch: false });
    expect(text()).not.toContain('分批间隔');
    expect(text()).toContain('保留条数');
  });
});

describe('DiffModal：全部接受', () => {
  /** 两个文件各一条（其中一条由两次写入合并），共 2 条待处理 */
  const twoFiles = () => ({
    ...mergedTimeline(2),
    '/tmp/other.txt': appendExternalChange([], BASE, withLine(BASE, 30, 'Z'), 2000),
  });

  it('先过二次确认（说清条数），确认后回调带类别而不是某一条', () => {
    renderModal({ externalTimelines: twoFiles() });
    click(byExact('全部接受'));
    expect(acceptAll).not.toHaveBeenCalled();
    expect(text()).toContain('确认接受全部 2 条外部修改');
    click(byExact('确认'));
    expect(acceptAll).toHaveBeenCalledWith('external');
    expect(accept).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it('该类别没有条目时禁用', () => {
    renderModal({ externalTimelines: {} });
    expect((byExact('全部接受') as HTMLButtonElement).disabled).toBe(true);
  });

  it('切到软件内修改页时作用于内部时间线', () => {
    renderModal({ externalTimelines: mergedTimeline(1), internalTimelines: mergedTimeline(1) });
    click(byText('软件内修改'));
    click(byExact('全部接受'));
    click(byExact('确认'));
    expect(acceptAll).toHaveBeenCalledWith('internal');
  });
});

describe('DiffModal：窄壳单列铺法', () => {
  /* 窄壳下对比区改单栏：一处修改摊成 − / + 两行，所以 3+2+3 = 8 行，
     而宽壳双栏是 7 行。CSS 只负责藏左栏与换页脚，jsdom 量不到，那部分上机量。 */
  it('窄壳：修改处摊成 − / + 两行', () => {
    setNarrow(true);
    const one = appendExternalChange([], BASE, withLine(BASE, 20, 'CHANGED'), 1000);
    renderModal({ externalTimelines: { [FILE]: one } });
    expect(container!.querySelectorAll('[data-diff-row]')).toHaveLength(8);
  });

  it('宽壳：仍是双栏七行', () => {
    const one = appendExternalChange([], BASE, withLine(BASE, 20, 'CHANGED'), 1000);
    renderModal({ externalTimelines: { [FILE]: one } });
    expect(container!.querySelectorAll('[data-diff-row]')).toHaveLength(7);
  });

  it('窄壳：过程步在工具条上翻，翻回总账', () => {
    setNarrow(true);
    renderModal({ externalTimelines: mergedTimeline(3) });
    expect(text()).toContain('总账');
    click(byTitle('下一步'));
    expect(text()).toContain('第 1/3 步');
    click(byTitle('下一步'));
    expect(text()).toContain('第 2/3 步');
    click(byTitle('上一步'));
    click(byTitle('上一步'));
    expect(text()).toContain('总账');
    expect((byTitle('上一步') as HTMLButtonElement).disabled).toBe(true);
  });

  it('宽壳：不出现过程步翻页器（左栏有子列表）', () => {
    renderModal({ externalTimelines: mergedTimeline(3) });
    expect(byTitle('下一步')).toBeUndefined();
  });
});

describe('DiffModal：手机端整页形态（asPage）', () => {
  it('整页：有返回钮、没有遮罩、面板吃满整屏', () => {
    renderModal({ asPage: true, externalTimelines: mergedTimeline(1) });
    expect(container!.querySelector('[aria-label="返回"]')).toBeTruthy();
    expect(container!.querySelector('.backdrop-blur-sm')).toBeNull();
    expect([...container!.querySelectorAll('div')]
      .some(d => (d.className || '').includes('w-full h-full'))).toBe(true);
  });

  it('弹窗形态：没有返回钮、有遮罩', () => {
    renderModal({ externalTimelines: mergedTimeline(1) });
    expect(container!.querySelector('[aria-label="返回"]')).toBeNull();
    expect(container!.querySelector('.backdrop-blur-sm')).toBeTruthy();
  });

  it('整页：类别切换单独一行，两颗等宽铺满', () => {
    renderModal({
      asPage: true,
      externalTimelines: mergedTimeline(1),
      internalTimelines: mergedTimeline(1),
    });
    const tabs = [...container!.querySelectorAll('button')]
      .filter(b => /外部修改|软件内修改/.test((b.textContent || '').trim()));
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect((tab.className || '').includes('flex-1')).toBe(true);
  });

  it('整页：返回钮点下去走 onClose', () => {
    const onClose = vi.fn();
    renderModal({ asPage: true, externalTimelines: mergedTimeline(1), onClose });
    click(container!.querySelector('[aria-label="返回"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
