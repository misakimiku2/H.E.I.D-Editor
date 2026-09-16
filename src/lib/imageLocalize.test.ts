import { describe, expect, it, vi } from 'vitest';
import {
  collectRemoteImages, extOfDownload, hashUrl8, localizeRemoteImages, replaceImageUrl,
  LOCALIZE_MAX_IMAGES,
} from './imageLocalize';

describe('collectRemoteImages', () => {
  it('收集远程图片并计数，本地/行内不收', () => {
    const md = [
      '![a](https://x/1.png)',
      '[link](https://x/2.png)',
      '![b](https://x/1.png)',
      '![c](assets/local.png)',
      '![d](http://y/3.jpg "title")',
    ].join('\n');
    expect(collectRemoteImages(md)).toEqual([
      { url: 'https://x/1.png', count: 2 },
      { url: 'http://y/3.jpg', count: 1 },
    ]);
  });

  it('无远程图片返回空', () => {
    expect(collectRemoteImages('plain text ![x](data:...)')).toHaveLength(0);
  });
});

describe('hashUrl8', () => {
  it('8 位十六进制且稳定', () => {
    expect(hashUrl8('https://a/1.png')).toBe(hashUrl8('https://a/1.png'));
    expect(hashUrl8('https://a/1.png')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashUrl8('https://a/2.png')).not.toBe(hashUrl8('https://a/1.png'));
  });
});

describe('extOfDownload', () => {
  it('content-type 优先', () => {
    expect(extOfDownload('image/jpeg', 'https://x/noext')).toBe('jpg');
    expect(extOfDownload('image/svg+xml', 'https://x/a.png')).toBe('svg');
  });

  it('回退 URL 扩展名与 png 兜底', () => {
    expect(extOfDownload('', 'https://x/dir/pic.webp?v=1')).toBe('webp');
    expect(extOfDownload('application/octet-stream', 'https://x/noext')).toBe('png');
  });
});

describe('replaceImageUrl', () => {
  it('只替换图片语法里的该 URL，保留标题段', () => {
    const md = '![a](https://x/1.png) [l](https://x/1.png) ![t](https://x/1.png "cap")';
    const out = replaceImageUrl(md, 'https://x/1.png', 'assets/remote-abcd1234.png');
    expect(out).toContain('![a](assets/remote-abcd1234.png)');
    expect(out).toContain('[l](https://x/1.png)');
    expect(out).toContain('![t](assets/remote-abcd1234.png "cap")');
  });

  it('URL 特殊字符安全转义', () => {
    const md = '![a](https://x/1.png?q=1.2)';
    expect(replaceImageUrl(md, 'https://x/1.png?q=1.2', 'assets/r.png')).toBe('![a](assets/r.png)');
  });
});

describe('localizeRemoteImages（io 桩）', () => {
  const okDownload = (url: string) => Promise.resolve({
    base64: btoa('fakebytes'),
    contentType: 'image/png',
  });
  const saveOk = vi.fn(() => Promise.resolve());

  it('成功路径：替换全文、ok 计数', async () => {
    const md = '![a](https://x/1.png)';
    const res = await localizeRemoteImages(md, { download: okDownload, save: saveOk });
    expect(res.md).toContain('assets/remote-');
    expect(res.ok).toEqual(['https://x/1.png']);
    expect(res.failed).toHaveLength(0);
  });

  it('单张失败跳过并计入 failed，其余继续', async () => {
    const md = '![a](https://x/1.png)\n![b](https://x/2.png)';
    const download = vi.fn((url: string) =>
      url.includes('1.png') ? Promise.reject(new Error('404')) : okDownload(url));
    const res = await localizeRemoteImages(md, { download, save: saveOk });
    expect(res.md).toContain('https://x/1.png');
    expect(res.md).toContain('assets/remote-');
    expect(res.failed).toEqual([{ url: 'https://x/1.png', reason: '404' }]);
    expect(res.ok).toEqual(['https://x/2.png']);
  });

  it('超过上限的图源计入 skipped 不下载', async () => {
    const urls = Array.from({ length: LOCALIZE_MAX_IMAGES + 5 }, (_, i) => `![i](https://x/${i}.png)`).join('\n');
    const download = vi.fn(okDownload);
    const res = await localizeRemoteImages(urls, { download, save: saveOk });
    expect(res.skipped).toBe(5);
    expect(download).toHaveBeenCalledTimes(LOCALIZE_MAX_IMAGES);
  });

  it('onProgress：开始报 0/total，每张后报 done/total 与失败明细', async () => {
    const md = '![a](https://x/1.png)\n![b](https://x/2.png)';
    const download = vi.fn((url: string) =>
      url.includes('1.png') ? Promise.reject(new Error('404')) : okDownload(url));
    const onProgress = vi.fn();
    await localizeRemoteImages(md, { download, save: saveOk }, onProgress);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 2, 'https://x/1.png', []);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1, 2, 'https://x/1.png', [{ url: 'https://x/1.png', reason: '404' }]);
    expect(onProgress).toHaveBeenNthCalledWith(3, 2, 2, 'https://x/2.png', [{ url: 'https://x/1.png', reason: '404' }]);
  });
});
