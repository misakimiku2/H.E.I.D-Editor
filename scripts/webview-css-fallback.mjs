/**
 * 老 WebView 的 CSS 兜底（构建期，不进运行时）
 *
 * 华为 Mate 40 Pro 自带 com.huawei.webview，实测 UA 是 **Chrome/99.0.4844.88**
 * （CSS.supports：oklch=false、color-mix=false、100dvh=false、backdrop-filter=true）。
 * 安卓端 minSdk 24，这类老内核在真机上长期存在，而 Tailwind v4 的产物按 chrome 111
 * 生成，下面三类写法在它上面直接失效：
 *
 * 一、oklch()/oklab() 颜色
 *   调色板以 oklch() 字面量输出，且实心色没有 hex 兜底：
 *   `.bg-zinc-800{background-color:var(--color-zinc-800)}`。自定义属性是 token 级的，
 *   替换进 background/border 之后才在计算期非法（IACVT）：背景变透明、border-color 退回
 *   initial（currentColor）——表现为「浅色模式黑色实线、深色模式白色实线、弹层全透明」
 *   （v1.4 手机端反馈）。覆盖面：调色板 83 处 + @tailwindcss/typography 的 --tw-prose-*
 *   54 处 + 任意值 ring 的 oklab 2 处。这里换成等色 hex。
 *
 * 二、filter / backdrop-filter 的 var 链
 *   Tailwind 把各分量合成一条声明，未设置的分量用空兜底 var(--tw-x,)：
 *   `.backdrop-blur-md{--tw-backdrop-blur:blur(12px);backdrop-filter:var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) …}`
 *   Chrome 99 不接受空 token 序列代入 <filter-value-list>：实测同一条链只要多一个
 *   `var(--未设置,)`，计算值就是 none；写成 `var(--tw-backdrop-blur)` 单项则是 blur(12px)。
 *   所以毛玻璃整条失效，而同一元素上的 background 半透明照常生效——正是「面板透明、
 *   后面的字清清楚楚」那个现象。这里把链改写成只引用本条规则真正赋值的那些变量。
 *   代价：Tailwind 靠这条链支持「一个元素叠多个 filter 工具类」，改写后不再支持；
 *   当前 src 里只用到 backdrop-blur 的 sm/md/xl/2xl 共 40 处、且没有一处与别的
 *   backdrop 或 filter 分量同元素叠加，所以等价。真需要叠加时得改回显式写全。
 *
 * 三、translate / rotate / scale 独立属性
 *   Tailwind v4 的变换工具类写的是 `translate:…`/`rotate:180deg`，这三个属性要 Chrome 104。
 *   Chrome 99 上整条丢弃：居中浮条偏掉半个身位、下拉箭头不翻转。折回 transform: 函数写法。
 *
 * 换算与判定都照实测定，不照规范想当然：
 *   - 颜色取 Chromium 实际画到 sRGB 缓冲的像素（截断），不用 CSS Color 4 的色度收缩映射，
 *     否则手机上的颜色和桌面/平板看到的就不是同一套；
 *   - 不能指望构建链自己做：Tailwind 内置 Lightning CSS 的目标写死 chrome 111，既不降级
 *     oklch，还会把 transform 阶段加的兜底当冗余删掉，所以只能在落盘之后改。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const oklabToLinearSrgb = (L, a, b) => {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

const encode = (v) => {
  /* 线性域直接截断。Chromium 把 oklch 画到 sRGB 缓冲时就是截断（canvas 取回
     red-600=#e7000b、blue-500=#2b7fff、amber-500=#fe9a00），而规范定义的色度收缩映射
     会得到 #e40016/#3280ff/#f69e00——那是另一种颜色 */
  v = Math.min(1, Math.max(0, v));
  v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
};

/** 缺省分量和 'none' 都按 0 */
const num = (token) => {
  const n = parseFloat(token);
  return Number.isFinite(n) ? n : 0;
};

/** L 与 alpha：百分号折算成 0~1，无百分号按已是 0~1 读 */
const frac = (token) => {
  const s = String(token);
  return s.endsWith('%') ? num(s) / 100 : num(s);
};

const cache = new Map();

/**
 * `oklch(62.3% .214 259.815)` / `oklab(21% -.003 -.034/.1)` -> `#rrggbb[aa]`
 * kind 决定前三个分量的读法：oklch 是 (L C H)，oklab 是 (L a b)。
 */
export function okColorToHex(kind, inner) {
  const key = kind + '(' + inner + ')';
  const hit = cache.get(key);
  if (hit) return hit;
  const [body, alphaPart] = inner.split('/');
  const t = body.trim().split(/[\s,]+/);
  const L = frac(t[0]);
  let a, b;
  if (kind === 'oklab') {
    a = num(t[1]);
    b = num(t[2]);
  } else {
    const C = num(t[1]);
    const H = (num(t[2]) * Math.PI) / 180;
    a = C * Math.cos(H);
    b = C * Math.sin(H);
  }
  const rgb = oklabToLinearSrgb(L, a, b).map(encode);
  let out = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  if (alphaPart !== undefined) {
    const alpha = alphaPart.trim() === 'none' ? 1 : frac(alphaPart.trim());
    if (Number.isFinite(alpha) && alpha < 1) {
      out += Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
    }
  }
  cache.set(key, out);
  return out;
}

export const oklchToHex = (inner) => okColorToHex('oklch', inner);

const downlevelOkColors = (css) =>
  css.replace(/\b(oklch|oklab)\(([^)]*)\)/g, (_, kind, inner) => okColorToHex(kind, inner));

/* 一条链 = 全是 var(--tw-x,) 空兜底项，中间以空格分隔（Tailwind 生成的形状）。
   只列白名单属性：链外还有别的分量时（如 box-shadow 的 ring 组合）不适用本改写，
   而且「收成一项」会丢掉同元素上别的工具类贡献的分量——Tailwind 在支持空代入的内核上
   是靠整条链做叠加的。白名单里的属性都确认过 src 用法：filter/backdrop-filter 只用到
   backdrop-blur 一档、font-variant-numeric 只有 tabular-nums 一处来源，不存在叠加。 */
const CHAIN = /((?:[-a-z]*filter|font-variant-numeric)):((?:\s*var\(--tw-[a-z-]+,\))+)([;}])/g;
const CHAIN_ITEM = /var\((--tw-[a-z-]+),\)/g;
const ASSIGN = /(--tw-[a-z-]+)\s*:/g;

/**
 * 把白名单属性（filter / backdrop-filter / font-variant-numeric）的 var 链
 * 收成只含本条规则已赋值的那几项
 */
function shrinkFilterChains(css) {
  return css.replace(/\{[^{}]*\}/g, (block) => {
    const assigned = new Set([...block.matchAll(ASSIGN)].map((m) => m[1]));
    return block.replace(CHAIN, (decl, prop, value, end) => {
      const kept = [...value.matchAll(CHAIN_ITEM)].map((m) => m[1]).filter((n) => assigned.has(n));
      return kept.length ? prop + ':' + kept.map((n) => `var(${n})`).join(' ') + end : decl;
    });
  });
}

/* Chrome 104 才有独立的 translate/rotate/scale 属性，而 Tailwind v4 的变换工具类用的
   就是它们：实测 Chrome 99 上 `translate:var(--tw-translate-x) var(--tw-translate-y)`
   计算出的 transform 是 none——居中浮条偏掉半个身位、下拉箭头不翻转。折回 transform:
   函数写法（translate 的分量补 0 兜底，不依赖 @property 的 initial-value）。
   代价与 filter 链同源：同一元素同时用 translate 和 rotate 时只会留下合并后的那一条，
   当前 src 里没有这种组合；规则里已有 transform: 时整块不动，免得改出别的语义。 */
const TRIPLE = /^\s*(translate|rotate|scale)\s*:\s*(.+)$/;
const addZeroFallback = (arg) =>
  /^var\(--tw-[a-z-]+\)$/.test(arg) ? arg.slice(0, -1) + ',0)' : arg;

function mergeTransformProps(css) {
  return css.replace(/\{[^{}]*\}/g, (block) => {
    if (/(?:^|[;{])transform:/.test(block)) return block;
    const found = {};
    const kept = [];
    for (const decl of block.slice(1, -1).split(';')) {
      const m = decl.match(TRIPLE);
      if (!m) { if (decl.trim() !== '') kept.push(decl); continue; }
      if (!(m[1] in found)) found[m[1]] = m[2].trim();
    }
    const fn = [];
    if (found.translate) {
      fn.push('translate(' + found.translate.split(/\s+/).map(addZeroFallback).join(',') + ')');
    }
    if (found.rotate) fn.push('rotate(' + found.rotate + ')');
    if (found.scale) fn.push('scale(' + found.scale.split(/\s+/).join(',') + ')');
    if (!fn.length) return block;
    return '{' + [...kept, 'transform:' + fn.join(' ')].join(';') + '}';
  });
}

export function downlevelForOldWebviews(css) {
  return mergeTransformProps(shrinkFilterChains(downlevelOkColors(css)));
}

async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await cssFiles(p));
    else if (entry.name.endsWith('.css')) out.push(p);
  }
  return out;
}

export default function webviewCssFallback() {
  let outDir = null;
  return {
    name: 'heid-webview-css-fallback',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      for (const file of await cssFiles(outDir)) {
        const css = await readFile(file, 'utf8');
        const next = downlevelForOldWebviews(css);
        if (next !== css) await writeFile(file, next);
      }
    },
  };
}
