import { describe, expect, it } from 'vitest';
import { decodeAs, detectEncoding, encodingLabel } from './encoding';

const enc = (text: string): Uint8Array =>
  new Uint8Array(new TextEncoder().encode(text));

/** Node（full-icu）与浏览器均可用 label 编码的便捷函数：先解码再借 TextEncoder 无法产非 UTF-8，
    这里用 charCode 手工构造 GBK 字节 */
function gbkBytes(codePoints: Array<[number, number]>): Uint8Array {
  const out: number[] = [];
  for (const [b1, b2] of codePoints) out.push(b1, b2);
  return new Uint8Array(out);
}

describe('detectEncoding', () => {
  it('空字节 → utf-8', () => {
    expect(detectEncoding(new Uint8Array())).toMatchObject({ encoding: 'utf-8', bom: false });
  });

  it('UTF-8 无 BOM', () => {
    const bytes = enc('你好, world');
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'utf-8', bom: false, lossy: false });
  });

  it('UTF-8 带 BOM：剥离 BOM 并标记', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('hello')]);
    const r = detectEncoding(bytes);
    expect(r.encoding).toBe('utf-8');
    expect(r.bom).toBe(true);
    expect(r.text).toBe('hello');
  });

  it('UTF-16 LE 带 BOM', () => {
    const manual = new Uint8Array([0xff, 0xfe, 0x68, 0x00]);
    expect(detectEncoding(manual)).toMatchObject({ encoding: 'utf-16le', bom: true, text: 'h' });
  });

  it('UTF-16 BE 带 BOM', () => {
    const manual = new Uint8Array([0xfe, 0xff, 0x00, 0x68]);
    expect(detectEncoding(manual)).toMatchObject({ encoding: 'utf-16be', bom: true, text: 'h' });
  });

  it('GBK 中文字节（「你好」= C4E3 BAC3）', () => {
    const bytes = gbkBytes([[0xc4, 0xe3], [0xba, 0xc3]]);
    const r = detectEncoding(bytes);
    expect(r.encoding).toBe('gbk');
    expect(r.text).toBe('你好');
  });

  it('前 8KB 含 NUL → 判二进制（lossy）', () => {
    const bytes = new Uint8Array(16);
    bytes[5] = 0x41;
    const r = detectEncoding(bytes);
    expect(r.binary).toBe(true);
    expect(r.lossy).toBe(true);
  });

  it('无效字节回退 GBK 且 lossy', () => {
    // 0x81 0xff 在 GBK 中为非法序列（多数引擎产出 U+FFFD）
    const bytes = new Uint8Array([0x81, 0xff, 0x81, 0xfe]);
    const r = detectEncoding(bytes);
    expect(r.encoding).toBe('gbk');
    expect(r.lossy).toBe(true);
  });
});

describe('decodeAs', () => {
  it('utf-8 显式解码剥离 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('ok')]);
    expect(decodeAs(bytes, 'utf-8')).toEqual({ text: 'ok', bom: true, lossy: false });
  });
});

describe('encodingLabel', () => {
  it('已知 id 返回展示名，未知返回原文', () => {
    expect(encodingLabel('utf-8')).toBe('UTF-8');
    expect(encodingLabel('windows-1252')).toBe('Windows-1252');
    expect(encodingLabel('unknown-x')).toBe('unknown-x');
  });
});
