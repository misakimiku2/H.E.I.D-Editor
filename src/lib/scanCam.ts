/**
 * 扫码器的相机数学：取流错误分流、镜头候选排序、捏合→倍率映射、倍率刻度、取景取样矩形。
 * 与 DOM 无关的一律放这里，便于单测（`QrScanner.tsx` 只留手势事件与渲染）。
 */

export interface Lens { deviceId: string; label: string }

/** `getUserMedia` 抛的 DOMException.name → 该走哪条恢复路径。文案与重试策略都按这个分流。 */
export type ScanFailure = 'perm' | 'busy' | 'constraint' | 'nocam';

const PERM = new Set(['NotAllowedError', 'PermissionDeniedError', 'PermissionBlockedError']);
const CONSTRAINT = new Set(['OverconstrainedError', 'ConstraintNotSatisfiedError']);
const NOCAM = new Set(['NotFoundError', 'DevicesNotFoundError', 'NoSupportedTracksError', 'NotSupportedError']);

/** 未列出的名字（NotReadableError / AbortError / SecurityError / 内核自造的）都按「占用」处理：
 *  安卓多摄上「上一颗还没释放」就表现为这些，等一会儿重开能好；叫用户去系统设置是误导。 */
export function classifyGumError(name: string | undefined): ScanFailure {
  if (PERM.has(name ?? '')) return 'perm';
  if (CONSTRAINT.has(name ?? '')) return 'constraint';
  if (NOCAM.has(name ?? '')) return 'nocam';
  return 'busy';
}

/** 明显不是主摄的后置镜头关键字（长焦/超广/微距/景深） */
export const NOT_MAIN = /tele|zoom|ultra|\bwide\b|wide.?angle|macro|depth|2x|3x|5x|10x/i;
export const BACK = /back|environment|后置|背面|arri/i;

/** 候选优先级：0 上次扫得出来的 → 1 名字没长焦/超广字样的 → 2 那些的 → 3 实测开不出画面/是前置的 */
export function lensRank(lens: Lens, savedId: string, badIds: readonly string[]): number {
  if (lens.deviceId === savedId) return 0;
  if (badIds.includes(lens.deviceId)) return 3;
  return NOT_MAIN.test(lens.label) ? 2 : 1;
}

/**
 * 排出自动逐颗试开的后置镜头序列：先用 label 筛出后置（筛不出就用全量，靠开出来实测 facingMode 过滤前置），
 * 再按 `lensRank` 稳定排序。
 */
export function orderLenses(devices: readonly Lens[], savedId = '', badIds: readonly string[] = []): Lens[] {
  const back = devices.filter((d) => BACK.test(d.label));
  const pool = back.length ? back : [...devices];
  return pool
    .map((lens, i) => ({ lens, i, rank: lensRank(lens, savedId, badIds) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ lens }) => lens);
}

/**
 * 捏合 → 目标倍率：**对数**映射，一次完整捏合行程（双指张开 `fullTravel` 倍）走完这颗镜头的全部焦段。
 *
 * 为什么不用线性的 `base × 距离比`：镜头焦段是 1×–10× 这种倍数关系，线性下要从 1× 拉到 10× 得把
 * 手指真张开十倍（屏宽根本不够），于是「拉到头也没变焦多少」；对数映射让不同镜头、不同起点的
 * 同一手指行程对应同样的倍率变化，这才是系统相机的手感。
 */
export function pinchZoom(ratio: number, base: number, min: number, max: number, fullTravel = 3): number {
  if (!(ratio > 0) || max <= min) return clampNum(base, min, max);
  const gain = Math.log(max / min) / Math.log(Math.max(1.2, fullTravel));
  return clampNum(base * Math.pow(ratio, gain), min, max);
}

/** 一阶低通：每帧把当前倍率推向目标（τ 越小越跟手，越大越黏）。避免手指抖动直接灌进 applyConstraints。 */
export function approach(cur: number, target: number, dtMs: number, tauMs = 55): number {
  const diff = target - cur;
  if (Math.abs(diff) < 1e-4) return target;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / Math.max(1, tauMs));
  return cur + diff * k;
}

/**
 * 倍率圆片：从 [min,max] 里挑至多 4 个刻度，两端钉住、中间偏取小倍率（1×/2×/4× 这类常用位）。
 * 数码变焦的镜头（1–4×）得到 [1,2,4]，硬件 1–10× 得到 [1,2,4,10]。
 */
export function zoomStops(min: number, max: number): number[] {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const lo = r1(min), hi = r1(max);
  if (!(hi > lo)) return [lo];
  const uniq = [...new Set([min, 1, 2, 4, 8, max].map(r1).filter((v) => v >= lo && v <= hi))].sort((a, b) => a - b);
  if (uniq.length <= 4) return uniq;
  return [uniq[0], ...uniq.slice(1, -1).slice(0, 2), uniq[uniq.length - 1]];
}

export interface SrcRect { sx: number; sy: number; sw: number; sh: number }

/**
 * `object-cover` 铺满 + 数码放大 `zoom` 之后，**屏幕上真正可见的那块**对应到视频原始帧的矩形。
 *
 * cover 会等比放大到填满显示框并居中裁掉多余的一边；数码变焦等价于把可见区域再除以 zoom。
 * 冻结上一帧做切换过渡、以及数码变焦时只把放大区域送去解码，都共用这个矩形，保证「看到的」和「解的」一致。
 */
export function coverSampleRect(
  vw: number, vh: number, bw: number, bh: number, zoom = 1,
): SrcRect {
  if (!(vw > 0 && vh > 0 && bw > 0 && bh > 0)) return { sx: 0, sy: 0, sw: Math.max(0, vw), sh: Math.max(0, vh) };
  const z = Math.max(1, zoom);
  const cover = Math.max(bw / vw, bh / vh);
  const sw = Math.min(vw, bw / cover / z);
  const sh = Math.min(vh, bh / cover / z);
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
}

/** 把 src 边长按比例缩到最长边不超过 maxSide（至少 1px），用于离屏 canvas 尺寸 */
export function fitLongSide(srcW: number, srcH: number, maxSide: number): { w: number; h: number } {
  const m = Math.max(srcW, srcH);
  const k = m > 0 ? Math.min(1, maxSide / m) : 0;
  return { w: Math.max(1, Math.round(srcW * k)), h: Math.max(1, Math.round(srcH * k)) };
}

export function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 倍率显示：1 → 「1×」，2.43 → 「2.4×」，0.6 → 「0.6×」 */
export function formatZoom(v: number): string {
  const s = v >= 10 ? v.toFixed(0) : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${s}×`;
}
