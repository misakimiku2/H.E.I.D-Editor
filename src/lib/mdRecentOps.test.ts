import { describe, expect, it } from 'vitest';
import {
  mdOpKey, parseMdOpKey, loadLastMdOp, recordMdOp,
} from './mdRecentOps';
import { MENU_SECTIONS, type MdOp } from '../components/MarkdownTools';

/** 基于 Map 的 Storage 桩（vitest node 环境无 localStorage） */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

const allOps = MENU_SECTIONS.flatMap(s => s.ops.map(o => o.op));

describe('mdOpKey / parseMdOpKey', () => {
  it('菜单里的每个命令都能无损往返', () => {
    for (const op of allOps) {
      expect(parseMdOpKey(mdOpKey(op))).toEqual(op);
    }
  });

  it('带参数的编码：heading 带级别、mark 带颜色，无色 mark 不加冒号', () => {
    expect(mdOpKey({ kind: 'heading', level: 3 })).toBe('heading:3');
    expect(mdOpKey({ kind: 'mark' })).toBe('mark');
    expect(mdOpKey({ kind: 'mark', color: 'blue' })).toBe('mark:blue');
    expect(mdOpKey({ kind: 'bold' })).toBe('bold');
  });

  it('非法键一律丢弃，不把脏数据放进编辑器', () => {
    expect(parseMdOpKey('bold:extra')).toBeNull();
    expect(parseMdOpKey('heading:0')).toBeNull();
    expect(parseMdOpKey('heading:7')).toBeNull();
    expect(parseMdOpKey('heading:x')).toBeNull();
    expect(parseMdOpKey('mark:pink')).toBeNull();
    expect(parseMdOpKey('notAKind')).toBeNull();
    expect(parseMdOpKey('')).toBeNull();
  });
});

describe('loadLastMdOp / recordMdOp', () => {
  it('记录后读回同一条；再记录别的则覆盖（只留最后一次）', () => {
    const st = memoryStorage();
    expect(loadLastMdOp(st)).toBeNull();
    recordMdOp({ kind: 'bold' }, st);
    expect(loadLastMdOp(st)).toEqual({ kind: 'bold' });
    recordMdOp({ kind: 'heading', level: 1 }, st);
    expect(loadLastMdOp(st)).toEqual({ kind: 'heading', level: 1 });
  });

  it('recordMdOp 原样返回该命令，调用方省一次读', () => {
    const st = memoryStorage();
    expect(recordMdOp({ kind: 'mark', color: 'blue' }, st)).toEqual({ kind: 'mark', color: 'blue' });
  });

  it('损坏 / 非字符串 / 非法命令的记录一律视为没有记录', () => {
    const st = memoryStorage();
    st.setItem('heid-recent-md-ops', '{ not json');
    expect(loadLastMdOp(st)).toBeNull();
    st.setItem('heid-recent-md-ops', '["bold"]');
    expect(loadLastMdOp(st)).toBeNull();
    st.setItem('heid-recent-md-ops', '"bogus"');
    expect(loadLastMdOp(st)).toBeNull();
    st.setItem('heid-recent-md-ops', '"heading:9"');
    expect(loadLastMdOp(st)).toBeNull();
  });

  it('storage 不可用（隐私模式）时静默降级，不抛错', () => {
    expect(recordMdOp({ kind: 'bold' }, null)).toEqual({ kind: 'bold' });
    expect(loadLastMdOp(null)).toBeNull();
  });
});
