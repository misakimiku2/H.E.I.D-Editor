/**
 * IndexedDB 的极薄一层（v1.5 阶段 5 的离线写队列是它的第一个用户）。
 *
 * 为什么不用 localStorage：它有 5 MB 量级的悬崖（整库一个字符串，写一次要重序列化全表），
 * 而这里承载的是「用户以为已经存好了」这份信任 —— 存到一半被配额打断必须**说出来**，
 * 所以 `drafts.ts:71` 那种「超限即 return false」的静默跳过在这一层不允许出现：
 * 每个失败都以 [`IdbFail`] 的形状 reject，由调用方决定说什么。
 *
 * 一个库一个对象仓库、版本恒为 1、键由调用方给（外置键）：这里不认识「离线条目」这件事，
 * 也不做索引与游标 —— 队列的量级是「几十条」，全表读一次比维护索引便宜。
 * 以后要有第二个用户就再开一个库名，别在这层加业务判据。
 */

/** 失败的归类。`quota` 与 `unavailable` 决定文案，`error` 是其余的真故障（原样带上原因） */
export type IdbFail = 'unavailable' | 'quota' | 'error';

export class IdbError extends Error {
  constructor(public reason: IdbFail, public detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'IdbError';
  }
}

/** 一个对象仓库的读写面 */
export interface IdbStore {
  get<T>(key: IDBValidKey): Promise<T | undefined>;
  getAll<T>(): Promise<T[]>;
  put(value: unknown, key: IDBValidKey): Promise<void>;
  del(key: IDBValidKey): Promise<void>;
  clear(): Promise<void>;
}

/** 配额类 DOMException 的名字在各内核里不统一，按名字集合判而不是 instanceof */
function isQuotaName(name: string): boolean {
  return name === 'QuotaExceededError' || name === 'NotAllowedError';
}

/**
 * 把 IndexedDB 抛出来的东西归成三种原因。
 * 单独导出是因为**这份归类就是离线队列文案的分支依据**（配额要说「请复制到别处」，
 * 没有存储要说「这台设备存不了」），它得能被直接钉住，而不是藏在一次事务里靠猜。
 */
export function idbFailOf(e: unknown, fallback: string): IdbError {
  const name = (e as { name?: string } | null)?.name ?? '';
  // 只认 message：一个没有 message 的 DOMException 变成 "[object Object]" 进界面更难看
  const msg = (e as { message?: string } | null)?.message ?? '';
  return new IdbError(isQuotaName(name) ? 'quota' : 'error', msg || fallback);
}

/**
 * 请求把存储标成「持久」，降低系统空间紧张时被整体清掉的概率。
 * 只是尽力而为：不支持、被拒都返回 false，绝不当成错误（它失败不等于这次保存失败）。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const st = (globalThis.navigator as Navigator | undefined)?.storage;
    return (await st?.persist?.()) === true;
  } catch {
    return false;
  }
}

/** 有没有 IndexedDB 可用（浏览器隐私模式与旧 WebView 上就是没有） */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

type DbGetter = () => Promise<IDBDatabase>;

/** 按「库名 + 仓库名」缓存连接：队列在启动时读一次、之后每笔保存碰一下，犯不着次次开 */
const cache = new Map<string, Promise<IdbStore>>();

function openDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new IdbError('unavailable', '这台设备没有可用的本地存储'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName, 1);
    } catch (e) {
      reject(idbFailOf(e, '打不开本地存储'));
      return;
    }
    // 版本 1 的首次创建，以及仓库被外部工具删掉后的自愈，都走这一条
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    req.onsuccess = () => {
      const db = req.result;
      // 别的窗口要升版本时让路，不然它永远等不到（本层不持锁，关了自己会重开）
      db.onversionchange = () => void db.close();
      resolve(db);
    };
    req.onerror = () => reject(idbFailOf(req.error, '打不开本地存储'));
    req.onblocked = () => reject(new IdbError('error', '本地存储被其他窗口占着'));
  });
}

/** 在一个读写事务里跑一件事：请求发出去不等于落盘了，必须等 `oncomplete` */
function withStore<T>(
  db: Promise<IDBDatabase>,
  storeName: string,
  mode: IDBTransactionMode,
  // 各请求的结果类型互不相同（put 给键、delete 给 undefined），而 TS 的 IDBRequest<T> 是**因变**的
  // （事件处理器带 this 类型），写不出一个能同时接住它们的共同类型；这一层只关心「有没有成」，
  // 结果按调用方要的 T 取。
  run: (store: IDBObjectStore) => IDBRequest<any>,
): Promise<T> {
  return db.then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        let req: IDBRequest<any>;
        try {
          tx = database.transaction(storeName, mode);
          // 建事务与发请求一起兜：某些内核在配额已满时是**同步**抛，不是中止事务
          req = run(tx.objectStore(storeName));
        } catch (e) {
          // 仓库被删 / 连接已关 / 同步抛配额：下一次开库会重建，这次如实报错
          reject(idbFailOf(e, '本地存储不可用'));
          return;
        }
        let settled = false;
        tx.oncomplete = () => {
          settled = true;
          resolve(undefined as T);
        };
        tx.onabort = () => {
          settled = true;
          reject(idbFailOf(tx.error, '本地存储写入被中止'));
        };
        tx.onerror = () => {
          settled = true;
          reject(idbFailOf(tx.error, '本地存储写入失败'));
        };
        // 值本身要等请求回调（getAll 的结果只在 request.onsuccess 上有意义）
        req.onsuccess = () => {
          if (settled) return;
          settled = true;
          resolve(req.result as T);
        };
        req.onerror = () => {
          if (settled) return;
          settled = true;
          reject(idbFailOf(req.error, '本地存储操作失败'));
        };
      }),
  );
}

/** 打开（或复用）一个仓库的读写面。连不上就以 [`IdbError`] reject，且**不缓存这条坏连接**
    —— 否则「这次没有 IDB」会被永久记住，之后 IDB 回来了也再也读不到。 */
export function openStore(dbName: string, storeName: string): Promise<IdbStore> {
  const key = `${dbName}/${storeName}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = (async (): Promise<IdbStore> => {
    const db = openDb(dbName, storeName);
    const view: IdbStore = {
      get: <T>(k: IDBValidKey) => withStore<T | undefined>(db, storeName, 'readonly', s => s.get(k)),
      getAll: <T>() => withStore<T[]>(db, storeName, 'readonly', s => s.getAll()),
      put: (value: unknown, k: IDBValidKey) => withStore<void>(db, storeName, 'readwrite', s => s.put(value, k)),
      del: (k: IDBValidKey) => withStore<void>(db, storeName, 'readwrite', s => s.delete(k)),
      clear: () => withStore<void>(db, storeName, 'readwrite', s => s.clear()),
    };
    await db;
    return view;
  })();
  made.catch(() => cache.delete(key));
  cache.set(key, made);
  return made;
}

/** 测试与「清库重来」用：丢掉缓存的连接，下次开是新的一轮 */
export function closeStore(dbName: string, storeName: string): void {
  cache.delete(`${dbName}/${storeName}`);
}
