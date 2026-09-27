/**
 * 手机连上桌面之后的「交接」（2026-09-27 他点名的三条：扫完码直接看到电脑上正看着的那一份、
 * 其余桌面标签排进手机的标签条、桌面的文件夹树换掉手机那棵）。
 *
 * **每一次连上都交接**，不管是谁发起的：主动扫码、粘贴配对码、6 位短码、免扫重连、
 * 掉线后 `startLinkKeepAlive` 自己接回来、冷启动的免扫自动重连（2026-09-27 他补的第三条：
 * "冷启动自动接回也该摊开电脑上正看着的那一份，文件夹树也是一样"）。
 * 一条连接只跑一次（`ranFor`），断开之后清掉，下一次 connected 再跑。
 *
 * 区别只在**说不说话**：只有 `begin()` 立起的那一次（用户主动发起）才把失败、超时、
 * "一份都接不过来"讲给他听；后台自己接回来的那几次一律安静 —— 那不是你点的，
 * 弹一屏模态只会让人以为是自己做错了什么（2026-09-27 为这条改过一次）。
 *
 * 不盖掉他手上那份：手机上已经开着的同一路径**不重读磁盘**（`openPathIntoTab` 对已存在的
 * 标签会用磁盘内容盖掉它，脏的那一份就没了）。电脑上正看着那一份如果手机里已经开着，
 * 走 `reveal` 只把它切到前台。
 *
 * 交接的三条动作各判各的成败：
 * - 标签列表拿不到 → 用户那一次算失败，把桌面的原话交给调用方去说；
 * - 「桌面上有没有共享根」问不到 → 只是不动手机那棵树，不把已经打开的标签说成失败；
 * - 一份都接不过来（桌面没开标签，或开的都还脏着）→ 用户那一次回落到「电脑上正打开的文件」
 *   那一屏，那一屏本来就是为「这一份为什么接管不了」写的。
 *
 * 为什么等状态事件而不是直接用配对命令的返回值：`link_client_pair` 发起完就返回，
 * 握手在连接线程里继续跑（拒了也是它把原因写进状态），所以那一刻 `peerKeyId` 还是空的。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useT } from '../lib/i18nContext';
import { markLinkUserClosed, subscribeLinkStatus, type LinkStatus } from '../lib/link';
import { isLinkDown, makeRemotePath, remoteScope, remoteTabs, type RemoteTabView } from '../lib/remote';

/** 一次最多接过来这么多份：桌面上开着 40 个标签时，40 次远程读会把这趟交接拖成十几秒 */
export const HANDOFF_MAX_TABS = 12;

/** 发起之后等多久算这趟没成。拨一个到不了的地址，系统层面的 TCP 超时就要二十来秒，
    比它短会在还能等的时候先报一句"超时"，比它长则让人对着没反应的界面自己猜 */
export const HANDOFF_DEADLINE_MS = 25_000;

/**
 * 记一笔「这次连上了要交接，并且这一趟的结果要说给他听」，返回收回它的函数。
 * 收回是给**命令本身就没过**那条路用的（地址为空、URI 不对）：那次拨号根本没发生，
 * 留在待交接状态里只会等到超时报一句无关的话。
 */
export type BeginHandoff = () => () => void;

export interface HandoffOptions {
  /** 只有手机端有"对面那台电脑"这回事 */
  enabled: boolean;
  /** 手机里已有的标签：同一路径不重开，免得把用户手上那份没保存的盖掉 */
  hasTab: (path: string) => boolean;
  /** 打开一份远程标签；activate=false 时只排进标签条、不抢前台 */
  openRemote: (path: string, activate: boolean) => Promise<void>;
  /** 电脑上正看着那一份手机里已经开着：只把它切到前台，一次磁盘都不读 */
  reveal: (path: string) => void;
  /** 桌面设了共享根：手机的文件树换成那棵树（给的是远程根，抽屉开不开由调用方定） */
  adoptRoot: (remoteRoot: string) => void;
  /** 一份都接不过来（只在用户主动那一次说） */
  onNothing: () => void;
  /** 这趟没成（桌面拒了 / 等不到回应）：原因交给调用方说，这里不碰界面 */
  onFailed: (msg: string) => void;
}

/** 桌面的拒因是 Rust 写好的那句人话，原样带出去；只有非字符串的异常才兜底成一句通用的 */
function reasonOf(e: unknown): string {
  const m = (e as { message?: string })?.message;
  return typeof m === 'string' && m ? m : String(e);
}

export function useLinkHandoff(o: HandoffOptions): BeginHandoff {
  const t = useT();
  const { enabled } = o;
  const opt = useRef(o);
  opt.current = o;
  /** 最近一份状态：connected 之后掉线的瞬间就不该再往标签条里补第二份 */
  const latest = useRef<LinkStatus | null>(null);
  /** 用户主动发起的那一次：只有它说话 */
  const pending = useRef(false);
  /** 这条连接（按对端 keyId 认）已经交接过了 —— 断开时清掉 */
  const ranFor = useRef('');
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const drop = () => { pending.current = false; stopTimer(); };

  const fail = (msg: string) => {
    drop();
    opt.current.onFailed(msg);
  };

  /** 立"这趟到点还没成就说话"那只表：只有用户主动发起那一次立，中途掉线把意图留回去时再立一次 */
  const arm = () => {
    stopTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!pending.current) return;
      fail(t('link.handoffTimeout'));
    }, HANDOFF_DEADLINE_MS);
  };

  /** `report` = 这一趟是用户主动发起的，结果（含"没成"）要说给他听 */
  const finish = async (deviceId: string, report: boolean) => {
    running.current = true;
    drop();
    try {
      const tabsP = remoteTabs();
      const scopeP = remoteScope();
      let tabs: RemoteTabView[] | null;
      try {
        tabs = await tabsP;
      } catch (e) {
        /* 链路级失败（「链路已断开：连接已结束」那一类）**不算"这趟没成"**：刚连上又被掐是
           这条链路的常态 —— 息屏、桌面重启、第二条连接顶上来都会这样，而掉线之后本来就会
           自动接回来。为它弹一屏模态，用户读到的是"我配对失败了"，实际发生的是一次自愈。
           所以把意图原样留回去，下一次 connected 再跑一遍；真的一直回不来，由上面那只表说话。 */
        if (isLinkDown(e)) {
          if (report) {
            pending.current = true;
            arm();
          }
          return;
        }
        if (report) opt.current.onFailed(reasonOf(e));
        tabs = null;
      }
      // 树与标签是两件事：问不到共享范围只是不换树，那几份标签该开还是要开
      const hasRoot = await scopeP.then((v) => v.hasRoot).catch(() => false);
      if (hasRoot) opt.current.adoptRoot(makeRemotePath(deviceId, ''));
      if (!tabs) return;
      const all = tabs
        .filter((x) => !!x.rel && !x.reason)
        .map((x) => {
          const path = makeRemotePath(deviceId, x.rel);
          return { path, active: x.active, had: opt.current.hasTab(path) };
        });
      /* 电脑上正看着那一份手机里已经开着（冷启动刚把它从会话快照里恢复出来就是这么个形状）：
         切到前台就够了，再读一次磁盘只是慢，而且脏的那一份会被盖掉 */
      const seen = all.find((x) => x.active && x.had);
      if (seen) opt.current.reveal(seen.path);
      const items = all.filter((x) => !x.had).slice(0, HANDOFF_MAX_TABS);
      if (!items.length) {
        if (report && !seen) opt.current.onNothing();
        return;
      }
      /* 桌面上正看着的那一份先开、且开到前台：扫完码第一眼看见的就是它。
         其余的一份一份排在后面安静补进来，中途掉线就停手 —— 剩下的每一份都会
         各自撞出一条「打开失败」，那种刷屏比不补更糟。 */
      const first = items.find((x) => x.active) ?? items[0];
      await opt.current.openRemote(first.path, true);
      for (const x of items) {
        if (x === first) continue;
        if (latest.current?.connected !== true) break;
        await opt.current.openRemote(x.path, false);
      }
    } finally {
      running.current = false;
    }
  };

  /**
   * 事件回调与 `begin` 都从这里取**当下一轮**的函数，而订阅本身不跟着重挂。
   *
   * 为什么不把它们写进下面那个 effect 的依赖：`useT` 每渲染给一个新的 `t`（`arm` 要用它取文案），
   * 于是 `arm` / `finish` / 依赖它们的 effect 也每轮都"变了" —— 每次 App 重渲染都退订再订阅，
   * 而退订的清理会把「这次要交接」这个意图一起抹掉。扫码那条路收相机就是 App 自己的一次 setState，
   * 它必然排在 `connected` 事件之前，于是意图在事件到达时就没了：交接静默不发生，
   * 既不摊开电脑上那份，也不换手机那棵树，而且一句错都不报（2026-09-27 他手机上撞的正是这个）。
   */
  const impl = useRef({ arm, fail, finish });
  impl.current = { arm, fail, finish };

  useEffect(() => {
    if (!enabled) return;
    const off = subscribeLinkStatus((s) => {
      latest.current = s;
      if (!s.connected) {
        // 断开 = 这条连接结清；下一次 connected 是该重新交接的一次
        ranFor.current = '';
        if (running.current) return;
        /* 「这次拨号被拒了」的判据：拨号那一刻 Rust 把 last_error 清空、把 peer_addr 写上，
           拒掉时反过来（清地址、留原因）。所以"没连着 + 没在拨 + 有一句原因"就是这一趟的结果，
           不会把上一次失败留下的旧原因当成本次的。 */
        if (pending.current && !s.peerAddr && s.lastError) impl.current.fail(s.lastError);
        return;
      }
      if (!s.peerKeyId || running.current) return;
      if (ranFor.current === s.peerKeyId) { drop(); return; }
      ranFor.current = s.peerKeyId;
      const report = pending.current;
      drop();
      void impl.current.finish(s.peerKeyId, report);
    });
    // 退订只停表：那只表是订阅期内的东西，而「这次要交接」是用户点按留下的，不该随订阅一起没
    return () => { off(); stopTimer(); };
  }, [enabled]);

  /**
   * 交接的起点（用户主动那一次）。命令返回的快照里 `peerKeyId` 还是空的（握手在连接线程里跑），
   * 所以这里只立意图，落地等状态事件 —— 但事件也可能已经先到了（局域网里握手不到 100 ms），
   * 于是立完意图立刻拿最新那份状态再判一次。
   */
  const begin = useCallback<BeginHandoff>(() => {
    if (!opt.current.enabled) return () => {};
    // 「用户主动要连」= 之前那次点「断开」作废，之后再息屏该替他接回来
    markLinkUserClosed(false);
    stopTimer();
    pending.current = true;
    impl.current.arm();
    const s = latest.current;
    if (s?.connected && s.peerKeyId) {
      /* 事件先到（局域网里握手不到 100 ms）时这条连接的交接已经做过了：再跑一遍就是白读十几份
         远程文件。收回意图仍然要做 —— 那只报"超时"的表不该留着。 */
      drop();
      if (ranFor.current !== s.peerKeyId) {
        ranFor.current = s.peerKeyId;
        void impl.current.finish(s.peerKeyId, true);
      }
    }
    return drop;
  }, []);

  return begin;
}
