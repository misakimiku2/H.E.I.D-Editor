import { describe, expect, it } from 'vitest';
import { okColorToHex, oklchToHex, downlevelForOldWebviews } from './webview-css-fallback.mjs';

/* 期望值全部是实测的，不是照实现倒推的：
   - 中性色取自项目里独立存在的 hex（index.html 首帧内联底色 zinc-900/#18181b、
     zinc-50/#fafafa），也是 Tailwind v3 的同名色；
   - 饱和色取自 Chromium 画到 sRGB 缓冲后 canvas getImageData 取回的像素，
     即桌面/平板实际看到的样子（Chromium 是截断，不是 CSS Color 4 的色度收缩映射）。
   兜底 hex 必须和这些一致，否则手机上的主题就和桌面/平板不是同一套 */
const CHROME_RENDERS = {
  'oklch(55.5% 0 0)': '#737373',                 // zinc-500
  'oklch(21% .006 285.885)': '#18181b',          // zinc-900
  'oklch(98.5% 0 none)': '#fafafa',              // zinc-50，none 色相
  'oklch(62.3% .214 259.815)': '#2b7fff',        // blue-500，色域外
  'oklch(57.7% .245 27.325)': '#e7000b',         // red-600，色域外
  'oklch(76.9% .188 70.08)': '#fe9a00',          // amber-500，色域外
  'oklch(69.6% .17 162.48)': '#00bc7d',          // emerald-500，色域外
  'oklch(54.1% .281 293.009)': '#7f22fe',        // violet-600，色域外
  'oklab(78.327% .00858221 -.109691)': '#a3b3ff', // 任意值 ring-[#A3B3FF]，源就是 hex
};

describe('oklch / oklab -> hex', () => {
  it.each(Object.entries(CHROME_RENDERS))('%s 与 Chromium 实际渲染一致', (src, want) => {
    const kind = src.startsWith('oklab') ? 'oklab' : 'oklch';
    expect(downlevelForOldWebviews('.x{color:' + src + '}')).toBe('.x{color:' + want + '}');
    expect(okColorToHex(kind, src.slice(src.indexOf('(') + 1, -1))).toBe(want);
  });

  it('oklab 与同色的 oklch 写法走到同一个值（极坐标 vs 直角坐标）', () => {
    // zinc-900 = oklch(21% .006 285.885) = oklab(21% .00165 -.00579)
    expect(okColorToHex('oklab', '21% .00165 -.00579')).toBe(oklchToHex('21% .006 285.885'));
  });

  it('带 alpha 时输出 8 位 hex，百分号与裸数等价', () => {
    expect(oklchToHex('21% .006 285.885 / 0.5')).toBe('#18181b80');
    expect(oklchToHex('21% .006 285.885 / 40%')).toBe('#18181b66');
    expect(okColorToHex('oklab', '21% .00165 -.00579/.1')).toBe('#18181b1a');
  });

  it('color-mix 的插值空间名 oklab 不被误伤', () => {
    const css = '.x{background-color:color-mix(in oklab,var(--color-red-500) 40%,transparent)}';
    expect(downlevelForOldWebviews(css)).toBe(css);
  });
});

/* 下面这条是 Mate 40 Pro（Chrome 99）上毛玻璃失效的根因：空 var 兜底代入
   <filter-value-list> 会让整条声明计算成 none。实测对照见本次排查记录。 */
describe('filter / backdrop-filter 的 var 链收缩', () => {
  const chain = 'var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-sepia,)';

  it('只保留本条规则真正赋值的分量', () => {
    const src = '.backdrop-blur-md{--tw-backdrop-blur:blur(var(--blur-md));'
      + '-webkit-backdrop-filter:' + chain + ';'
      + 'backdrop-filter:' + chain + '}';
    expect(downlevelForOldWebviews(src)).toBe(
      '.backdrop-blur-md{--tw-backdrop-blur:blur(var(--blur-md));'
      + '-webkit-backdrop-filter:var(--tw-backdrop-blur);'
      + 'backdrop-filter:var(--tw-backdrop-blur)}'
    );
  });

  it('一条规则赋值多个分量时全部保留，顺序不变', () => {
    const src = '.x{--tw-blur:blur(4px);--tw-invert:invert(1);'
      + 'filter:var(--tw-blur,) var(--tw-brightness,) var(--tw-invert,)}';
    expect(downlevelForOldWebviews(src)).toBe('.x{--tw-blur:blur(4px);--tw-invert:invert(1);'
      + 'filter:var(--tw-blur) var(--tw-invert)}');
  });

  it('本条规则没赋值任何分量时不动它（宁可保留原样也不臆造）', () => {
    const src = '.x{filter:var(--tw-blur,) var(--tw-brightness,)}';
    expect(downlevelForOldWebviews(src)).toBe(src);
  });

  it('font-variant-numeric 同理（实测 Chrome 99 上 tabular-nums 算成 normal）', () => {
    const src = '.tabular-nums{--tw-numeric-spacing:tabular-nums;'
      + 'font-variant-numeric:var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,)'
      + ' var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)}';
    expect(downlevelForOldWebviews(src))
      .toBe('.tabular-nums{--tw-numeric-spacing:tabular-nums;'
        + 'font-variant-numeric:var(--tw-numeric-spacing)}');
  });

  it('box-shadow 的 ring 组合不在白名单里，不动它（链里还夹着非 var 分量）', () => {
    const src = '.ring-2{--tw-ring-shadow:var(--tw-ring-inset,) 0 0 0 2px;'
      + 'box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000)}';
    expect(downlevelForOldWebviews(src)).toBe(src);
  });

  it('@property 注册块与嵌套 at-rule 不受影响', () => {
    const prop = '@property --tw-backdrop-blur{syntax:"*";inherits:false}';
    expect(downlevelForOldWebviews(prop)).toBe(prop);
    const nested = '@media (min-width:1px){.x{--tw-backdrop-blur:blur(2px);'
      + 'backdrop-filter:var(--tw-backdrop-blur,) var(--tw-backdrop-sepia,)}}';
    expect(downlevelForOldWebviews(nested)).toBe(
      '@media (min-width:1px){.x{--tw-backdrop-blur:blur(2px);backdrop-filter:var(--tw-backdrop-blur)}}'
    );
  });
});

/* Chrome 104 才有独立的 translate/rotate/scale；Chrome 99（Mate 40 Pro 实测）上整条丢弃，
   表现为居中浮条偏半个身位、下拉箭头不翻转。以下输入形状取自真实产物
   （.-translate-x-1\/2 与 .rotate-180）。 */
describe('translate / rotate / scale 折回 transform', () => {
  it('translate 的 var 分量补 0 兜底', () => {
    const src = '.-translate-x-1\\/2{--tw-translate-x:-50%;'
      + 'translate:var(--tw-translate-x) var(--tw-translate-y)}';
    expect(downlevelForOldWebviews(src)).toBe('.-translate-x-1\\/2{--tw-translate-x:-50%;'
      + 'transform:translate(var(--tw-translate-x,0),var(--tw-translate-y,0))}');
  });

  it('rotate 字面量折成 transform，块里不留空声明', () => {
    expect(downlevelForOldWebviews('.rotate-180{rotate:180deg}'))
      .toBe('.rotate-180{transform:rotate(180deg)}');
  });

  it('同一条规则里 translate 与 rotate 合并，顺序按规范 translate→rotate→scale', () => {
    expect(downlevelForOldWebviews('.x{translate:1px 2px;rotate:90deg;scale:2}'))
      .toBe('.x{transform:translate(1px,2px) rotate(90deg) scale(2)}');
  });

  it('规则本来就有 transform: 时不动它', () => {
    const src = '.x{transform:translateY(4px);rotate:90deg}';
    expect(downlevelForOldWebviews(src)).toBe(src);
  });

  it('与 filter 链同一条规则时两处都改', () => {
    const src = '.x{rotate:180deg;--tw-backdrop-blur:blur(4px);'
      + 'backdrop-filter:var(--tw-backdrop-blur,) var(--tw-backdrop-sepia,)}';
    expect(downlevelForOldWebviews(src)).toBe('.x{--tw-backdrop-blur:blur(4px);'
      + 'backdrop-filter:var(--tw-backdrop-blur);transform:rotate(180deg)}');
  });
});
