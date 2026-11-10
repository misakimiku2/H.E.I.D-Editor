import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, platform } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  platform: { tauri: true },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./fileIO', () => ({
  get isTauri() {
    return platform.tauri;
  },
}));

import { buildMdIndex, searchMdIndex, releaseMdIndex, renderMarkdownHtmlChunks } from './mdSearchBridge';

beforeEach(() => {
  invokeMock.mockReset();
  platform.tauri = true;
});

describe('mdSearchBridge', () => {
  it('非 Tauri 环境直接返回 null，不调用 invoke', async () => {
    platform.tauri = false;
    expect(await buildMdIndex('内容', 'key')).toBeNull();
    expect(await searchMdIndex(1, { query: 'x', caseSensitive: false, regexp: false, wholeWord: false })).toBeNull();
    await releaseMdIndex(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('建立索引按 camelCase 传 cacheKey/content', async () => {
    const info = { id: 7, indexMs: 12, reused: false, contentHash: 'abc' };
    invokeMock.mockResolvedValue(info);
    await expect(buildMdIndex('内容', 'doc:42')).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith('md_index_build', { cacheKey: 'doc:42', content: '内容' });
  });

  it('查找按 camelCase 传 indexId/options', async () => {
    const result = {
      total: 1, capped: false, indexMs: 5, searchMs: 1, error: null,
      matches: [{ sourceStart: 10, sourceEnd: 12, text: '重点', textTruncated: false, snippet: '重点' }],
    };
    invokeMock.mockResolvedValue(result);
    const options = { query: '重点', caseSensitive: false, regexp: false, wholeWord: true, maxResults: 5000 };
    await expect(searchMdIndex(7, options)).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith('md_search', { indexId: 7, options });
  });

  it('命令失败返回 null（调用方回退 DOM 查找）', async () => {
    invokeMock.mockRejectedValue(new Error('索引已失效'));
    expect(await buildMdIndex('内容', 'key')).toBeNull();
    expect(await searchMdIndex(2, { query: 'x', caseSensitive: false, regexp: false, wholeWord: false })).toBeNull();
  });

  it('释放索引吞掉失败', async () => {
    invokeMock.mockRejectedValue(new Error('已淘汰'));
    await expect(releaseMdIndex(3)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('md_index_release', { indexId: 3 });
  });

  it('批量渲染 HTML：成功/长度不符/失败/非 Tauri', async () => {
    invokeMock.mockResolvedValue(['<h1>甲</h1>', '<p>乙</p>']);
    await expect(renderMarkdownHtmlChunks(['# 甲', '乙'])).resolves.toEqual(['<h1>甲</h1>', '<p>乙</p>']);
    expect(invokeMock).toHaveBeenCalledWith('md_render_html_chunks', { chunks: ['# 甲', '乙'] });

    invokeMock.mockResolvedValue(['<h1>甲</h1>']);
    expect(await renderMarkdownHtmlChunks(['# 甲', '乙'])).toBeNull();

    invokeMock.mockRejectedValue(new Error('渲染失败'));
    expect(await renderMarkdownHtmlChunks(['# 甲'])).toBeNull();

    platform.tauri = false;
    invokeMock.mockClear();
    expect(await renderMarkdownHtmlChunks(['# 甲'])).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
