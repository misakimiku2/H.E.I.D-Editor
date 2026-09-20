import { describe, expect, it } from 'vitest';
import {
  clampTreeSidebarWidth, findNode, isImagePath, isSvgPath, isUnderRoot, isValidEntryName, joinPath,
  loadTreeSidebarWidth, loadedDirPaths, makeRoot, parentPathOf, relativePathUnderRoot,
  saveTreeSidebarWidth, sortEntries, toggleDir, uniqueEntryName,
  withChildren, withError, withRefreshedChildren,
  TREE_SIDEBAR_MAX_WIDTH, TREE_SIDEBAR_MIN_WIDTH,
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

  it('makeRoot 兼容 SAF tree URI：解码 docId 并去掉存储卷前缀', () => {
    const root = makeRoot('content://com.android/tree/primary%3ADocuments');
    expect(root.name).toBe('Documents');
  });

  it('makeRoot SAF 子目录树根：解码为相对路径', () => {
    const root = makeRoot('content://com.android/tree/primary%3ADownload%2Fnotes');
    expect(root.name).toBe('Download/notes');
  });

  it('makeRoot 桌面路径保持原样', () => {
    expect(makeRoot('C:\\Users\\me\\notes').name).toBe('notes');
    expect(makeRoot('/home/me/notes').name).toBe('notes');
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

describe('loadedDirPaths', () => {
  it('收集已加载目录（含根），父先子后；未加载层与文件不入列', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('src', true), e('a.md', false)]);
    root = withChildren(root, '/r/src', [e('nested', true), e('b.txt', false)]);
    expect(loadedDirPaths(root)).toEqual(['/r', '/r/src']);
  });

  it('全部懒加载时只有根', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('src', true)]);
    expect(loadedDirPaths(root)).toEqual(['/r']);
  });
});

describe('withRefreshedChildren', () => {
  it('整体替换子节点：新条目按序懒加载出现，消失的条目移除', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('old.txt', false), e('gone', true)]);
    root = withRefreshedChildren(root, '/r', [e('new.txt', false), e('sub', true)]);
    expect(root.children!.map(c => c.name)).toEqual(['sub', 'new.txt']);
    expect(root.children![0].children).toBeNull();
    expect(root.children![0].expanded).toBe(false);
  });

  it('已加载且展开的同名子目录保留展开态，children 置回 null（由调用方同批合并新列表）', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = withChildren(root, '/r/sub', [e('deep.txt', false)]);
    root = toggleDir(root, '/r/sub');
    root = withRefreshedChildren(root, '/r', [e('sub', true), e('x.txt', false)]);
    expect(root.children![0].expanded).toBe(true);
    expect(root.children![0].children).toBeNull();
  });

  it('已加载但收起的子目录保持收起', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = withChildren(root, '/r/sub', [e('deep.txt', false)]);
    root = withRefreshedChildren(root, '/r', [e('sub', true)]);
    expect(root.children![0].expanded).toBe(false);
    expect(root.children![0].children).toBeNull();
  });

  it('展开中（children 为 null 且无错误）的子目录不保留展开态，避免孤儿加载圈', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = toggleDir(root, '/r/sub');
    root = withRefreshedChildren(root, '/r', [e('sub', true)]);
    expect(root.children![0].expanded).toBe(false);
  });

  it('带错误的子目录保留错误与展开态（展示错误行可重试）', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('sub', true)]);
    root = withError(root, '/r/sub', '权限不足');
    root = toggleDir(root, '/r/sub');
    root = withRefreshedChildren(root, '/r', [e('sub', true)]);
    expect(root.children![0].error).toBe('权限不足');
    expect(root.children![0].expanded).toBe(true);
  });

  it('刷新成功后目标节点自身 error 清空', () => {
    let root = makeRoot('/r');
    root = withError(root, '/r', '读取失败');
    root = withRefreshedChildren(root, '/r', [e('a.txt', false)]);
    expect(root.error).toBeNull();
    expect(root.children).toHaveLength(1);
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

describe('isValidEntryName', () => {
  it('接受普通文件与文件夹名', () => {
    for (const n of ['a.md', '笔记', 'src', '.gitignore', 'a b.c', 'v1.2.3']) {
      expect(isValidEntryName(n), n).toBe(true);
    }
  });
  it('拒绝空名、路径分隔符与 Windows 保留字符', () => {
    for (const n of ['', '  ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', '"q"', '<x>', 'a|b']) {
      expect(isValidEntryName(n), n).toBe(false);
    }
  });
  it('拒绝点目录与结尾的点和空格（Windows 语义）', () => {
    for (const n of ['.', '..', 'a.', 'a ', 'a. ']) {
      expect(isValidEntryName(n), n).toBe(false);
    }
  });
});

describe('uniqueEntryName', () => {
  it('无冲突时原样返回', () => {
    expect(uniqueEntryName('a.md', ['b.md'], '副本')).toBe('a.md');
  });
  it('冲突时扩展名前的主名加后缀，序号递增', () => {
    expect(uniqueEntryName('a.md', ['a.md'], '副本')).toBe('a - 副本.md');
    expect(uniqueEntryName('a.md', ['a.md', 'a - 副本.md'], '副本')).toBe('a - 副本 2.md');
    expect(uniqueEntryName('a.md', ['a.md', 'a - 副本.md', 'a - 副本 2.md'], '副本')).toBe('a - 副本 3.md');
  });
  it('无扩展名与隐藏文件按整名处理', () => {
    expect(uniqueEntryName('src', ['src'], 'copy')).toBe('src - copy');
    expect(uniqueEntryName('.gitignore', ['.gitignore'], 'copy')).toBe('.gitignore - copy');
  });
});

describe('relativePathUnderRoot', () => {
  it('剥离根前缀与首部分隔符', () => {
    expect(relativePathUnderRoot('C:\\root\\a\\b.md', 'C:\\root')).toBe('a\\b.md');
    expect(relativePathUnderRoot('/root/a/b.md', '/root')).toBe('a/b.md');
  });
  it('不在根下或就是根时原样返回', () => {
    expect(relativePathUnderRoot('D:\\other\\a.md', 'C:\\root')).toBe('D:\\other\\a.md');
    expect(relativePathUnderRoot('C:\\root', 'C:\\root')).toBe('C:\\root');
  });
});

describe('parentPathOf 与 joinPath', () => {
  it('剥除最后一段并保留分隔符风格', () => {
    expect(parentPathOf('C:\\root\\a\\b.md')).toBe('C:\\root\\a');
    expect(parentPathOf('/root/a')).toBe('/root');
  });
  it('joinPath 按目录已有分隔符拼接', () => {
    expect(joinPath('C:\\root', 'a.md')).toBe('C:\\root\\a.md');
    expect(joinPath('/root', 'a.md')).toBe('/root/a.md');
    expect(joinPath('C:\\root\\', 'a.md')).toBe('C:\\root\\a.md');
  });
});

describe('findNode', () => {
  it('按路径定位任意层级的节点', () => {
    let root = makeRoot('/r');
    root = withChildren(root, '/r', [e('src', true), e('a.md', false)]);
    root = withChildren(root, '/r/src', [{ name: 'main.rs', path: '/r/src/main.rs', isDir: false }]);
    expect(findNode(root, '/r/src/main.rs')?.name).toBe('main.rs');
    expect(findNode(root, '/r/a.md')?.name).toBe('a.md');
    expect(findNode(root, '/r/missing')).toBeNull();
  });
});

describe('isImagePath', () => {
  it('识别常见图片扩展名（大小写不敏感；svg 例外走源码标签页）', () => {
    for (const p of ['a.png', 'C:\\r\\b.JPG', '/r/c.jpeg', 'e.webp', 'f.gif', 'g.bmp', 'h.ico']) {
      expect(isImagePath(p), p).toBe(true);
    }
  });
  it('非图片扩展名与无扩展名返回 false', () => {
    for (const p of ['a.md', 'b', 'c.png.md', 'd.txt']) {
      expect(isImagePath(p), p).toBe(false);
    }
  });
  it('安卓 SAF URI 先解码再取扩展名', () => {
    expect(isImagePath('content://x/tree/primary%3ADCIM/pic%2Epng')).toBe(true);
  });
});

describe('isSvgPath', () => {
  it('识别 svg 扩展名（大小写不敏感），且不在 IMAGE_EXTS 中（走源码标签页）', () => {
    expect(isSvgPath('icon.SVG')).toBe(true);
    expect(isSvgPath('C:\\r\\logo.svg')).toBe(true);
    expect(isSvgPath('content://x/doc/pic%2Esvg')).toBe(true);
    expect(isSvgPath('a.png')).toBe(false);
    expect(isImagePath('a.svg')).toBe(false);
  });
});

describe('侧栏宽度持久化', () => {
  const fakeStorage = (map: Record<string, string> = {}): Storage => ({
    getItem: (k: string) => (k in map ? map[k] : null),
    setItem: (k: string, v: string) => { map[k] = v; },
    removeItem: (k: string) => { delete map[k]; },
    clear: () => { for (const k of Object.keys(map)) delete map[k]; },
    key: () => null,
    length: 0,
  } as Storage);

  it('无记录、空值与非法值回退默认（= 最小宽度 256）', () => {
    expect(loadTreeSidebarWidth(fakeStorage())).toBe(TREE_SIDEBAR_MIN_WIDTH);
    expect(loadTreeSidebarWidth(fakeStorage({ 'heid-tree-sidebar-width': '' }))).toBe(TREE_SIDEBAR_MIN_WIDTH);
    expect(loadTreeSidebarWidth(fakeStorage({ 'heid-tree-sidebar-width': 'abc' }))).toBe(TREE_SIDEBAR_MIN_WIDTH);
  });

  it('合法值原样返回', () => {
    expect(loadTreeSidebarWidth(fakeStorage({ 'heid-tree-sidebar-width': '320' }))).toBe(320);
  });

  it('越界与浮点收敛到 [256, 400] 整数', () => {
    expect(loadTreeSidebarWidth(fakeStorage({ 'heid-tree-sidebar-width': '999' }))).toBe(TREE_SIDEBAR_MAX_WIDTH);
    expect(loadTreeSidebarWidth(fakeStorage({ 'heid-tree-sidebar-width': '100' }))).toBe(TREE_SIDEBAR_MIN_WIDTH);
    expect(loadTreeSidebarWidth(fakeStorage({ 'heid-tree-sidebar-width': '300.6' }))).toBe(301);
  });

  it('clamp：边界值保持，区间外收敛', () => {
    expect(clampTreeSidebarWidth(TREE_SIDEBAR_MIN_WIDTH)).toBe(256);
    expect(clampTreeSidebarWidth(TREE_SIDEBAR_MAX_WIDTH)).toBe(400);
    expect(clampTreeSidebarWidth(0)).toBe(256);
    expect(clampTreeSidebarWidth(10000)).toBe(400);
  });

  it('保存写入收敛后的整数值', () => {
    const map: Record<string, string> = {};
    saveTreeSidebarWidth(400.4, fakeStorage(map));
    expect(map['heid-tree-sidebar-width']).toBe('400');
  });

  it('存储不可用（null）时读写均不抛错', () => {
    expect(loadTreeSidebarWidth(null)).toBe(TREE_SIDEBAR_MIN_WIDTH);
    expect(() => saveTreeSidebarWidth(360, null)).not.toThrow();
  });
});
