import { describe, it, expect } from 'vitest';
import { openedFromDecoded, openedFromBytes, formatFileSize } from './fileIO';

const META = { name: 'demo.txt', path: 'C:/tmp/demo.txt', handle: null };

describe('openedFromDecoded', () => {
  it('LF 文本：换行符检测为 lf，内容保持不变', () => {
    const f = openedFromDecoded({ text: 'a\nb\n', encoding: 'utf-8', bom: false }, META);
    expect(f.eol).toBe('lf');
    expect(f.content).toBe('a\nb\n');
    expect(f.encoding).toBe('utf-8');
    expect(f.bom).toBe(false);
    expect(f.name).toBe('demo.txt');
    expect(f.path).toBe('C:/tmp/demo.txt');
  });

  it('CRLF 文本：编辑器内容归一为 LF，原换行符记入 eol', () => {
    const f = openedFromDecoded({ text: 'a\r\nb\r\n', encoding: 'utf-8', bom: true }, META);
    expect(f.content).toBe('a\nb\n');
    expect(f.eol).toBe('crlf');
    expect(f.bom).toBe(true);
  });

  it('CR（旧 Mac）文本', () => {
    const f = openedFromDecoded({ text: 'a\rb\r', encoding: 'utf-8', bom: false }, META);
    expect(f.content).toBe('a\nb\n');
    expect(f.eol).toBe('cr');
  });

  it('二进制标志透传', () => {
    const f = openedFromDecoded({ text: 'x', encoding: 'utf-8', bom: false, binary: true }, META);
    expect(f.binary).toBe(true);
  });
});

describe('openedFromBytes', () => {
  it('UTF-8 字节自动检测', () => {
    const bytes = new TextEncoder().encode('hello 世界');
    const f = openedFromBytes(bytes, META);
    expect(f.content).toBe('hello 世界');
    expect(f.encoding).toBe('utf-8');
  });

  it('forceEncoding 按指定编码解码（GBK 字节）', () => {
    /* 「中文」的 GBK 编码 */
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const f = openedFromBytes(gbk, META, 'gbk');
    expect(f.content).toBe('中文');
    expect(f.encoding).toBe('gbk');
  });

  it('UTF-16LE BOM 自动检测', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
    const f = openedFromBytes(bytes, META);
    expect(f.content).toBe('ab');
    expect(f.bom).toBe(true);
  });
});

describe('formatFileSize', () => {
  it('字节 / KB / MB 分档', () => {
    expect(formatFileSize('a')).toBe('1 B');
    expect(formatFileSize('a'.repeat(2048))).toBe('2.0 KB');
    expect(formatFileSize('a'.repeat(1024 * 1024 * 3))).toBe('3.0 MB');
  });
});
