import { Monitor, Smartphone } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * 状态卡顶上那条「接线轨道」：这台设备 ⟷ 对面那台，中间那条线就是连接本身。
 *
 * 为什么是它当这块面板的签名元素：设备互联说的从来不是"某个开关开没开"，而是
 * "两台机器之间那条线现在通不通、通到谁"。所以形状自己就把话说完 ——
 * 线断在中间就是没通，线实心发亮就是通了，点上有个东西在走就是正在握手。
 * 状态文字仍然在旁边（读屏与色觉障碍靠它），轨道只是让人**不用读**就先看懂。
 *
 * 五档形状各不相同，其中 `broken` 是这一版才分出来的：桌面端口开着、
 * 却没有任何设备来连（多半被防火墙拦），以前和"没开"长得一样，害人在设置里翻半天。
 */
export type RailPhase = 'off' | 'waiting' | 'connecting' | 'connected' | 'broken';

interface Props {
  phase: RailPhase;
  dark: boolean;
  /** 谁是"这台"：桌面这边画显示器、安卓那边画手机，两端的图标随角色对调 */
  asClient: boolean;
  /** 读屏用的那句话，直接给状态文案，不在这块里另编一套说法 */
  label: string;
}

const NODE = 'flex items-center justify-center shrink-0 rounded-[9px] border transition-colors';

export function DeviceLinkRail({ phase, dark, asClient, label }: Props) {
  const thisIcon = asClient ? Smartphone : Monitor;
  const peerIcon = asClient ? Monitor : Smartphone;
  const This = thisIcon;
  const Peer = peerIcon;

  const live = phase === 'connected';
  const busy = phase === 'connecting';
  const hurt = phase === 'broken';

  /* 中性档（没开 / 在等）两颗节点都是"描边空心"，只有真的接上了才各自点亮：
     本机这端 indigo（这块面板的强调色），对端 emerald（"那边有人了"）。
     断在半路那一档**两端都不染色** —— 那条路是被我这边的防火墙拦下的，
     把对面那颗涂成警告色是冤枉它 */
  const thisCls = live || busy
    ? (dark ? 'border-indigo-400/50 bg-indigo-500/15 text-indigo-300' : 'border-indigo-500/40 bg-indigo-500/10 text-indigo-600')
    : (dark ? 'border-zinc-600 text-zinc-500' : 'border-zinc-300 text-zinc-400');
  const peerCls = live
    ? (dark ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600')
    : (dark ? 'border-zinc-600 text-zinc-500' : 'border-zinc-300 text-zinc-400');

  const segIdle = dark ? 'text-zinc-500' : 'text-zinc-400';
  /* 三种线形必须互不相同，只靠颜色分不开（色觉障碍与深浅色下的对比度都不一样）：
     虚线 = 还没接上；一整条实心渐变 = 接上了；实心但中间断一截 = 接不上（半死） */
  const dashed = !live && !hurt;

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('flex items-center gap-0 select-none', busy && 'opacity-95')}
    >
      <span className={cn(NODE, 'w-7 h-7', thisCls)}>
        <This size={14} strokeWidth={1.9} />
      </span>

      <span className={cn('relative flex flex-1 items-center px-1', dashed && segIdle)}>
        {/* 三段只在「断在半路」这一档出现。以前每档都拆成两段，而每段各自跑一遍
            indigo→emerald 的渐变，中间必然出现一次颜色回跳 —— 一条"已连接"的线
            看着还是断的，正好把这次要修的事又犯了一遍 */}
        {hurt ? (
          <>
            <span className={cn('h-[2px] flex-1 rounded-full', dark ? 'bg-amber-400/70' : 'bg-amber-500/70')} />
            <span className="w-3 shrink-0" />
            <span className={cn('h-[2px] flex-1 rounded-full', dark ? 'bg-amber-400/70' : 'bg-amber-500/70')} />
          </>
        ) : dashed ? (
          <span className="heid-rail-dash flex-1" />
        ) : (
          <span className="h-[2px] flex-1 rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500" />
        )}

        {/* 正在握手：一个点从这头走到那头。只有 connecting 这一档在动 ——
            连上之后还留着走动的光点，会让人以为这条链路还没稳 */}
        {busy && (
          <span className="heid-rail-run absolute top-1/2 -mt-[3px] h-[6px] w-[6px] rounded-full bg-indigo-400" />
        )}
        {/* 服务端开着共享、还没有设备来连：对端那颗空心节点慢慢呼吸，说的是"在等你" */}
        {phase === 'waiting' && (
          <span
            className={cn(
              'heid-rail-pulse absolute right-1 top-1/2 -mt-[3px] h-[6px] w-[6px] rounded-full',
              dark ? 'bg-zinc-400' : 'bg-zinc-500',
            )}
          />
        )}
      </span>

      <span className={cn(NODE, 'w-7 h-7', peerCls)}>
        <Peer size={14} strokeWidth={1.9} />
      </span>
    </div>
  );
}
