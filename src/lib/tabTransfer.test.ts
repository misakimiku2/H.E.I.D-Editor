import { describe, expect, it } from 'vitest';
import { serializeTab, deserializeTab, isTabTransferPayload, isSessionPayload, EV_TAB_DRAG_HOVER, EV_TAB_DRAG_LEAVE, EV_TAB_TRANSFER, EV_TAB_ADOPTED, makeTransferId } from './tabTransfer';
import { makeUntitledTab, makeWelcomeTab } from './tabModel';

/** 构造一个带句柄与跳转请求的完整标签(handle 为浏览器 API,不可跨窗口序列化) */
function fullTab() {
  return {
    ...makeUntitledTab('demo.md'),
    language: 'markdown',
    mdView: 'split' as const,
    isDirty: true,
    content: '# hello',
    handle: { kind: 'file' } as unknown as FileSystemFileHandle,
    jumpRequest: { line: 3, col: 1, seq: 7 },
  };
}

describe('serializeTab / deserializeTab', () => {
  it('往返保留全部业务字段', () => {
    const raw = serializeTab(fullTab());
    const back = deserializeTab(raw, true);
    expect(back).not.toBeNull();
    expect(back!.title).toBe('demo.md');
    expect(back!.language).toBe('markdown');
    expect(back!.mdView).toBe('split');
    expect(back!.isDirty).toBe(true);
    expect(back!.content).toBe('# hello');
  });

  it('剔除运行时瞬态字段 handle / jumpRequest', () => {
    const raw = serializeTab(fullTab());
    expect('handle' in raw).toBe(false);
    expect('jumpRequest' in raw).toBe(false);
    const back = deserializeTab(raw)!;
    expect(back.handle).toBeNull();
    expect(back.jumpRequest).toBeUndefined();
  });

  it('重发 id:同一标签在两窗口各持独立 id(adopt 时 forceNewId)', () => {
    const raw = serializeTab(fullTab());
    const a = deserializeTab(raw, true)!;
    const b = deserializeTab(raw, true)!;
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(raw.id);
  });

  it('保留原 id:deserializeTab 不传 forceNewId', () => {
    const raw = serializeTab(fullTab());
    expect(deserializeTab(raw)!.id).toBe(raw.id);
  });

  it('畸形载荷返回 null:缺关键字段/类型不对逐项拒绝', () => {
    expect(deserializeTab(null as never)).toBeNull();
    expect(deserializeTab({} as never)).toBeNull();
    expect(deserializeTab({ title: 3, path: null, content: '', originalContent: '', language: 'md', isDirty: false, readOnly: false, mdView: 'edit', encoding: 'utf-8', bom: false, eol: 'lf', originalEol: 'lf' } as never)).toBeNull();
  });

  it('非法 mdView 收敛为 edit(向前兼容)', () => {
    const raw = serializeTab(fullTab()) as Record<string, unknown>;
    raw.mdView = 'bogus';
    expect(deserializeTab(raw as never)!.mdView).toBe('edit');
  });
});

describe('载荷类型守卫', () => {
  it('isTabTransferPayload:kind=tab 且 tab 为对象', () => {
    const p = { kind: 'tab', from: 'main', transferId: 't1', dragId: 'd1', tab: serializeTab(fullTab()) };
    expect(isTabTransferPayload(p)).toBe(true);
    expect(isTabTransferPayload({ kind: 'tab', tab: null })).toBe(false);
    expect(isTabTransferPayload({ kind: 'session' })).toBe(false);
    expect(isTabTransferPayload(null)).toBe(false);
  });

  it('isSessionPayload:kind=session 且 state.tabs 为数组', () => {
    expect(isSessionPayload({ kind: 'session', state: { tabs: [], activePath: null } })).toBe(true);
    expect(isSessionPayload({ kind: 'session', state: { tabs: 'x' } })).toBe(false);
    expect(isSessionPayload({ kind: 'tab' })).toBe(false);
  });
});

describe('事件名与 id', () => {
  it('事件名常量使用 heid- 前缀命名空间', () => {
    for (const ev of [EV_TAB_DRAG_HOVER, EV_TAB_DRAG_LEAVE, EV_TAB_TRANSFER, EV_TAB_ADOPTED]) {
      expect(ev.startsWith('heid-tab-')).toBe(true);
    }
  });

  it('makeTransferId 唯一(同批多次调用不重复)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeTransferId()));
    expect(ids.size).toBe(50);
  });
});

describe('welcome 标签可序列化', () => {
  it('welcome(无路径固定 id)序列化往返不丢内容', () => {
    const w = makeWelcomeTab();
    const back = deserializeTab(serializeTab(w), true)!;
    expect(back.content).toBe(w.content);
    expect(back.path).toBeNull();
  });
});
