import { describe, expect, it } from 'vitest';
import {
  isUnderRoot, makeRoot, sortEntries, toggleDir, withChildren, withError,
  type DirEntry, type TreeNode,
} from './fileTree';

const e = (name: string, isDir: boolean): DirEntry => ({ name, path: `/r/${name}`, isDir });

describe('sortEntries', () => {
  it('目录优先，同组按名称排序（大小写不敏感，相等保持原序）', () => {
    const sorted = sortEntries([e('b.txt', false), e('z', true), e('a', true), e('A.txt', false), e('a.txt', false)]);
    expect(sorted.map(x => x.name)).toEqual(['a', 'z', 'A.txt', 'a.txt', 'b.txt']);
  });

  it('大小写不敏感排序（同语言内）', () => {
    const sorted = sortEntries([e('Beta', false), e('alpha', false)]);
    expect(sorted.map(x => x.name)).toEqual(['alpha', 'Beta']);
  });
});

describe('树状态（懒加载）', () => {
  it('makeRoot：根节点名取路径尾段，children 未加载', () => {
    const root = makeRoot('/home/user/Documents');
    expect(root.name).toBe('Documents');
    expect(root.isDir).toBe(true);
    expect(root.children).toBeNull();
    expect(root.expanded).toBe(true);
  });

  it('makeRoot 兼容 SAF tree URI', () => {
    const root = makeRoot('content://com.android/tree/primary%3ADocuments');
    expect(root.name).toBe('primary%3ADocuments');
  });

  it('withChildren：填充已排序子节点，目录 children 为 null', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true), e('a.txt', false)]);
    expect(root.children).toHaveLength(2);
    expect(root.children![0].name).toBe('sub');
    expect(root.children![0].children).toBeNull();
    expect(root.children![1].isDir).toBe(false);
    expect(root.error).toBeNull();
  });

  it('withChildren 支持嵌套更新（按 path 定位）', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = withChildren(root, '/r/sub', [e('deep.txt', false)]);
    expect(root.children![0].children![0].name).toBe('deep.txt');
  });

  it('toggleDir：展开/收起切换，收起保留已加载 children', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = withChildren(root, '/r/sub', [e('deep.txt', false)]);
    root = toggleDir(root, '/r/sub');
    expect(root.children![0].expanded).toBe(true);
    root = toggleDir(root, '/r/sub');
    expect(root.children![0].expanded).toBe(false);
    expect(root.children![0].children).not.toBeNull();
  });

  it('withError：在指定目录节点记录错误信息', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = withError(root, '/r/sub', '权限不足');
    expect(root.children![0].error).toBe('权限不足');
    expect(root.error).toBeNull();
  });
});

describe('路径归属', () => {
  it('isUnderRoot：前缀匹配且不混淆同级目录名', () => {
    expect(isUnderRoot('/home/user/docs/a.txt', '/home/user/docs')).toBe(true);
    expect(isUnderRoot('/home/user/docs2/a.txt', '/home/user/docs')).toBe(false);
    expect(isUnderRoot('/home/user/docs', '/home/user/docs')).toBe(true);
    expect(isUnderRoot('content://x/tree/primary%3AD/doc/uri', 'content://x/tree/primary%3AD')).toBe(true);
  });
});
