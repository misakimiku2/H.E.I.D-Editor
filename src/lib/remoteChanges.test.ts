/**
 * 桌面推来的文件变更帧的解析与判据（v1.5 阶段 4）。
 *
 * 这一层单独测，是因为它决定了手机端**会不会漏刷新**：
 * 载荷解析不成必须退到「整棵重取」而不是「什么都没变」——
 * 后者的错法是静默的（用户看不见，只在下次打开时才发现内容早就变了）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ALL,
  dirTouched,
  fileTouched,
  parseFsDirs,
  parentRel,
  subscribeFileChanges,
  EVENT_FS,
  EVENT_ROOT,
  EVENT_TABS,
} from './remoteChanges';

vi.mock('./link', () => ({
  subscribeRemoteEvents: vi.fn(),
}));
import { subscribeRemoteEvents } from './link';

describe('parseFsDirs', () => {
  it('正常帧给出目录集合，并保留代表共享根的空串', () => {
    expect(parseFsDirs('{"dirs":["","src/components"]}')).toEqual(['', 'src/components']);
  });

  it('退化帧（桌面那一帧装不下，data 是空的）当作整棵树都变了', () => {
    expect(parseFsDirs('')).toBe(ALL);
  });

  it('坏 JSON 与非数组的 dirs 一律退到"全部重取"，不退到"没变"', () => {
    expect(parseFsDirs('{')).toBe(ALL);
    expect(parseFsDirs('{"dirs":"src"}')).toBe(ALL);
    expect(parseFsDirs('{"changed":["src"]}')).toBe(ALL);
    expect(parseFsDirs('{"dirs":[]}')).toBe(ALL);
  });

  it('条目里混进非字符串时只看字符串那些，而不是整帧作废', () => {
    expect(parseFsDirs('{"dirs":["src",null,7]}')).toEqual(['src']);
  });
});

describe('parentRel / 判据', () => {
  it('根下的文件其父目录是空串，与帧里给根用的那一个同一个值', () => {
    expect(parentRel('readme.md')).toBe('');
    expect(parentRel('src/App.tsx')).toBe('src');
    expect(parentRel('a/b/c/d.ts')).toBe('a/b/c');
  });

  it('文件只看自己那一层：兄弟目录变了不值得为它发一次 stat', () => {
    expect(fileTouched('src/App.tsx', ['src'])).toBe(true);
    expect(fileTouched('src/App.tsx', ['docs'])).toBe(false);
    expect(fileTouched('src/App.tsx', ALL)).toBe(true);
    expect(fileTouched('readme.md', [''])).toBe(true);
  });

  it('目录也是同一套求交而不是前缀匹配 —— 帧里的 src 说的就是 src 这一层的内容', () => {
    expect(dirTouched('src', ['src'])).toBe(true);
    expect(dirTouched('src/components', ['src'])).toBe(false);
    expect(dirTouched('src/components', ['src/components'])).toBe(true);
    expect(dirTouched('src', ALL)).toBe(true);
  });

  it('名字里带分隔符相似形状时不误判（同前缀的兄弟目录）', () => {
    expect(dirTouched('src', ['src-evil'])).toBe(false);
    expect(fileTouched('src/x.ts', ['src-evil'])).toBe(false);
  });
});

describe('subscribeFileChanges', () => {
  it('按类型分流，并把载荷原样交给解析', () => {
    const onDirs = vi.fn();
    const onRootChanged = vi.fn();
    subscribeFileChanges({ onDirs, onRootChanged });

    const cb = vi.mocked(subscribeRemoteEvents).mock.calls.at(-1)![0];
    cb(EVENT_FS, '{"dirs":["src"]}');
    expect(onDirs).toHaveBeenCalledWith(['src']);
    cb(EVENT_ROOT, '');
    expect(onRootChanged).toHaveBeenCalledTimes(1);
  });

  it('其余类型不打扰这里 —— tabs 那一路自己订它的', () => {
    const onDirs = vi.fn();
    const onRootChanged = vi.fn();
    subscribeFileChanges({ onDirs, onRootChanged });
    const cb = vi.mocked(subscribeRemoteEvents).mock.calls.at(-1)![0];
    cb(EVENT_TABS, '');
    expect(onDirs).not.toHaveBeenCalled();
    expect(onRootChanged).not.toHaveBeenCalled();
  });

  it('缺 data 参数时按退化帧处理，而不是当作空目录列表', () => {
    const onDirs = vi.fn();
    subscribeFileChanges({ onDirs });
    const cb = vi.mocked(subscribeRemoteEvents).mock.calls.at(-1)![0];
    cb(EVENT_FS, undefined as unknown as string);
    expect(onDirs).toHaveBeenCalledWith(ALL);
  });
});
