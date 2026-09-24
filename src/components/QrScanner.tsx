/**
 * 应用内二维码扫码器（v1.5 阶段 1「扫一扫」）。懒加载独立 chunk：相机 + 解码库都不进主包。
 *
 * 为什么必须应用内做：系统相机不认 `hide-link://` 这个自定义 scheme（§7.2）。
 *
 * 手感上按系统相机的路子来（`src/lib/scanCam.ts` 里的都是那套数学，可单测）：
 * - **一次开流**：上次扫成功记住的镜头直接 `exact deviceId` 开，不再「先开一颗拿权限、再重开一次」。
 * - **捏合跟手**：倍率走对数行程映射 + 每帧低通逼近后再下发，不会手指一抖就跳；
 *   镜头本身不支持 `zoom` 时由数码放大顶上（预览缩放 + 解码只喂屏幕上可见那块区域，两者严格一致）。
 * - **占用不自杀**：`NotReadableError` 这类「上一颗还没释放」按退避自动重试，不叫用户去系统设置。
 *
 * **扫码只有一颗镜头在干活**，这不是省事而是设计判断：手机动辄报出 6 颗「facing back」
 * （Mate 40 Pro 实测 6 颗），把它们做成用户能切的东西既不是扫码该有的动作，每切一次还要重开一次流
 * （真机反馈就是那一下卡顿）。选镜头是**开机时内部**解决的事：实测朝向、黑屏/前置的颗记进坏镜头表、
 * 扫成功那一刻记住真正用得上的那颗；界面上只有在同一颗上对着扫了 ~8s 仍解不出码时，
 * 才提一句「换个镜头试试」，点了才走（走之前把当前帧冻住，新流首帧到了再淡出，不露黑屏）。
 *
 * 拿不到相机的每一种情况都明确报错并降级到「粘贴配对码 / 6 位短码」，绝不静默。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Loader2, RefreshCw, SwitchCamera, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import {
  approach, classifyGumError, coverSampleRect, fitLongSide, formatZoom,
  orderLenses, pinchZoom, zoomStops,
} from '../lib/scanCam';
import type { Lens, ScanFailure } from '../lib/scanCam';

type ScanState = 'starting' | 'scanning' | 'busy' | 'noperm' | 'unavail' | 'nosupport';
interface DetectedCode { rawValue?: string; value?: string }
interface DetectorLike { detect(source: CanvasImageSource): Promise<DetectedCode[]> }
type DetectorCtor = new (opts?: { formats?: string[] }) => DetectorLike;
type ZoomCaps = MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
/** 当前生效的倍率模型：hw=true 下发给镜头，hw=false 由预览做数码放大 */
interface ZoomModel { min: number; max: number; hw: boolean; cur: number; target: number }

const CAM_KEY = 'heid-scan-cam';
/** 只有**真扫成功过**的镜头才写这里。开机写下的记号可能是失败探测的产物（比如长焦），
 *  没被这个键确认过的记号不作数，要按交付尺寸重新判——否则一次错记就永久一枪直达错的颗。 */
const CAM_OK_KEY = 'heid-scan-cam-ok';
const BAD_KEY = 'heid-scan-cam-bad';
/** 720p 而不是 1080p：HAL 起流明显更快，而解码最长边只用到 640 */
const RES = { width: 1280, height: 720 };
/** 探针/首开按这个尺寸要流：不为预览，只为**量**这颗镜头的传感器有多大。
 *  请求必须给到 8K 档——设成 12MP 等于给测量加天花板：Mate 的潜望长焦本身就是 12MP 传感器，
 *  12MP 请求下它和主摄交付一样大，分不开（真机实测踩过）。8K 请求下主摄交付 50MP、长焦只有 12MP。
 *  `getCapabilities().width.max` 在华为上报流配置上限、六颗一个值，同样分不开，不用。 */
const RES_PROBE = { width: 8192, height: 6144 };
const RELEASE_MS = 150;      // 关一颗到开下一颗之间给 HAL 的释放时间（紧接着重开常报占用）
const PROBE_FRAME_MS = 900; // 判定「这颗开不出画面」的等待上限
const FIRST_FRAME_MS = 1200;
/** 无记号时最多探几颗：探得越多越准，但每颗都要开一次流，首次进入的等待也越长。
 *  给到 6 是因为 Mate 40 Pro 实测报 6 颗后置——上限低于镜头数就可能漏掉主摄，
 *  而漏掉之后记号会把这个错误固化成「每次一枪直达错的那颗」。 */
const MAX_PROBE = 6;
/** 「主摄级」下限：8K 请求下**实际交付**的像素数 ≥ 它，就认定是主摄/超广（都扫得了），
 *  首颗达标则一颗都不探，探测时碰到第一颗达标的也立刻停。
 *  16MP 的取值：Mate 潜望长焦 12MP 给不出、主摄 50MP / 超广 20MP 给得出。
 *  它只是「提前停」的优化：全机器都给不出的老手机会探完所有候选、取交付最大的那颗，不会瞎换。 */
const MAIN_FLOOR = 16_000_000;
/**
 * 机型档案：label 在这类机器上读不出主次、逐颗探测又贵（首次进入要好幾秒），
 * 所以对**真机实测过**的机型直接点名主摄，一次 720p 开流定稿。
 * 运行时仍校验（开不出画面 / 是前置就退回探测流），档案错了也不会卡死或黑屏。
 * 种子来自 2026-09-24 的 8K 交付测量：Mate 40 Pro（NOH-AL00）落在 `camera2 4, facing back`。
 */
const MAIN_BY_MODEL: Record<string, readonly string[]> = {
  'NOH-AL00': ['camera2 4, facing back'],
};

const BUSY_WAITS = [400, 1000, 2200]; // 占用后退避重试约 3 秒，再转手动
const DIGITAL_MAX = 4;      // 无硬件变焦镜头的数码放大上限
const FREEZE_MAX_MS = 2400; // 冻结帧最长滞留，别让画面永远停在旧镜头
const HUD_KEEP_MS = 700;
const SAMPLE_SIDE = 640;

/** 最近 60 条诊断：华为/鸿蒙默认把第三方 App 的 logcat 压掉（`Log.i` 根本不进缓冲区），
 *  所以 logcat 这条道在 Mate 上不可靠；界面里这份环缓冲 + 截图才是稳的诊断通道。 */
const LOG_RING: string[] = [];

function dlog(...a: unknown[]) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  // eslint-disable-next-line no-console
  console.log('[heid-scan]', line);
  // 非华为设备上 logcat 仍可用，双写不亏
  try {
    (window as unknown as { HeidBridge?: { log(msg: string): void } }).HeidBridge?.log(line);
  } catch { /* 桥不在（桌面/测试）就算了 */ }
  LOG_RING.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  if (LOG_RING.length > 60) LOG_RING.shift();
}

const sleepMs = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const store = {
  get(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* 隐私模式写不进就算了 */ } },
};
const readBadLenses = () => store.get(BAD_KEY).split(',').filter(Boolean);
function rememberBadLens(id: string) {
  if (!id) return;
  const bad = readBadLenses().filter((d) => d !== id);
  bad.unshift(id);
  store.set(BAD_KEY, bad.slice(0, 8).join(','));
}
const lensConstraints = (deviceId: string, res: { width: number; height: number } = RES): MediaTrackConstraints =>
  deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: res.width }, height: { ideal: res.height } }
    : { facingMode: 'environment', width: { ideal: res.width }, height: { ideal: res.height } };

export default function QrScanner({
  onResult, onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
  dark: boolean;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const detRef = useRef<DetectorLike | null>(null);
  const jsqrRef = useRef<typeof import('jsqr').default | null>(null);
  const rafRef = useRef(0);          // 解码循环（整场只跑一个，不随开流重启）
  const zoomRafRef = useRef(0);      // 倍率平滑循环
  const stoppedRef = useRef(false);
  const lastScanRef = useRef(0);
  const missRef = useRef(0);
  const loadingJsqrRef = useRef(false);
  const lastZoomAtRef = useRef(0);
  const applyingRef = useRef(false); // 一次只挂一份 applyConstraints，后到的覆盖前一份
  const applyWantRef = useRef<number | null>(null);
  const zoomRef = useRef<ZoomModel>({ min: 1, max: 1, hw: false, cur: 1, target: 1 });
  const lensesRef = useRef<Lens[]>([]);
  const candPosRef = useRef(0);
  const reqRef = useRef<number | null>(null); // 排队等切的镜头下标（最后一次点击说了算）
  const walkingRef = useRef(false);
  const freezeHoldRef = useRef(false);
  const freezeTimerRef = useRef(0);
  const lensHintRef = useRef(false);   // 一次开流只提一次「换镜头」

  const hudTimerRef = useRef(0);
  const hudValRef = useRef(1);
  // 双指捏合：ptrs 记活动指针，pinchBase/zoomBase 是本次手势的起始指距与起始倍率
  const ptrsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchBaseRef = useRef(0);
  const zoomBaseRef = useRef(1);

  const [state, setState] = useState<ScanState>('starting');
  const [notCode, setNotCode] = useState(false);
  const [lenses, setLenses] = useState<Lens[]>([]);
  /** 对着扫了一段时间还是没解出码，才提示「也许是这颗镜头不合适」（默认不出现，扫码不换镜头） */
  const [lensHint, setLensHint] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [dbg, setDbg] = useState('');
  const [range, setRange] = useState<{ min: number; max: number; stops: number[] } | null>(null);
  const [hud, setHud] = useState(false);
  const [hudVal, setHudVal] = useState(1);
  /** 探测进度：非空表示「正在逐颗量镜头」——此时不给看画面（黑屏 + 转圈 + 进度），选好了才点亮 */
  const [probeStep, setProbeStep] = useState<{ i: number; n: number } | null>(null);
  const [cold, setCold] = useState(false);
  const [fading, setFading] = useState(false);
  /** play() 被内核拦下时（真机上见过满屏的灰色播放按钮占位符）在界面上直说，不让他猜 */
  const [playBlocked, setPlayBlocked] = useState(false);
  /** 点调试行展开的日志环缓冲：华为上 logcat 不可靠，截图这份才是稳的诊断通道 */
  const [logOpen, setLogOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    if (!logOpen) return;
    const pull = () => setLogLines([...LOG_RING]);
    pull();
    const id = window.setInterval(pull, 800);
    return () => window.clearInterval(id);
  }, [logOpen]);

  // 回调用 ref 转发：DeviceLinkSection 每次渲染都会重建 onResult，若把它排进开流 effect 的依赖，
  // 面板上任何一次状态更新都会把相机整个重启一遍。
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    trackRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    stoppedRef.current = true;
    cancelAnimationFrame(rafRef.current);
    cancelAnimationFrame(zoomRafRef.current);
    window.clearTimeout(freezeTimerRef.current);
    window.clearTimeout(hudTimerRef.current);
    stopStream();
  }, [stopStream]);

  /* ---------------- 倍率：目标由手势/圆片给出，实际值每帧低通逼近后再下发 ---------------- */

  const keepHud = () => {
    const z = zoomRef.current;
    setHud(ptrsRef.current.size >= 2 || z.cur > z.min + 0.02);
    window.clearTimeout(hudTimerRef.current);
    if (ptrsRef.current.size < 2) {
      hudTimerRef.current = window.setTimeout(() => {
        const c = zoomRef.current;
        setHud(ptrsRef.current.size >= 2 || c.cur > c.min + 0.02);
      }, HUD_KEEP_MS);
    }
  };

  const pushZoom = useCallback((v: number) => {
    const z = zoomRef.current;
    z.cur = v;
    const track = trackRef.current;
    if (z.hw && track) {
      if (applyingRef.current) { applyWantRef.current = v; }
      else {
        const send = (val: number) => {
          applyingRef.current = true;
          const done = () => {
            applyingRef.current = false;
            const w = applyWantRef.current;
            applyWantRef.current = null;
            if (w != null && !stoppedRef.current && zoomRef.current.hw && trackRef.current) send(w);
          };
          try {
            // @ts-expect-error zoom 不是标准约束，但安卓的 camera2 后端认
            track.applyConstraints({ advanced: [{ zoom: val }] } as MediaTrackConstraints).then(done, (e: unknown) => {
              dlog('变焦下发失败', String(e));
              done();
            });
          } catch (e) { dlog('变焦下发异常', String(e)); done(); }
        };
        send(v);
      }
    } else if (!z.hw && videoRef.current) {
      videoRef.current.style.transform = `scale(${v})`;
    }
    const r1 = Math.round(v * 10) / 10;
    if (r1 !== hudValRef.current) { hudValRef.current = r1; setHudVal(r1); }
    keepHud();
  }, []);

  const pumpZoom = useCallback(() => {
    const z = zoomRef.current;
    const now = performance.now();
    const dt = now - (lastZoomAtRef.current || now);
    lastZoomAtRef.current = now;
    const next = approach(z.cur, z.target, dt);
    if (next !== z.cur) pushZoom(next);
    if (z.cur !== z.target && !stoppedRef.current) {
      zoomRafRef.current = requestAnimationFrame(pumpZoom);
    } else {
      zoomRafRef.current = 0;
      z.cur = z.target;
      pushZoom(z.target);
    }
  }, [pushZoom]);

  const wantZoom = useCallback((target: number, instant = false) => {
    const z = zoomRef.current;
    z.target = Math.min(z.max, Math.max(z.min, target));
    if (instant) { z.cur = z.target; pushZoom(z.cur); keepHud(); return; }
    keepHud();
    if (zoomRafRef.current) return;
    lastZoomAtRef.current = performance.now();
    zoomRafRef.current = requestAnimationFrame(pumpZoom);
  }, [pumpZoom, pushZoom]);

  /** 开新流后读这颗镜头的变焦能力，重建倍率模型 */
  const adoptZoom = useCallback((track: MediaStreamTrack | null) => {
    const caps = (track?.getCapabilities?.() ?? {}) as ZoomCaps;
    const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings & { zoom?: number };
    const hz = caps.zoom && caps.zoom.max > caps.zoom.min + 1e-6 ? caps.zoom : null;
    dlog('变焦能力', { label: track?.label, capsZoom: caps.zoom ?? null, settingsZoom: st.zoom ?? null, 走: hz ? '光学' : '数码' });

    const min = hz ? hz.min : 1;
    const max = hz ? hz.max : DIGITAL_MAX;
    const cur = hz ? (st.zoom ?? hz.min) : 1;
    // 换镜头后上一颗的动画作废：倍率模型整个换成新这颗的原生状态
    cancelAnimationFrame(zoomRafRef.current);
    zoomRafRef.current = 0;
    zoomRef.current = { min, max, hw: !!hz, cur, target: cur };
    hudValRef.current = Math.round(cur * 10) / 10;
    setHudVal(hudValRef.current);
    setRange({ min, max, stops: zoomStops(min, max) });
    if (!hz && videoRef.current) videoRef.current.style.transform = 'scale(1)';
    return { hw: !!hz, min, max };
  }, []);

  /* ---------------- 冻结帧：切换期间盖住「关旧流到开新流」那段黑 ---------------- */

  const releaseFreeze = useCallback(() => {
    if (!freezeHoldRef.current) return;
    freezeHoldRef.current = false;
    window.clearTimeout(freezeTimerRef.current);
    setFading(true);
    window.setTimeout(() => { setCold(false); setFading(false); }, 280);
  }, []);

  /** 把屏幕上正显示的那块画面（含数码放大）画进覆盖画布。没画面可冻时返回 false。 */
  const captureFreeze = useCallback(() => {
    // 一次切换序列里保留最早那张好画面，并且每试一颗就把滞留上限往后推一格
    if (freezeHoldRef.current) {
      window.clearTimeout(freezeTimerRef.current);
      freezeTimerRef.current = window.setTimeout(releaseFreeze, FREEZE_MAX_MS);
      return true;
    }
    const v = videoRef.current, box = rootRef.current, c = freezeRef.current;
    if (!v || !box || !c || v.videoWidth <= 0) return false;
    const z = zoomRef.current;
    const rect = coverSampleRect(v.videoWidth, v.videoHeight, box.clientWidth, box.clientHeight, z.hw ? 1 : z.cur);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(box.clientWidth * dpr));
    c.height = Math.max(1, Math.round(box.clientHeight * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(v, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, c.width, c.height);
    freezeHoldRef.current = true;
    setCold(true);
    setFading(false);
    dlog(`冻结当前帧 ${Math.round(rect.sw)}×${Math.round(rect.sh)} ← ${v.videoWidth}×${v.videoHeight} zoom=${z.cur.toFixed(2)}`);
    // 新流一直起不来的时候也要把画面交还给实时预览，别冻死
    window.clearTimeout(freezeTimerRef.current);
    freezeTimerRef.current = window.setTimeout(releaseFreeze, FREEZE_MAX_MS);
    return true;
  }, [releaseFreeze]);


  /* ---------------- 取流 ---------------- */

  /** 调试行：解码器 · 交付尺寸 · 朝向 · 镜头 · 光学/数码。降分辨率等约束变化后也要重算，
   *  否则界面会一直显示开流那一刻的尺寸，把人引去错的方向（真机就看过 3000×4000 挂一整天）。 */
  const setDbgFromTrack = useCallback(() => {
    const track = trackRef.current;
    const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings;
    const z = zoomRef.current;
    setDbg([
      detRef.current ? 'BarcodeDetector' : 'jsQR',
      `${st.width ?? '?'}×${st.height ?? '?'}`,
      st.facingMode || '?',
      track?.label || `#${(st.deviceId ?? '').slice(0, 6)}`,
      z.hw ? '光学变焦' : '数码变焦',
    ].join(' · '));
  }, []);

  const attach = useCallback(async (stream: MediaStream) => {
    streamRef.current = stream;
    const track = stream.getVideoTracks()[0] ?? null;
    trackRef.current = track;
    // 倍率模型先立起来，别排在 play() 后面：开流时 play 偶发不 resolve，
    // 那会让圆片和捏合空转到首帧事件到达才有反应（白等一次 rVFC/轮询）。
    const z = adoptZoom(track);
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      video.style.transform = '';
      // play() 被拦时 WebView 会在视频区画一个巨大的播放按钮占位符（真机见过），
      // 所以这里把结果原样记下来，并在 canplay 时再补一次，绝不静默。
      const kick = (why: string) => {
        video.play().then(
          () => { setPlayBlocked(false); dlog(`play(${why}) 成功 ${video.videoWidth}×${video.videoHeight} readyState=${video.readyState}`); },
          (e: unknown) => { setPlayBlocked(true); dlog(`play(${why}) 被拒：${String(e)} paused=${video.paused} networkState=${video.networkState}`); },
        );
      };
      kick('attach');
      if (video.readyState < 2) {
        const once = () => { video.removeEventListener('canplay', once); kick('canplay'); };
        video.addEventListener('canplay', once);
      }
    }
    try {
      // @ts-expect-error focusMode 非标准，但不开连续对焦时近距离二维码常糊
      await track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as MediaTrackConstraints);
    } catch { /* 不支持就算了 */ }
    const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings;
    missRef.current = 0;
    dlog('已开流', { deviceId: st.deviceId, w: st.width, h: st.height, facing: st.facingMode, zoom: z.hw ? '光学' : '数码' });
    setDbgFromTrack();
  }, [adoptZoom, setDbgFromTrack]);

  /**
   * 开一颗镜头：需要时先关旧的并等 HAL 释放；占用按退避自动重试。返回失败原因（null=成功）。
   * `busy` 的重试额度由**整次切换**共享（`budget.left`）——相机被别的 App 按住是整机级的，
   * 逐颗各重试三轮只会让「占用」变成十几秒的转圈。
   */
  const openLens = useCallback(async (
    deviceId: string, budget = { left: BUSY_WAITS.length }, res: { width: number; height: number } = RES,
  ): Promise<ScanFailure | null> => {
    if (stoppedRef.current) return null;
    cancelAnimationFrame(zoomRafRef.current);
    zoomRafRef.current = 0;
    if (streamRef.current) { stopStream(); await sleepMs(RELEASE_MS); }
    const constraints: MediaStreamConstraints = { audio: false, video: lensConstraints(deviceId, res) };
    dlog(`开流 ${deviceId ? `exact ${deviceId.slice(0, 8)}` : 'facingMode=environment'} @${res.width}×${res.height}`);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stoppedRef.current) { stream.getTracks().forEach((tr) => tr.stop()); return null; }
        await attach(stream);
        return null;
      } catch (e) {
        const failure = classifyGumError((e as DOMException)?.name);
        dlog(`getUserMedia 失败(${failure}, 第 ${attempt + 1} 次)`, String(e));
        const retry = failure === 'busy' && budget.left > 0 && !stoppedRef.current;
        if (!retry) return failure;
        const wait = BUSY_WAITS[BUSY_WAITS.length - budget.left];
        budget.left -= 1;
        setDbg('相机正被占用 · 重试中');
        setState('busy');
        await sleepMs(wait);

      }
    }
  }, [attach, stopStream]);


  /** 等视频真的出帧（videoWidth>0）。轮询 + loadeddata/resize/rVFC，谁先到算谁。 */
  const waitFirstFrame = useCallback((ms: number) => new Promise<boolean>((res) => {
    const v = videoRef.current;
    if (!v || stoppedRef.current) return res(false);
    if (v.videoWidth > 0) return res(true);
    let settled = false;
    let poll = 0;
    let timer = 0;
    const onFrame = () => { if (v.videoWidth > 0) finish(true); };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      v.removeEventListener('loadeddata', onFrame);
      v.removeEventListener('resize', onFrame);
      window.clearInterval(poll);
      window.clearTimeout(timer);
      res(ok);
    };
    v.addEventListener('loadeddata', onFrame);
    v.addEventListener('resize', onFrame);
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
    if (typeof rvfc === 'function') rvfc.call(v, onFrame);
    poll = window.setInterval(onFrame, 80);
    timer = window.setTimeout(() => finish(false), ms);


  }), []);

  const facingOf = () => trackRef.current?.getSettings?.().facingMode as string | undefined;
  const idOf = () => trackRef.current?.getSettings?.().deviceId ?? '';

  /* ---------------- 解码循环（整场只跑一个） ---------------- */

  /** 把屏幕上可见那块区域按 maxSide 上限画进离屏 canvas；返回 null 表示还没有画面 */
  const drawSample = useCallback((maxSide: number) => {
    const v = videoRef.current, box = rootRef.current;
    if (!v || !box || v.videoWidth <= 0) return null;
    const z = zoomRef.current;
    const rect = coverSampleRect(v.videoWidth, v.videoHeight, box.clientWidth, box.clientHeight, z.hw ? 1 : z.cur);
    if (rect.sw < 8 || rect.sh < 8) return null;
    const { w, h } = fitLongSide(rect.sw, rect.sh, maxSide);
    let c = sampleRef.current;
    if (!c) { c = document.createElement('canvas'); sampleRef.current = c; }
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
    return { canvas: c, ctx };
  }, []);

  const handleValue = useCallback((raw: string | undefined) => {
    if (!raw) return false;
    const text = raw.trim();
    if (text.startsWith('hide-link://pair')) {
      dlog('命中配对码', text.slice(0, 40));
      // 扫成功这一刻记下这颗镜头：下次一打开直接落在「真的扫得出来」的那颗，长焦/广角不再被自动选中
      const id = idOf();
      if (id) { store.set(CAM_KEY, id); store.set(CAM_OK_KEY, id); }
      releaseFreeze();
      teardown();
      onResultRef.current(text);
      return true;
    }
    setNotCode(true);
    window.setTimeout(() => setNotCode(false), 1200);
    return false;
  }, [releaseFreeze, teardown]);


  const tick = useCallback(async () => {
    if (stoppedRef.current) return;
    const video = videoRef.current;
    const now = performance.now();
    if (video && video.readyState >= 2 && video.videoWidth > 0 && now - lastScanRef.current > 150) {
      lastScanRef.current = now;
      missRef.current += 1;
      const z = zoomRef.current;
      // 数码放大时解码必须只看放大后那块区域，否则「放大」对手指有用、对解码没用
      const cropped = !z.hw && z.cur > 1.02;
      let src: CanvasImageSource = video;
      let sample: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
      if (cropped) {
        sample = drawSample(SAMPLE_SIDE);
        if (sample) src = sample.canvas;
      }
      // 1) 原生 BarcodeDetector（快）。华为等内核里它可能「存在但盲检」，所以不能只靠它。
      if (detRef.current) {
        try {
          const codes = await detRef.current.detect(src);
          if (handleValue(codes[0]?.rawValue ?? codes[0]?.value)) return;
        } catch (e) { dlog('BarcodeDetector 抛错', String(e)); }
      }
      // 2) 原生连续 ~12 帧（约 2s）没结果 → 拉起 jsQR 一起解，之后两路并行
      if ((!detRef.current || missRef.current > 12) && !jsqrRef.current && !loadingJsqrRef.current) {
        loadingJsqrRef.current = true;
        import('jsqr').then((m) => { jsqrRef.current = m.default; dlog('已启用 jsQR 兜底'); })
          .catch((e) => dlog('jsQR 加载失败', String(e)));
      }
      if (jsqrRef.current) {
        try {
          sample ??= drawSample(SAMPLE_SIDE);
          if (sample) {
            const { canvas: c, ctx } = sample;
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const r = jsqrRef.current(img.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
            if (handleValue(r?.data)) return;
          }
        } catch (e) { dlog('jsQR 解码异常', String(e)); }
      }
      // 对着扫了 ~8s 还没解出码，且这台机器还有别的后置颗 → 才提一句可以换一颗试试。
      // 只是**提示**，不自动换：自动换会把「用户还没对准」误判成「镜头选错了」（上一版踩过）。
      if (missRef.current > 54 && !lensHintRef.current && lensesRef.current.length > 1) {
        lensHintRef.current = true;
        setLensHint(true);
        dlog(`这颗连续 ${missRef.current} 帧没解出码 → 提示可换镜头`);
      }

      setDbg((prev) => `${prev.split(' · 帧')[0]} · 帧${missRef.current}${jsqrRef.current ? '+jsQR' : ''}`);
    }
    rafRef.current = requestAnimationFrame(() => void tick());
  }, [drawSample, handleValue]);

  const startDecode = useCallback(() => {
    if (rafRef.current || stoppedRef.current) return;
    rafRef.current = requestAnimationFrame(() => void tick());
  }, [tick]);

  /* ---------------- 镜头切换：排队串行，一次只开一颗 ---------------- */

  /** 从 from 起沿候选序列逐颗试，第一颗能出画面的定下来；黑屏/前置的记进坏镜头表。 */
  const walkFrom = useCallback(async (from: number): Promise<boolean> => {
    const list = lensesRef.current;
    if (!list.length) return false;
    const budget = { left: BUSY_WAITS.length };
    for (let n = 0; n < list.length; n += 1) {
      if (stoppedRef.current) return false;
      const idx = (from + n) % list.length;
      const lens = list[idx];
      candPosRef.current = idx;
      lensHintRef.current = false;
      setLensHint(false); // 换到新的这颗，重新给一次「不设防」的起点


      captureFreeze();
      const failure = await openLens(lens.deviceId, budget);
      if (failure) {
        // 失败时**不**放掉冻结帧：让用户继续看着上一颗的画面，而不是黑屏 + 一行字
        if (failure === 'perm') { setState('noperm'); return true; }     // 权限问题换镜头没用
        if (failure === 'nocam') { setState('nosupport'); return true; }
        if (budget.left <= 0 || n + 1 >= list.length) { setState('unavail'); return true; }
        continue;
      }
      const live = await waitFirstFrame(PROBE_FRAME_MS);
      if (!live || facingOf() === 'user') {
        dlog(`镜头 #${idx} ${live ? '是前置' : '黑屏/无画面'}，顺延`, lens.label || lens.deviceId);
        rememberBadLens(lens.deviceId);
        continue;
      }
      releaseFreeze();
      dlog(`锁定镜头 #${idx}`, lens.label || lens.deviceId, facingOf());
      setState('scanning');
      return true;
    }
    setState('unavail');
    return true;
  }, [captureFreeze, openLens, releaseFreeze, waitFirstFrame]);


  /** 请求换到某颗：没落定前后来的请求覆盖目标（最后一次点击说了算），不并发开流 */
  const requestSwitch = useCallback((idx: number) => {
    if (stoppedRef.current || !lensesRef.current.length) return;
    reqRef.current = idx;
    if (walkingRef.current) return;
    walkingRef.current = true;
    setSwitching(true);
    void (async () => {
      try {
        while (!stoppedRef.current && reqRef.current != null) {
          const want = reqRef.current;
          reqRef.current = null;
          if (!await walkFrom(want)) break;
        }
      } finally {
        walkingRef.current = false;
        setSwitching(false);
      }
    })();
  }, [walkFrom]);

  /** 手动「重试打开相机」：走同一条串行队列，避免并发起两趟开流 */
  const retryOpen = useCallback(() => {
    setState('starting');
    requestSwitch(candPosRef.current);
  }, [requestSwitch]);


  /* ---------------- 开机：有记号就一枪；没有就逐颗探，落在传感器最大的那颗 ---------------- */

  useEffect(() => {
    let cancelled = false;
    /** 这颗镜头**实际给得出**多大：按 12MP 要流后读 getSettings() 的交付尺寸。
        不用 getCapabilities().width.max——华为上它报流配置上限，六颗一个值，分不开（真机踩过）。
        caps 仍记进日志，留作下一轮的对照事实。 */
    const deliveredScore = () => {
      const st = (trackRef.current?.getSettings?.() ?? {}) as MediaTrackSettings;
      const caps = (trackRef.current?.getCapabilities?.() ?? {}) as MediaTrackCapabilities;
      dlog('交付尺寸', {
        交付: `${st.width}×${st.height}`, capsMax: caps.width?.max && caps.height?.max ? `${caps.width.max}×${caps.height.max}` : null,
      });
      return (st.width ?? 0) * (st.height ?? 0);
    };
    async function boot() {
      if (!navigator.mediaDevices?.getUserMedia) { dlog('无 mediaDevices（非安全上下文？）'); setState('nosupport'); return; }
      const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
      if (Ctor) { try { detRef.current = new Ctor({ formats: ['qr_code'] }); } catch { detRef.current = null; } }
      if (!detRef.current) {
        // jsQR 与开流并行预载，不排在相机启动后面
        void import('jsqr').then((m) => { jsqrRef.current = m.default; dlog('BarcodeDetector 缺失，用 jsQR'); })
          .catch((e) => dlog('jsQR 加载失败', String(e)));
      }
      startDecode();
      let devs: Lens[] = [];
      try {
        devs = (await navigator.mediaDevices.enumerateDevices())
          .filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label }));
        dlog('可用地像头', devs.map((c, i) => `${i}:${c.label || '(无名)'}`).join(' | '));
      } catch (e) { dlog('enumerateDevices 失败', String(e)); }
      const bad = readBadLenses();
      const cam = store.get(CAM_KEY);
      const saved = bad.includes(cam) ? '' : cam;
      const cands = orderLenses(devs, saved, bad);
      lensesRef.current = cands;
      setLenses(cands);
      dlog('候选序列', cands.map((c, i) => `${i}:${c.label || c.deviceId.slice(0, 6)}${c.deviceId === saved ? '(记号)' : ''}`).join(' | '));

      // 1) 有「扫成功确认过」的记号：一枪定稿，不再探测——这是「秒开」的常态路径。
      //    只有开机写下的记号不作数（可能是失败探测写下的长焦），落到下面的探测流按交付尺寸重判。
      if (saved && store.get(CAM_OK_KEY) === saved) {
        const f = await openLens(saved);
        if (cancelled) return;
        if (!f && await waitFirstFrame(FIRST_FRAME_MS) && facingOf() !== 'user') {
          candPosRef.current = Math.max(0, cands.findIndex((c) => c.deviceId === saved));
          setState('scanning');
          dlog('记号镜头直接锁定', trackRef.current?.label);
          return;
        }
        dlog('记号镜头这次不行，转入探测', f ?? '无画面/前置');
        rememberBadLens(saved);
      } else if (saved) {
        dlog('记号未被扫成功确认过，按交付尺寸重判', saved.slice(0, 8));
      }
      // 1.5) 机型档案：实测过的机型直接点名主摄，一次 720p 开流定稿，省掉整轮探测。
      //      能走到这里说明「扫成功确认过的记号」快路径没命中（它在上面就 return 了）。
      const budget = { left: BUSY_WAITS.length };
      {
        const model = (window as unknown as { HeidBridge?: { deviceModel?: () => string } }).HeidBridge?.deviceModel?.() ?? '';
        const wanted = MAIN_BY_MODEL[model];
        if (wanted?.length) {
          const idx = cands.findIndex((c) => wanted.includes(c.label));
          if (idx >= 0) {
            const f = await openLens(cands[idx].deviceId, budget);
            if (cancelled) return;
            if (!f && await waitFirstFrame(FIRST_FRAME_MS) && facingOf() !== 'user') {
              candPosRef.current = idx;
              setState('scanning');
              store.set(CAM_KEY, cands[idx].deviceId);
              dlog('机型档案命中', model, cands[idx].label);
              return;
            }
            dlog('机型档案镜头不可用，退回探测', model, cands[idx].label, f ?? '无画面/前置');
          }
        }
      }
      // 2) 无记号（或记号/档案都没兜住）：先按 8K 开第一颗并立刻给用户看，同时量它的传感器有多大；
      //    给得出主摄级就收工（常见情况，首次也是一枪）。给不出才探：探针同样按 8K 要流、
      //    只读交付尺寸与朝向、**不等画面**（等首帧只对该真正显示的那颗有意义），探到第一颗主摄级就停。
      const n = Math.min(cands.length, MAX_PROBE);
      /** 便宜探针：按 12MP 开流→读交付尺寸/朝向→立刻关。不等首帧、不挂预览、不做对焦。 */
      const scoreLens = async (id: string) => {
        if (streamRef.current) { stopStream(); await sleepMs(RELEASE_MS); }
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: lensConstraints(id, RES_PROBE) });
        } catch (e) { dlog('探针开流失败', id.slice(0, 6), String(e)); return null; }
        const track = stream.getVideoTracks()[0];
        const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings;
        const score = (st.width ?? 0) * (st.height ?? 0);
        dlog(`探针交付 ${id.slice(0, 6)}`, `${st.width}×${st.height}`, st.facingMode);
        stream.getTracks().forEach((t) => t.stop());
        return { score, facing: st.facingMode };
      };
      let shown = -1;
      let best = -1;
      let bestScore = -1;
      let probesRan = false;
      for (let i = 0; i < n && shown < 0; i += 1) {
        if (cancelled) return;
        const f = await openLens(cands[i].deviceId, budget, RES_PROBE);
        if (f === 'perm') { setState('noperm'); return; }
        if (f === 'nocam') { setState('nosupport'); return; }
        if (f) { if (budget.left <= 0) { setState('unavail'); return; } continue; }
        const live = await waitFirstFrame(PROBE_FRAME_MS);
        if (!live || facingOf() === 'user') {
          dlog(`首颗候选 #${i} ${live ? '是前置' : '无画面'}，顺延`, cands[i].label);
          rememberBadLens(cands[i].deviceId);
          continue;
        }
        shown = i;
        bestScore = deliveredScore();
        best = bestScore >= MAIN_FLOOR ? i : -1; // 首颗就主摄级 → 一颗都不探
        candPosRef.current = i;
        dlog(`首颗出画面 #${i}`, { label: cands[i].label, 交付分: bestScore });
      }
      if (cancelled) return;
      if (shown < 0) { setState('unavail'); return; }
      if (best < 0) {
        // 探测期间**不给看画面**：定格画面比黑屏更像卡死（真机反馈）。黑屏 + 转圈 + 「正在选镜头 i/n」，
        // 选好了再一次性点亮，所以这里也不需要冻结帧。
        for (let i = shown + 1; i < n; i += 1) {
          if (cancelled) return;
          probesRan = true;
          setProbeStep({ i: i + 1, n });
          const s = await scoreLens(cands[i].deviceId);
          if (!s || s.facing === 'user') { rememberBadLens(cands[i].deviceId); continue; }
          if (s.score > bestScore) { bestScore = s.score; best = i; }
          if (s.score >= MAIN_FLOOR) break; // 找到主摄级就停，别把六颗全开一遍
        }
      }
      // 3) 结算：探过就必须重开赢家（探针把画面关了），预览按 720p；
      //    没探过则首颗就是赢家，把同一条 track 从 8K 降回 720p，不重开相机
      if (probesRan) {
        const target = best >= 0 ? best : shown;
        if (target !== shown) dlog(`结算 #${shown} → #${target}（交付分 ${bestScore}）`);
        const f = await openLens(cands[target].deviceId, budget);
        const ok = !f && await waitFirstFrame(PROBE_FRAME_MS);
        if (ok) {
          candPosRef.current = target;
        } else {
          rememberBadLens(cands[target].deviceId);
          candPosRef.current = shown;
          await openLens(cands[shown].deviceId, budget); // 退回给量过的那颗，别留在没开着的镜头上
        }
      } else {
        candPosRef.current = shown;
        const tr = trackRef.current;
        if (tr) {
          void tr.applyConstraints({ width: { ideal: RES.width }, height: { ideal: RES.height } })
            .then(() => { dlog('预览降回 720p'); setDbgFromTrack(); })
            .catch((e: unknown) => dlog('预览降分辨率失败，保持交付尺寸', String(e)));
        }
      }
      setProbeStep(null);
      setState('scanning');
      const win = cands[candPosRef.current];
      if (win) { store.set(CAM_KEY, win.deviceId); dlog('锁定并记住', win.label); }

    }
    void boot();
    return teardown;
  }, [openLens, setDbgFromTrack, startDecode, stopStream, teardown, waitFirstFrame]);

  /* ---------------- 手势 ---------------- */

  const twoDist = () => {
    const [a, b] = [...ptrsRef.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onPtrDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('button,input')) return; // 别抢控件的交互
    // 自动播放被内核拦下时，用户手势里补一次 play() 是唯一能救回来的时机
    if (playBlocked && ptrsRef.current.size === 0) {
      const v = videoRef.current;
      if (v) v.play().then(() => { setPlayBlocked(false); dlog('手势内 play() 成功'); })
        .catch((err: unknown) => dlog('手势内 play() 仍被拒', String(err)));
    }
    ptrsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrsRef.current.size === 2) {
      pinchBaseRef.current = twoDist() || 1;
      zoomBaseRef.current = zoomRef.current.target; // 以「正在去的那倍」为起点，中途再捏不打断动画
      keepHud();
    }
  };
  const onPtrMove = (e: React.PointerEvent) => {
    const p = ptrsRef.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrsRef.current.size < 2) return;
    const z = zoomRef.current;
    // 捏合只管变焦，到头就停。**不**再「拉到最小还想更广 → 换下一颗镜头」：
    // 手机动辄报出 6 颗后置，扫码只该有一颗在干活，拿捏合去串镜头既不是扫码该有的动作，
    // 每次切换还要重开一次流（真机反馈就是那一下卡顿）。
    const ratio = twoDist() / (pinchBaseRef.current || 1);
    wantZoom(pinchZoom(ratio, zoomBaseRef.current, z.min, z.max));
  };
  const onPtrUp = (e: React.PointerEvent) => {
    ptrsRef.current.delete(e.pointerId);
    if (ptrsRef.current.size < 2) keepHud();
  };

  const activeStop = range ? range.stops.reduce(
    (best, s, i) => (Math.abs(s - hudVal) < Math.abs(range.stops[best] - hudVal) ? i : best), 0) : 0;


  // 必须 portal 到 body：设置面板带 backdrop-blur，会成了 fixed 的包含块，
  // 那样扫码预览就被关在弹窗那一格里（平板上尤其明显），而不是盖满屏幕。
  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-[150] flex flex-col overflow-hidden bg-black"
      style={{ touchAction: 'none' }}
      onPointerDown={onPtrDown}
      onPointerMove={onPtrMove}
      onPointerUp={onPtrUp}
      onPointerCancel={onPtrUp}
    >
      {/* 选定之前不给看画面：探测期间的预览（或它的定格）会让人以为卡死了 */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className={cn(
          'absolute inset-0 h-full w-full origin-center object-cover transition-opacity duration-200',
          state === 'scanning' && !probeStep ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/* 切换期间盖住黑屏：内容是上一帧，新流首帧到了再淡出并轻微放大让位 */}
      <canvas
        ref={freezeRef}
        aria-hidden
        className={cn(
          'absolute inset-0 h-full w-full',
          !cold && 'opacity-0 pointer-events-none',
          // 盖上去必须**立刻**（带过渡就会露出底下刚关掉的黑名单），只有让位时才淡出
          cold && !fading && 'opacity-100',
          cold && fading && 'pointer-events-none opacity-0 scale-[1.04] transition-all duration-[260ms] ease-out',
        )}
      />
      {state === 'scanning' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-60 w-60 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-28 bg-gradient-to-b from-black/65 to-transparent" />
      {/* 倍率浮标：捏合时或已离开最广端时显示，点一下回到最广（等价于系统相机的回弹） */}
      {hud && (
        <button
          type="button"
          onClick={() => range && wantZoom(range.min)}
          aria-label={t('link.scanZoomReset')}
          className="absolute left-1/2 top-[calc(50%+8.5rem)] z-10 -translate-x-1/2 rounded-full bg-black/55 px-4 py-2 text-base font-medium tabular-nums text-white"
        >
          {formatZoom(hudVal)}
        </button>
      )}

      <div className="relative z-10 flex items-center justify-between px-3 pb-2 pt-[calc(env(safe-area-inset-top)+3rem)]">
        <span className="flex items-center gap-1.5 text-sm text-white drop-shadow">
          <Camera size={16} />
          {t('link.scanTitle')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('link.scanClose')}
          className={cn('flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white', !IS_TOUCH_PRIMARY && 'h-9 w-9')}
        >
          <X size={20} />
        </button>
      </div>

      <div className="relative z-10 mt-auto space-y-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* 调试行：点一下展开完整日志环缓冲（华为上 logcat 不可靠，截图这份即可） */}
        {dbg && (
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-label={t('link.scanLogToggle')}
            className="mx-auto block max-w-full break-all text-center font-mono text-[10px] text-white/60"
          >
            {dbg}
          </button>
        )}
        {logOpen && (
          <div className="max-h-40 overflow-y-auto rounded-lg bg-black/60 p-2 text-left font-mono text-[10px] leading-4 text-white/70">
            {logLines.map((l, i) => <p key={i} className="break-all whitespace-pre-wrap">{l}</p>)}
          </div>
        )}
        {playBlocked && (
          <p className="text-center text-xs text-rose-300">{t('link.scanPlayBlocked')}</p>
        )}

        {state === 'starting' && (
          <p className="flex items-center justify-center gap-2 text-center text-sm text-white/85">
            <Loader2 size={14} className="animate-spin" />
            {probeStep ? t('link.scanProbing', { i: probeStep.i, n: probeStep.n }) : t('link.scanStarting')}
          </p>
        )}
        {state === 'busy' && (
          <p className="text-center text-sm text-amber-200/90">{t('link.scanBusy')}</p>
        )}
        {state === 'scanning' && (
          <p className={cn('text-center text-sm', notCode ? 'text-amber-300' : 'text-white/85')}>
            {notCode ? t('link.scanNotCode') : t('link.scanHint')}
          </p>
        )}
        {(state === 'noperm' || state === 'nosupport' || state === 'unavail') && (
          <div className="space-y-2 text-center">
            <p className="text-sm text-white">{t(state === 'unavail' ? 'link.scanUnavail' : state === 'noperm' ? 'link.scanDenied' : 'link.scanNoSupport')}</p>
            <p className="text-xs text-white/70">{t(state === 'unavail' ? 'link.scanUnavailHint' : state === 'noperm' ? 'link.scanDeniedHint' : 'link.scanNoSupportHint')}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {state === 'unavail' && (
                <button
                  type="button"
                  onClick={retryOpen}
                  className={cn('inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-white/20 px-4 text-sm text-white', !IS_TOUCH_PRIMARY && 'min-h-[36px]')}
                >
                  <RefreshCw size={14} />{t('link.scanRetry')}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className={cn('inline-flex min-h-[48px] items-center rounded-lg bg-white/15 px-5 text-sm text-white', !IS_TOUCH_PRIMARY && 'min-h-[36px]')}
              >
                {t('link.scanUseManual')}
              </button>
            </div>
          </div>
        )}

        {/* 倍率圆片：捏合是连续通道，圆片是它的非拖拽替代。扫码默认一颗镜头干活，
            不换镜头；只有对着一段时间没解出码，才提一句「可能是这颗不合适」（点了才走）。 */}
        {(state === 'scanning' || state === 'busy' || state === 'starting') && (lensHint || (range && range.stops.length > 1)) && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {lensHint && lenses.length > 1 && (
              <button
                type="button"
                onClick={() => requestSwitch((candPosRef.current + 1) % lenses.length)}
                disabled={switching}
                className={cn(
                  'inline-flex min-h-[48px] items-center gap-1.5 rounded-full bg-black/45 px-3 text-xs text-white/80 disabled:opacity-50',
                  !IS_TOUCH_PRIMARY && 'min-h-[36px]',
                )}
              >
                {switching ? <Loader2 size={15} className="animate-spin" /> : <SwitchCamera size={15} />}
                {t('link.scanSwitch')}
              </button>
            )}
            {range && range.stops.length > 1 && range.stops.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => wantZoom(s)}
                aria-label={formatZoom(s)}
                className={cn(
                  'inline-flex min-h-[48px] items-center justify-center rounded-full px-3 text-sm tabular-nums transition-colors',
                  !IS_TOUCH_PRIMARY && 'min-h-[36px]',
                  i === activeStop ? 'bg-white text-black' : 'bg-black/45 text-white/90',

                )}
              >
                {formatZoom(s)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
