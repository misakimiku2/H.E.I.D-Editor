// @vitest-environment jsdom
/**
 * 扫码器的开流账：这两条都是真机上量出来过、又极容易被「加回一次探测」悄悄退化的行为。
 *  - 有记住的镜头时，进入扫一扫只发起**一次** getUserMedia（旧实现是先开一颗拿权限、再重开一次）；
 *  - 相机被占用（NotReadableError）走退避重试并显示占用文案，不再谎报「权限被拒」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({ useT: () => (key: string) => key }));

import QrScanner from './QrScanner';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GOOD = { deviceId: 'lens-main', label: 'camera2 1, facing back' };

interface GumCall { constraints: MediaStreamConstraints }

let root: Root | null = null;
let container: HTMLElement;
let gumCalls: GumCall[] = [];
let gumImpl: (c: MediaStreamConstraints) => Promise<MediaStream>;

/** 最小可用的假镜头：settings 报后置 + 有画面，capabilities 给一段光学变焦 */
function fakeStream(getSettings: Record<string, unknown>, caps: Record<string, unknown> = {}) {
  const applyConstraints = vi.fn(async () => undefined);
  const track = {
    kind: 'video', label: GOOD.label, readyState: 'live', stop: vi.fn(),
    getSettings: () => getSettings, getCapabilities: () => caps, applyConstraints,
  };
  const stream = {
    getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [],
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaStream;
  return { stream, track };
}

function stubMediaDevices() {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: (c: MediaStreamConstraints) => {
        gumCalls.push({ constraints: c });
        return gumImpl(c);
      },
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'lens-front', label: 'camera2 0, facing front' },
        { kind: 'videoinput', deviceId: GOOD.deviceId, label: GOOD.label },
      ],
    },
  });
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  gumCalls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.clear();
  // jsdom 的 media / canvas 元素都是空壳：喂一个「已经出画面」的视频，并让 play() 可 await
  for (const proto of [window.HTMLVideoElement.prototype, window.HTMLMediaElement.prototype]) {
    Object.defineProperty(proto, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(proto, 'videoHeight', { configurable: true, value: 720 });
  }
  window.HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as never;
  stubMediaDevices();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
  vi.useRealTimers();
});

function mount() {
  root = createRoot(container);
  act(() => {
    root?.render(<QrScanner onResult={() => undefined} onClose={() => undefined} dark />);
  });
}

describe('QrScanner 开流', () => {
  it('扫成功确认过的记号：一枪定稿，不再探测', async () => {
    localStorage.setItem('heid-scan-cam', GOOD.deviceId);
    localStorage.setItem('heid-scan-cam-ok', GOOD.deviceId);
    const { stream } = fakeStream({ deviceId: GOOD.deviceId, facingMode: 'environment', width: 1280, height: 720 });
    gumImpl = async () => stream;

    mount();
    // 推过「关旧流→开新流」的 150ms 释放窗口：真要重开第二枪，这里就会露出来
    await flush(600);

    expect(gumCalls).toHaveLength(1);
    expect(gumCalls[0].constraints.video).toMatchObject({ deviceId: { exact: GOOD.deviceId } });
    // 当前这颗就是候选第一名 → 不该有第二次开流
    expect(document.body.textContent).toContain('link.scanHint');
  });

  it('只有开机写下、没被扫成功确认的记号：不作数，按交付尺寸重判', async () => {
    // 上一次失败探测把长焦写进了记号；这一轮必须自己纠偏到主摄，而不是永久一枪直达长焦
    gumImpl = halGum({ cam6: { maxW: 3264, maxH: 2448 }, cam2: { maxW: 8192, maxH: 6144 } });
    setDevs([
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
      { deviceId: 'cam2', label: 'camera2 2, facing back' },
    ]);
    localStorage.setItem('heid-scan-cam', 'cam6'); // 故意不给 -ok
    mount();
    await flush(900);
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam2');
  });

  /** 模拟 HAL：按请求的 ideal 交付，但不超过这颗镜头的上限（真机行为：8MP 长焦给不出 12MP） */
  function halGum(lenses: Record<string, { maxW: number; maxH: number }>) {
    return async (c: MediaStreamConstraints) => {
      const v = c.video as { deviceId?: { exact?: string }; width?: { ideal?: number }; height?: { ideal?: number } };
      const id = v?.deviceId?.exact ?? Object.keys(lenses)[0];
      const L = lenses[id];
      const w = Math.min(v?.width?.ideal ?? 1280, L.maxW);
      const h = Math.min(v?.height?.ideal ?? 720, L.maxH);
      return fakeStream(
        { deviceId: id, facingMode: 'environment', width: w, height: h },
        { width: { min: 320, max: L.maxW }, height: { min: 240, max: L.maxH } },
      ).stream;
    };
  }
  const setDevs = (devs: { deviceId: string; label: string }[]) => {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...window.navigator.mediaDevices,
        enumerateDevices: async () => devs.map((d) => ({ kind: 'videoinput', ...d })),
      },
    });
  };

  it('无记号且 label 全是通用名：首颗给不出 12MP 才探，探到给得出的那颗（Mate 的长焦坑）', async () => {
    // 华为式 label：两颗都叫 camera2 N, facing back，排序分不出主次；
    // 且 getCapabilities().width.max 在这类机器上分不开，只能按「要 12MP 看给多少」量
    gumImpl = halGum({ cam6: { maxW: 3264, maxH: 2448 }, cam2: { maxW: 8192, maxH: 6144 } });
    setDevs([
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
      { deviceId: 'cam2', label: 'camera2 2, facing back' },
    ]);

    mount();
    await flush(900);

    const opened = gumCalls.map((c) => (c.constraints.video as { deviceId?: { exact?: string } }).deviceId?.exact);
    // 首颗按 12MP 开（量尺寸）→ 探针按 12MP 量主摄 → 结算按 720p 重开主摄
    expect(opened).toEqual(['cam6', 'cam2', 'cam2']);
    expect((gumCalls[0].constraints.video as { width?: { ideal?: number } }).width?.ideal).toBe(8192);
    expect((gumCalls[2].constraints.video as { width?: { ideal?: number } }).width?.ideal).toBe(1280);
    // 并且把主摄记下来了：下次进来一枪直达，不再探
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam2');
  });

  it('首颗就给得出 50MP：一颗都不探，首次也是一枪', async () => {
    gumImpl = halGum({ cam2: { maxW: 8192, maxH: 6144 }, cam6: { maxW: 4096, maxH: 3072 } });
    setDevs([
      { deviceId: 'cam2', label: 'camera2 2, facing back' },
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
      { deviceId: 'cam7', label: 'camera2 7, facing back' },
    ]);
    mount();
    await flush(900);
    expect(gumCalls).toHaveLength(1);
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam2');
  });

  it('首颗 13MP（够不到 16MP 下限的老机器）：探完取交付最大的，不瞎换', async () => {
    gumImpl = halGum({ cam2: { maxW: 4160, maxH: 3120 }, cam6: { maxW: 3264, maxH: 2448 } });
    setDevs([
      { deviceId: 'cam2', label: 'camera2 2, facing back' },
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
    ]);
    mount();
    await flush(900);
    const opened = gumCalls.map((c) => (c.constraints.video as { deviceId?: { exact?: string } }).deviceId?.exact);
    expect(opened).toEqual(['cam2', 'cam6', 'cam2']);
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam2');
  });

  it('全机器都给不出 12MP（老手机小传感器主摄）：不瞎换，就用首颗', async () => {
    gumImpl = halGum({ cam0: { maxW: 3264, maxH: 2448 }, cam1: { maxW: 2592, maxH: 1944 } });
    setDevs([
      { deviceId: 'cam0', label: 'camera2 0, facing back' },
      { deviceId: 'cam1', label: 'camera2 1, facing back' },
    ]);
    mount();
    await flush(900);
    const opened = gumCalls.map((c) => (c.constraints.video as { deviceId?: { exact?: string } }).deviceId?.exact);
    // 探针量过 cam1 但没达标 → 退回并记住首颗，而不是留在一个没开着的镜头上
    expect(opened[0]).toBe('cam0');
    expect(opened[opened.length - 1]).toBe('cam0');
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam0');
  });


  it('相机被占用：退避重试并说「占用」，不是「权限被拒」', async () => {
    gumImpl = async () => { throw new DOMException('in use', 'NotReadableError'); };
    mount();

    await flush(200);
    expect(document.body.textContent).toContain('link.scanBusy');
    expect(document.body.textContent).not.toContain('link.scanDenied');

    // 额度用完后转手动，且给出的按钮是「重试打开」而不是「去系统设置」
    await flush(5000);
    expect(gumCalls.length).toBeGreaterThanOrEqual(2);
    expect(gumCalls.length).toBeLessThanOrEqual(4);
    expect(document.body.textContent).toContain('link.scanUnavail');
    expect(document.body.textContent).toContain('link.scanRetry');
  });

  it('权限被拒才说权限', async () => {
    gumImpl = async () => { throw new DOMException('nope', 'NotAllowedError'); };
    mount();
    await flush(200);
    expect(document.body.textContent).toContain('link.scanDenied');
    expect(gumCalls).toHaveLength(1); // 拒权限不重试
  });

  it('双指捏合：对数映射的目标倍率经平滑后落到数码变焦上', async () => {
    // 这颗镜头不给 zoom 能力 → 走数码放大（预览 transform）
    const { stream } = fakeStream({ deviceId: GOOD.deviceId, facingMode: 'environment', width: 1280, height: 720 });
    gumImpl = async () => stream;
    localStorage.setItem('heid-scan-cam', GOOD.deviceId);
    mount();
    await flush(600);

    const video = document.querySelector('video') as HTMLVideoElement;
    const root = video.parentElement as HTMLElement;
    const fire = (type: string, id: number, x: number, y: number) => {
      const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
      Object.defineProperty(ev, 'pointerId', { value: id });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      root.dispatchEvent(ev);
    };

    act(() => {
      fire('pointerdown', 1, 1250, 900);
      fire('pointerdown', 2, 1550, 900);   // 起始指距 300
      fire('pointermove', 2, 1850, 900);   // 张开到 600 → ratio 2
    });
    await flush(700);                      // 让低通动画收敛

    // 数码量程 1–4：pinchZoom(2, 1, 1, 4) = 2^(ln4/ln3) ≈ 2.4，而不是线性的 2.0
    const m = /scale\(([\d.]+)\)/.exec(video.style.transform);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeCloseTo(2.4, 1);
    // 倍率浮标跟着出现
    expect(document.body.textContent).toContain('2.4×');
  });

  it('探测期间不给看画面：黑屏 + 「正在选镜头 i/n」，选好了才点亮', async () => {
    gumImpl = halGum({ cam6: { maxW: 4096, maxH: 3072 }, cam2: { maxW: 8192, maxH: 6144 } });
    setDevs([
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
      { deviceId: 'cam2', label: 'camera2 2, facing back' },
    ]);
    mount();
    await flush(80);    // 停在探测中途
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.className).toContain('opacity-0');           // 画面盖着，不给看
    expect(document.body.textContent).toContain('link.scanProbing'); // 换成进度说明

    await flush(2000);  // 选完点亮
    expect(video.className).toContain('opacity-100');
    expect(document.body.textContent).toContain('link.scanHint');
  });

  it('机型档案命中：实测过的机型一次 720p 开流定稿，不探测', async () => {
    (window as unknown as { HeidBridge?: unknown }).HeidBridge = { deviceModel: () => 'NOH-AL00' };
    gumImpl = halGum({ cam6: { maxW: 4096, maxH: 3072 }, cam4: { maxW: 8192, maxH: 6144 } });
    setDevs([
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
      { deviceId: 'cam4', label: 'camera2 4, facing back' },
    ]);
    mount();
    await flush(900);
    expect(gumCalls).toHaveLength(1);
    const v = gumCalls[0].constraints.video as { deviceId?: { exact?: string }; width?: { ideal?: number } };
    expect(v.deviceId?.exact).toBe('cam4');
    expect(v.width?.ideal).toBe(1280); // 档案路径不按 8K 量，直接快开
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam4');
    delete (window as unknown as { HeidBridge?: unknown }).HeidBridge;
  });

  it('机型档案镜头开不出画面：退回探测，不卡死', async () => {
    (window as unknown as { HeidBridge?: unknown }).HeidBridge = { deviceModel: () => 'NOH-AL00' };
    // 档案点名的那颗永远开流失败 → 必须落到探测流并选出主摄
    gumImpl = async (c) => {
      const id = (c.video as { deviceId?: { exact?: string } }).deviceId?.exact;
      if (id === 'cam4') throw new DOMException('in use', 'NotReadableError');
      return halGum({ cam6: { maxW: 4096, maxH: 3072 }, cam2: { maxW: 8192, maxH: 6144 } })(c);
    };
    setDevs([
      { deviceId: 'cam6', label: 'camera2 6, facing back' },
      { deviceId: 'cam4', label: 'camera2 4, facing back' },
      { deviceId: 'cam2', label: 'camera2 2, facing back' },
    ]);
    mount();
    await flush(4000);
    expect(localStorage.getItem('heid-scan-cam')).toBe('cam2');
    delete (window as unknown as { HeidBridge?: unknown }).HeidBridge;
  });

  it('捏到最广端继续收拢也不换镜头：扫码只有一颗在干活', async () => {
    const { stream } = fakeStream({ deviceId: GOOD.deviceId, facingMode: 'environment', width: 1280, height: 720 });
    gumImpl = async () => stream;
    localStorage.setItem('heid-scan-cam', GOOD.deviceId);
    localStorage.setItem('heid-scan-cam-ok', GOOD.deviceId);
    // 故意给两颗都能用的后置：只有候选 >1 时，旧的「到最小还想更广 → 换一颗」才会想触发
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...window.navigator.mediaDevices,
        enumerateDevices: async () => [
          { kind: 'videoinput', deviceId: GOOD.deviceId, label: GOOD.label },
          { kind: 'videoinput', deviceId: 'lens-alt', label: 'camera2 4, facing back' },
        ],
      },
    });
    mount();
    await flush(600);
    expect(gumCalls).toHaveLength(1);

    const video = document.querySelector('video') as HTMLVideoElement;
    const root = video.parentElement as HTMLElement;
    const fire = (type: string, id: number, x: number, y: number) => {
      const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
      Object.defineProperty(ev, 'pointerId', { value: id });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      root.dispatchEvent(ev);
    };
    // 已在 1×（数码量程的下限），双指再往中间收 → 旧规则会去开第二颗镜头
    act(() => {
      fire('pointerdown', 1, 1250, 900);
      fire('pointerdown', 2, 1550, 900);
      for (let i = 1; i <= 6; i += 1) fire('pointermove', 2, 1550 - i * 60, 900);
      fire('pointerup', 2, 1190, 900);
    });
    await flush(700);

    expect(gumCalls).toHaveLength(1);                       // 没有第二颗
    expect(Number(/scale\(([\d.]+)\)/.exec(video.style.transform)?.[1] ?? 9)).toBe(1); // 停在 1×
  });
});
