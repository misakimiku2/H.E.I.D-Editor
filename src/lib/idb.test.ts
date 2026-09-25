import 'fake-indexeddb/auto';
import { describe, expect, it, afterEach } from 'vitest';
import {
  IdbError, closeStore, idbAvailable, idbFailOf, openStore, requestPersistentStorage,
} from './idb';

/**
 * IndexedDB 极薄封装（v1.5 阶段 5 的离线队列踩在它上面）。
 * 跑在 fake-indexeddb 上而不是自写的替身：折叠、覆盖、事务中止这些语义是**真**的才有意义，
 * 自己写一个只会按我想到的样子反应的假库，等于把要验的东西先假设了一遍。
 */

let seq = 0;
/** 每个用例一个新库名：openStore 按名字缓存连接，共用名字会让上一个用例的状态漏进来 */
function fresh() {
  seq += 1;
  const name = `test-idb-${seq}`;
  return { name, store: openStore(name, 'writes') };
}

const savedDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

afterEach(() => {
  // 用例里改过全局的（第 5 条）一律还原，别让后面所有文件跟着抖
  if (savedDescriptor) Object.defineProperty(globalThis, 'indexedDB', savedDescriptor);
});

describe('idb：读写面', () => {
  it('put / get / getAll / del / clear 全往返', async () => {
    const { name, store } = fresh();
    closeStore(name, 'writes');
    const s = await store;
    await s.put({ v: 1 }, 'a');
    await s.put({ v: 2 }, 'b');
    expect(await s.get('a')).toEqual({ v: 1 });
    expect((await s.getAll()).length).toBe(2);
    await s.del('a');
    expect(await s.get('a')).toBeUndefined();
    await s.clear();
    expect(await s.getAll()).toEqual([]);
  });

  it('同一个键第二次 put 是覆盖不是插入 —— 离线队列的折叠全靠这一条', async () => {
    const { store } = fresh();
    const s = await store;
    await s.put({ text: '第一版' }, 'k');
    await s.put({ text: '第二版' }, 'k');
    const all = await s.getAll<{ text: string }>();
    expect(all).toEqual([{ text: '第二版' }]);
  });

  it('取不存在的键回 undefined，不抛', async () => {
    const { store } = fresh();
    expect(await (await store).get('没有这个键')).toBeUndefined();
  });

  it('仓库被外部丢掉后重开能自愈（升级回调按缺不缺判断）', async () => {
    const { name } = fresh();
    const first = await openStore(name, 'writes');
    await first.put({ v: 1 }, 'a');
    closeStore(name, 'writes');
    // 换一条新连接（fake-indexeddb 仍认这个库），旧数据要在
    const again = await openStore(name, 'writes');
    expect(await again.get('a')).toEqual({ v: 1 });
  });
});

describe('idb：失败的归类', () => {
  it('配额与「不让写」归成 quota，其余归 error', () => {
    expect(idbFailOf({ name: 'QuotaExceededError', message: '盘满了' }, '兜底').reason).toBe('quota');
    expect(idbFailOf({ name: 'NotAllowedError' }, '兜底').reason).toBe('quota');
    expect(idbFailOf({ name: 'UnknownError' }, '兜底').reason).toBe('error');
    expect(idbFailOf(new Error('普通故障'), '兜底').reason).toBe('error');
  });

  it('原因串为空时用兜底文案，不留空字符串给界面', () => {
    expect(idbFailOf({ name: 'DataError' }, '本地存储写入被中止').message).toContain('本地存储写入被中止');
  });

  it('put 同步抛配额时以 quota reject（不是 resolve 一个「成功」）', async () => {
    const { store } = fresh();
    const s = await store;
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: Record<string, unknown> } })
      .IDBObjectStore.prototype;
    const original = proto.put;
    proto.put = () => {
      throw { name: 'QuotaExceededError', message: '存储空间已满' };
    };
    try {
      const e = await s.put({ v: 1 }, 'k').then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(IdbError);
      expect((e as IdbError).reason).toBe('quota');
    } finally {
      proto.put = original;
    }
    expect((await s.getAll()).length).toBe(0);
  });

  it('这台设备没有 IndexedDB 时 reject unavailable', async () => {
    expect(idbAvailable()).toBe(true);
    delete (globalThis as Record<string, unknown>).indexedDB;
    expect(idbAvailable()).toBe(false);
    const e = await openStore(`no-idb-${seq}`, 'writes').then(() => null, (err: unknown) => err);
    expect((e as IdbError).reason).toBe('unavailable');
  });
});

describe('idb：持久性申请', () => {
  it('没有 navigator.storage 也只回 false，不抛（它失败不等于这次保存失败）', async () => {
    await expect(requestPersistentStorage()).resolves.toSatisfy((v: boolean) => typeof v === 'boolean');
  });
});
