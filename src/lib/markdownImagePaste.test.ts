// @vitest-environment jsdom
/**
 * 粘贴图片纯函数：扩展名推断 / 命名 / assets 目录 / 剪贴板取图。
 * 落盘链路（Tauri invoke + plugin-fs）不做单测，桌面手工验收。
 */
import { describe, expect, it } from 'vitest';
import { assetsDirOf, extFromMime, imageFileFromClipboard, pasteImageStem } from './markdownImagePaste';
import { joinRelativeSrc, normalizeLocalSrc } from './imageSrc';

describe('extFromMime', () => {
  it('常见图片 MIME 映射', () => {
    expect(extFromMime('image/png')).toBe('png');
    expect(extFromMime('image/jpeg')).toBe('jpg');
    expect(extFromMime('image/svg+xml')).toBe('svg');
    expect(extFromMime('image/webp')).toBe('webp');
  });

  it('未知类型回退 png', () => {
    expect(extFromMime('image/x-fancy')).toBe('png');
    expect(extFromMime('')).toBe('png');
  });
});

describe('pasteImageStem', () => {
  it('本地时间命名 paste-YYYYMMDD-HHmmss', () => {
    expect(pasteImageStem(new Date(2026, 8, 16, 5, 3, 7))).toBe('paste-20260916-050307');
  });
});

describe('assetsDirOf', () => {
  it('文档目录 → assets 子目录（分隔符跟随 docDir，容忍尾分隔符）', () => {
    expect(assetsDirOf('C:\\docs\\note')).toBe('C:\\docs\\note\\assets');
    expect(assetsDirOf('/home/u/docs/')).toBe('/home/u/docs/assets');
  });
});

describe('imageFileFromClipboard', () => {
  const makeItems = (entries: { kind: string; type: string; file: File | null }[]): DataTransferItemList =>
    entries.map(e => ({ ...e, getAsFile: () => e.file })) as unknown as DataTransferItemList;

  it('取首个图片文件，跳过文本与目录', () => {
    const f = new File(['x'], 's.png', { type: 'image/png' });
    const items = makeItems([
      { kind: 'string', type: 'text/plain', file: null },
      { kind: 'file', type: 'image/png', file: f },
    ]);
    expect(imageFileFromClipboard(items)).toBe(f);
  });

  it('无图片返回 null', () => {
    expect(imageFileFromClipboard(makeItems([{ kind: 'file', type: 'text/plain', file: new File(['a'], 'a.txt') }]))).toBeNull();
    expect(imageFileFromClipboard(null)).toBeNull();
  });
});

describe('joinRelativeSrc（相对图片读取基准）', () => {
  it('相对路径与文档目录拼接，分隔符跟随 baseDir（Windows 拼反斜杠，fs 插件才认）', () => {
    expect(joinRelativeSrc('assets/a.png', 'C:\\docs')).toBe('C:\\docs\\assets\\a.png');
    expect(joinRelativeSrc('assets/a.png', '/home/u/docs/')).toBe('/home/u/docs/assets/a.png');
  });

  it('./ 前缀剥除与 file:/// 解码', () => {
    expect(joinRelativeSrc('./assets/a.png', 'C:\\docs\\md')).toBe('C:\\docs\\md\\assets\\a.png');
    expect(joinRelativeSrc('file:///C:/docs/a%20b.png', 'C:\\docs')).toBe('C:\\docs\\a b.png');
  });

  it('协议与绝对路径不参与拼接', () => {
    expect(joinRelativeSrc('https://x/a.png', 'C:\\docs')).toBe('https://x/a.png');
    expect(joinRelativeSrc('data:image/png;base64,xx', 'C:\\docs')).toBe('data:image/png;base64,xx');
    expect(joinRelativeSrc('C:\\abs\\a.png', 'C:\\docs')).toBe('C:\\abs\\a.png');
    expect(joinRelativeSrc('/unix/abs.png', '/home/u')).toBe('/unix/abs.png');
  });

  it('无 baseDir 原样返回（未保存文档：后续按读取失败报错）', () => {
    expect(joinRelativeSrc('assets/a.png')).toBe('assets/a.png');
  });
});

describe('normalizeLocalSrc（图片 src 归一）', () => {
  it('file:/// 与百分号编码解码为本地路径（盘符统一反斜杠）', () => {
    expect(normalizeLocalSrc('file:///C:/docs/a%20b.png')).toBe('C:\\docs\\a b.png');
    expect(normalizeLocalSrc('/home/u/a%20b.png')).toBe('/home/u/a b.png');
    expect(normalizeLocalSrc('C:\\raw\\path.png')).toBe('C:\\raw\\path.png');
  });

  it('协议地址原样、空串返回空', () => {
    expect(normalizeLocalSrc('https://x/a.png')).toBe('https://x/a.png');
    expect(normalizeLocalSrc('data:image/png;base64,xx')).toBe('data:image/png;base64,xx');
    expect(normalizeLocalSrc('')).toBe('');
    expect(normalizeLocalSrc('assets/%E5%9B%BE.png')).toBe('assets/图.png');
  });
});
