import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openStore } from './idb';
import {
  MAX_OFFLINE_CHARS, MAX_OFFLINE_ENTRIES, clearQueue, collapse, enqueue,
  entryIdOf, forDevice, freshEntry, loadQueue, putEntry, removeEntry, sortForReplay,
  type OfflineInput, type OfflineStore,
} from './offlineQueue';

/**
 * 离线写队列（v1.5 阶段 5）。条目 44 明写了这一块的测试密度要高于其余：
 * 进程被杀、存储写满、回放途中再断连、同文件并发、基线折叠 —— 这里覆盖后四条
 * （「回放途中再断连」是运行时的，在 useOfflineSync.test.tsx）。
 *
 * 存储用 fake-indexeddb 而不是替身：折叠是不是真落成「一条」，只有过一遍真键值存储才算。
 */

let seq = 0;
function store() {
  seq += 1;
  return openStore(`test-offline-${seq}`, 'writes');
}

function input(over: Partial<OfflineInput> = {}): OfflineInput {
  return {
    deviceId: 'aabbccddee112233',
    relPath: 'notes/todo.md',
    path: 'hide-remote://aabbccddee112233/notes/todo.md',
    title: 'todo.md',
    text: '手机上改的第一版\r\n',
    encoding: 'utf-8',
    bom: false,
    baseHash: 'hash-original',
    ...over,
  };
}

describe('离线队列：折叠（条目 44 的第一硬约束）', () => {
  it('同一文件第二次入队并成一条：内容最新，基线与排队时刻都是最初那份', async () => {
    const s = store();
    const first = await enqueue(input({ text: '第一版' }), s, 1000);
    const second = await enqueue(input({ text: '第二版，又改了几行' }), s, 5000);
    expect(first.ok && second.ok).toBe(true);
    expect((second as { collapsed: boolean }).collapsed).toBe(true);

    const list = await loadQueue(s);
    expect(list.length).toBe(1);
    expect(list[0].text).toBe('第二版，又改了几行');
    // 这两条错了就会在回放时产出假冲突：中间态当基线 = 桌面没动也判成「桌面改过」
    expect(list[0].baseHash).toBe('hash-original');
    expect(list[0].queuedAt).toBe(1000);
    expect(list[0].updatedAt).toBe(5000);
  });

  it('折叠后送去回放的基线仍是最初那一份（回放直接 write，基线就是唯一的判据）', async () => {
    const s = store();
    await enqueue(input({ text: '第一版' }), s, 1000);
    await enqueue(input({ text: '第二版' }), s, 5000);
    const [entry] = await loadQueue(s);
    expect(entry.baseHash).toBe('hash-original');
    expect(entry.relPath).toBe('notes/todo.md');
  });

  it('改过一版之后又冲突，状态回到 queued 等重判（不能永远卡在「需要确认」）', async () => {
    const s = store();
    await enqueue(input(), s, 1000);
    const [e] = await loadQueue(s);
    await putEntry({ ...e, state: 'conflict', attempts: 2, lastError: '桌面也改过' }, s);
    await enqueue(input({ text: '看到冲突之后又改了一版' }), s, 9000);
    const [again] = await loadQueue(s);
    expect(again.state).toBe('queued');
    expect(again.attempts).toBe(2);
    expect(again.baseHash).toBe('hash-original');
  });

  it('折叠是覆盖不是插入，靠的就是「键 = 哪台设备的哪个文件」', () => {
    expect(entryIdOf('dev1', 'a/b.md')).toBe(entryIdOf('dev1', 'a/b.md'));
    expect(entryIdOf('dev1', 'a.md')).not.toBe(entryIdOf('dev2', 'a.md'));
  });

  it('collapse 纯函数：只换内容侧字段，判据与历史一律保留', () => {
    const prev = freshEntry(input({ text: '旧' }), 1000);
    const next = collapse(prev, input({ text: '新', encoding: 'gbk', bom: true }), 2000);
    expect(next.text).toBe('新');
    expect(next.encoding).toBe('gbk');
    expect(next.bom).toBe(true);
    expect(next.updatedAt).toBe(2000);
    expect(next.queuedAt).toBe(1000);
    expect(next.baseHash).toBe('hash-original');
    expect(next.id).toBe(prev.id);
  });
});

describe('离线队列：跨设备与不同文件', () => {
  it('同一路径在两台电脑上各算一份，回放只放当前这台', async () => {
    const s = store();
    await enqueue(input({ deviceId: 'dev1' }), s, 1000);
    await enqueue(input({ deviceId: 'dev2' }), s, 2000);
    expect((await loadQueue(s)).length).toBe(2);
    expect(forDevice(await loadQueue(s), 'dev2').length).toBe(1);
  });

  it('不同文件不互相折叠', async () => {
    const s = store();
    await enqueue(input({ relPath: 'a.md' }), s, 1000);
    await enqueue(input({ relPath: 'b.md' }), s, 2000);
    expect((await loadQueue(s)).length).toBe(2);
  });
});

describe('离线队列：写不进去必须说出来', () => {
  it('没有基线的入队直接拒（拿空基线落盘等于覆盖桌面的改动）', async () => {
    const r = await enqueue(input({ baseHash: '' }), store());
    expect(r).toEqual({ ok: false, reason: 'nobaseline' });
  });

  it('内容超单条上限时拒，并把尺寸与上限一起带出去（文案要说「请复制到别处」）', async () => {
    const r = await enqueue(input({ text: 'x'.repeat(MAX_OFFLINE_CHARS + 1) }), store());
    expect(r).toMatchObject({ ok: false, reason: 'toobig', limit: MAX_OFFLINE_CHARS });
  });

  it('文件数满时拒新的，但已有文件再存一次照样进（不能被子系统自己的上限挡住）', async () => {
    const s = store();
    for (let i = 0; i < MAX_OFFLINE_ENTRIES; i++) {
      const r = await enqueue(input({ relPath: `f${i}.md` }), s, i);
      expect(r.ok).toBe(true);
    }
    const overflow = await enqueue(input({ relPath: '再多一个.md' }), s, 9999);
    expect(overflow).toMatchObject({ ok: false, reason: 'full', limit: MAX_OFFLINE_ENTRIES });
    const again = await enqueue(input({ relPath: 'f3.md', text: '已有的改一版' }), s, 9999);
    expect(again.ok).toBe(true);
    expect((await loadQueue(s)).length).toBe(MAX_OFFLINE_ENTRIES);
  });

  it('存储写坏时以 storage + 原因返回，不静默当成功', async () => {
    const bad: OfflineStore = {
      getAll: async () => [],
      put: async () => {
        throw Object.assign(new Error('存储空间已满'), { name: 'QuotaExceededError' });
      },
      del: async () => {},
      clear: async () => {},
    };
    const r = await enqueue(input(), Promise.resolve(bad));
    expect(r).toMatchObject({ ok: false, reason: 'storage', detail: '存储空间已满' });
  });

  it('这台设备压根没有本地存储时也要给出原因', async () => {
    const none: OfflineStore = {
      getAll: async () => { throw Object.assign(new Error('没这个库'), { name: 'Error' }); },
      put: async () => { throw Object.assign(new Error('没这个库'), { name: 'Error' }); },
      del: async () => {},
      clear: async () => {},
    };
    const r = await enqueue(input(), Promise.resolve(none));
    expect(r.ok).toBe(false);
  });
});

describe('离线队列：回放顺序', () => {
  it('先排队的先写；同一条改过三次仍然只占一个位置', async () => {
    const s = store();
    await enqueue(input({ relPath: 'late.md' }), s, 3000);
    await enqueue(input({ relPath: 'first.md' }), s, 1000);
    await enqueue(input({ relPath: 'mid.md' }), s, 2000);
    await enqueue(input({ relPath: 'first.md', text: '第二次' }), s, 4000);
    const list = await loadQueue(s);
    expect(sortForReplay(list).map(e => e.relPath)).toEqual(['first.md', 'mid.md', 'late.md']);
  });

  it('要人裁决的那条不自动重放（否则每次重连都拿同一份去撞同一个冲突）', () => {
    const a = freshEntry(input({ relPath: 'a.md' }), 1000);
    const b = { ...freshEntry(input({ relPath: 'b.md' }), 2000), state: 'conflict' as const };
    expect(sortForReplay([b, a]).map(e => e.id)).toEqual([a.id]);
  });

  it('回放顺序是稳定的：同一份输入排两次结果一致', () => {
    const same = [freshEntry(input({ relPath: 'x.md' }), 1000), freshEntry(input({ relPath: 'y.md' }), 1000)];
    expect(sortForReplay(same).map(e => e.relPath)).toEqual(sortForReplay([...same].reverse()).map(e => e.relPath));
  });
});

describe('离线队列：读得回来的形状', () => {
  it('销账与清空', async () => {
    const s = store();
    await enqueue(input({ relPath: 'a.md' }), s, 1000);
    await enqueue(input({ relPath: 'b.md' }), s, 2000);
    const [a] = await loadQueue(s);
    await removeEntry(a.id, s);
    expect((await loadQueue(s)).map(x => x.relPath)).toEqual(['b.md']);
    await clearQueue(s);
    expect(await loadQueue(s)).toEqual([]);
  });

  it('库里躺着不认识的条目时跳过它，而不是让整块界面白掉', async () => {
    const s = await store();
    await s.put({ nonsense: true }, 'junk');
    await s.put(freshEntry(input(), 1000), entryIdOf('aabbccddee112233', 'notes/todo.md'));
    const list = await loadQueue(Promise.resolve(s));
    expect(list.map(x => x.relPath)).toEqual(['notes/todo.md']);
  });

  it('没有存储可用时读回空表（启动路径不该被打断）', async () => {
    const broken = Promise.reject(Object.assign(new Error('打不开'), { name: 'Error' }));
    expect(await loadQueue(broken as Promise<OfflineStore>)).toEqual([]);
  });
});
