/**
 * 文件类型图标生成器
 * ----------------------------------------------------------------------------
 * 为 H.I.D.E 的 Windows 文件关联生成按格式区分的 .ico 图标。
 *
 * 设计：与应用图标同一家族 —— 保留其「深蓝窗口标题栏 + 红黄绿三圆点」签名元素，
 *       主体背景为各格式专属色的纯色，白色纤细标签居中。
 * 产物：src-tauri/icons/filetypes/<name>.ico（16~128 为 32 位 BMP 条目、256 为 PNG 条目——
 *       Windows 对小尺寸 PNG 条目的透明通道支持不完整，会出现黑角，故小尺寸走 BMP）
 *
 * 依赖：ImageMagick 7（magick 命令）+ Windows 自带 Segoe UI 字体
 * 运行：node scripts/generate-filetype-icons.mjs
 *
 * 注意：extension 清单需与 src-tauri/tauri.conf.json 的 bundle.fileAssociations
 *       以及 src-tauri/nsis/installer-hooks.nsh 中的清单保持一致。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// 类型定义表：name = 图标文件名 / ProgID 后缀，label = 图标文字，
//             color = 主体背景基色（按 hue 生成深色渐变，保证白色文字可读）
// ---------------------------------------------------------------------------
const TYPES = [
  { name: "txt",    label: "TXT",  color: "#AEB9C9", exts: ["txt"] },
  { name: "log",    label: "LOG",  color: "#34D399", exts: ["log"] },
  { name: "md",     label: "MD",   color: "#B79CF8", exts: ["md", "markdown"] },
  { name: "json",   label: "JSON", color: "#F5C542", exts: ["json"] },
  { name: "csv",    label: "CSV",  color: "#2EA043", exts: ["csv"] },
  { name: "yaml",   label: "YML",  color: "#2BC4CE", exts: ["yaml", "yml"] },
  { name: "toml",   label: "TOML", color: "#C97B4A", exts: ["toml"] },
  { name: "ini",    label: "INI",  color: "#8B99AD", exts: ["ini"] },
  { name: "xml",    label: "XML",  color: "#E8912D", exts: ["xml"] },
  { name: "svg",    label: "SVG",  color: "#E25FC4", exts: ["svg"] },
  { name: "ts",     label: "TS",   color: "#3E8EF7", exts: ["ts", "tsx"] },
  { name: "js",     label: "JS",   color: "#F7DF1E", exts: ["js", "jsx"] },
  { name: "py",     label: "PY",   color: "#FFD43B", exts: ["py"] },
  { name: "rs",     label: "RS",   color: "#F26430", exts: ["rs"] },
  { name: "go",     label: "GO",   color: "#00B8D9", exts: ["go"] },
  { name: "java",   label: "JAVA", color: "#EA6A47", exts: ["java"] },
  { name: "c",      label: "C",    color: "#93A9C9", exts: ["c", "h"] },
  { name: "cpp",    label: "C++",  color: "#5590DE", exts: ["cpp", "cc", "cxx", "hpp"] },
  { name: "cs",     label: "CS",   color: "#9D6FE8", exts: ["cs"] },
  { name: "rb",     label: "RB",   color: "#E8465A", exts: ["rb"] },
  { name: "php",    label: "PHP",  color: "#9BA3E8", exts: ["php"] },
  { name: "html",   label: "HTML", color: "#FA7A36", exts: ["html", "htm"] },
  { name: "css",    label: "CSS",  color: "#38BDF8", exts: ["css"] },
  { name: "scss",   label: "SCSS", color: "#FF8AC2", exts: ["scss"] },
  { name: "less",   label: "LESS", color: "#6B9BD8", exts: ["less"] },
  { name: "sh",     label: "SH",   color: "#4ADE80", exts: ["sh", "bash"] },
  { name: "sql",    label: "SQL",  color: "#E9A23B", exts: ["sql"] },
  { name: "swift",  label: "SW",   color: "#FA6E4F", exts: ["swift"] },
  { name: "kt",     label: "KT",   color: "#A56BFF", exts: ["kt", "kts"] },
  { name: "scala",  label: "SL",   color: "#E04545", exts: ["scala"] },
  { name: "vue",    label: "VUE",  color: "#42D392", exts: ["vue"] },
  { name: "svelte", label: "SV",   color: "#FF5C33", exts: ["svelte"] },
];

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const SIZES = [16, 24, 32, 48, 64, 96, 128, 256];
// 96 = Win11「大图标」视图的精确尺寸：缺了它 Windows 会在 64/128 间平局，
// 实际取 64 放大显示导致发糊
const MASTER = 1024;                       // 超采样画布
// 以下元素取自应用图标（512px 源）实测值 ×2
const BAR_H = 152;                         // 标题栏高度（实测 ~76px）
const BAR_COLOR = "#1F2937";               // 标题栏深蓝
const DOT_COLORS = ["#EF4444", "#F59E0B", "#10B981"]; // 红黄绿三圆点
const DOT_R = 20;                          // 圆点半径（实测 ~9px）
const DOT_X0 = 128;                        // 首个圆点圆心 x
const DOT_GAP = 80;                        // 圆点间距
const BODY_L = 0.42;                       // 主体纯色明度（白字可读 + 保持鲜艳）
const EDGE = "rgba(255,255,255,0.09)";     // 内描边高光
const PREVIEW_BG = "#DDE3EA";              // 预览拼图底色（浅色，便于确认圆角透明）
const OUT_DIR = resolve(import.meta.dirname, "../src-tauri/icons/filetypes");

const FONT_CANDIDATES = [
  "C:/Windows/Fonts/segoeuil.ttf",  // Segoe UI Light（最接近苹果 SF Pro 的纤细观感）
  "C:/Windows/Fonts/segoeuisl.ttf", // Segoe UI Semilight
  "C:/Windows/Fonts/segoeui.ttf",   // Segoe UI Regular
  "C:/Windows/Fonts/segoeuib.ttf",  // Segoe UI Bold（兜底）
  "C:/Windows/Fonts/arialbd.ttf",
];

// 文字字号（1024 画布），按字符数适配宽度；整体偏小留白，走苹果式克制风格
const POINT_SIZE = { 1: 520, 2: 430, 3: 320, 4: 256 };
// 16px 缩略预览放大倍率
const PREVIEW_ZOOM = 3;

function pickFont() {
  const font = FONT_CANDIDATES.find((f) => existsSync(f));
  if (!font) throw new Error("未找到可用的 Segoe UI / Arial 粗体字体");
  return font;
}

function run(args) {
  execFileSync("magick", args, { stdio: ["ignore", "pipe", "inherit"] });
}

/** #RRGGBB -> [h(0-360), s(0-1), l(0-1)] */
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** [h,s,l] -> "#RRGGBB" */
function hslToHex([h, s, l]) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 由类型基色生成主体纯色（保色相、压明度，保证白色文字可读） */
function bodyColorOf(t) {
  const [h, s] = hexToHsl(t.color);
  return hslToHex([h, clamp(s, 0.12, 0.82), BODY_L]);
}

/** 渲染单个类型的主图（1024 超采样） */
function renderMaster(t, font, outPng) {
  const ps = POINT_SIZE[t.label.length];
  const kerning = Math.round(-ps * 0.02); // 细字重配宽松字距，接近苹果式排版
  const r = Math.round(MASTER * 0.23); // 圆角半径，贴近 Win11 风格
  const inset = Math.round(MASTER * 0.012);
  const body = bodyColorOf(t);

  // 主体纯色
  const args = [
    "-size", `${MASTER}x${MASTER}`,
    `xc:${body}`,
  ];
  // 窗口标题栏（与应用图标一致）
  args.push(
    "(",
    "-size", `${MASTER}x${MASTER}`, "xc:none",
    "-fill", BAR_COLOR,
    "-draw", `rectangle 0,0 ${MASTER},${BAR_H}`,
    ")",
    "-compose", "Over", "-composite",
  );
  // 红黄绿三圆点（垂直居中于标题栏）
  args.push("(",
    "-size", `${MASTER}x${MASTER}`, "xc:none", "-fill", "none",
  );
  DOT_COLORS.forEach((c, i) => {
    const cx = DOT_X0 + i * DOT_GAP, cy = BAR_H / 2;
    args.push("-fill", c, "-draw", `circle ${cx},${cy} ${cx + DOT_R},${cy}`);
  });
  args.push(")", "-compose", "Over", "-composite");
  // 内描边高光 + 圆角裁切
  // 注意：-fill 在整条命令行持久生效，必须显式 -fill none，
  // 否则圆点图层的颜色会泄漏进来把整个 roundrectangle 填成纯色
  args.push(
    "(",
    "-size", `${MASTER}x${MASTER}`, "xc:none",
    "-fill", "none",
    "-stroke", EDGE, "-strokewidth", String(Math.round(MASTER * 0.006)),
    "-draw", `roundrectangle ${inset},${inset} ${MASTER - inset},${MASTER - inset} ${r},${r}`,
    ")",
    "-compose", "Over", "-composite",
    "(",
    "-size", `${MASTER}x${MASTER}`, "xc:none",
    "-fill", "white",
    "-draw", `roundrectangle ${inset},${inset} ${MASTER - inset},${MASTER - inset} ${r},${r}`,
    ")",
    // 注意：IM7 的 DstIn 会丢失 alpha（被遮掉的区域变成不透明黑色），
    // 必须用 CopyAlpha 把遮罩的 alpha 通道复制到画面上
    "-compose", "CopyAlpha", "-composite",
  );
  // 白色标签（主体区垂直居中）；细字重下不加深色投影，避免小尺寸出现重影
  const textY = Math.round(BAR_H + (MASTER - BAR_H) / 2 - MASTER / 2); // 相对画布中心的偏移
  args.push(
    "-font", font,
    "-pointsize", String(ps),
    "-kerning", String(kerning),
    "-gravity", "center",
    "-fill", "white",
    "-annotate", `+0+${textY}`, t.label,
    "-strip",
    outPng,
  );
  run(args);
}

/** 从主图缩放出各尺寸：小尺寸写原始 RGBA（用于 BMP 条目），256 写 PNG；同时输出 PNG 供预览 */
function renderSizes(masterPng, base, sizes) {
  const args = [masterPng, "-filter", "Lanczos", "-depth", "8"];
  for (const s of sizes) {
    args.push(
      "(", "-clone", "0", "-resize", `${s}x${s}`,
      // 缩放后轻度锐化，弥补 Lanczos 造成的边缘发软（细字重尤其明显）
      "-unsharp", "0x0.7+0.5+0.004",
      "-write", `rgba:${base}-${s}.rgba`,
      "-write", `${base}-${s}.png`, "+delete", ")"
    );
  }
  // 末尾图像列表为空时 IM 会报 unbalanced parenthesis，用 null: 收尾
  args.push("null:");
  run(args);
}

/**
 * 将 8 位 RGBA 原始数据封装为 ICO 的 32 位 BMP 条目。
 * 结构：BITMAPINFOHEADER(40B) + 像素数据(自下而上 BGRA) + AND 掩码(全 0 = 不透明，
 *       透明度由像素 alpha 通道表达)。所有 Windows 渲染路径均正确支持 alpha。
 */
function bmpEntryFromRgba(size, rgba) {
  const xorSize = size * size * 4;
  const andRow = Math.ceil(size / 32) * 4; // 1bpp 行按 4 字节对齐
  const andSize = andRow * size;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);            // biSize
  header.writeInt32LE(size, 4);           // biWidth
  header.writeInt32LE(size * 2, 8);       // biHeight（XOR + AND 两倍高）
  header.writeUInt16LE(1, 12);            // biPlanes
  header.writeUInt16LE(32, 14);           // biBitCount
  header.writeUInt32LE(0, 16);            // biCompression = BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // BMP 自下而上
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];   // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s];   // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const and = Buffer.alloc(andSize);
  return Buffer.concat([header, xor, and]);
}

/**
 * 将各尺寸数据封装为 ICO：
 * 16~128 用 32 位 BMP 条目（兼容性最好，避免小尺寸 PNG 条目的黑角问题），
 * 256 用 PNG 条目（体积小，且 256 PNG 是各渲染路径的官方推荐格式）。
 * 结构：ICONDIR(6B) + ICONDIRENTRY(16B × n) + 各条目原始数据
 */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留位
  header.writeUInt16LE(1, 2); // 类型：图标
  header.writeUInt16LE(count, 4);

  const dirs = [];
  const blobs = [];
  let offset = 6 + 16 * count;
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;       // 宽（256 记为 0）
    e[1] = size >= 256 ? 0 : size;       // 高
    e[2] = 0;                            // 调色板数
    e[3] = 0;                            // 保留位
    e.writeUInt16LE(1, 4);               // 色彩平面
    e.writeUInt16LE(32, 6);              // 位深
    e.writeUInt32LE(buf.length, 8);      // 数据长度
    e.writeUInt32LE(offset, 12);         // 数据偏移
    offset += buf.length;
    dirs.push(e);
    blobs.push(buf);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

/** 生成预览拼图：上排 64px、下排 16px（放大），便于人工检查 */
function renderPreview(tempDir) {
  const at = (s) => TYPES.map((t) => join(tempDir, `${t.name}-${s}.png`));
  const row64 = join(tempDir, "row64.png");
  const row16 = join(tempDir, "row16.png");
  run(["montage", ...at(64), "-tile", "8x", "-geometry", "+10+10",
       "-background", PREVIEW_BG, row64]);
  run(["montage", ...at(16), "-tile", "8x",
       "-geometry", `${16 * PREVIEW_ZOOM}x${16 * PREVIEW_ZOOM}+10+10`,
       "-background", PREVIEW_BG, row16]);
  // 预览图放到固定路径（不随临时目录清理），方便人工查看
  const preview = join(tmpdir(), "heid-icons-preview.png");
  run([row64, row16, "-background", PREVIEW_BG, "-append", preview]);
  return preview;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const font = pickFont();
mkdirSync(OUT_DIR, { recursive: true });
const tempDir = mkdtempSync(join(tmpdir(), "heid-icons-"));

try {
  for (const t of TYPES) {
    const masterPng = join(tempDir, `${t.name}-master.png`);
    renderMaster(t, font, masterPng);
    renderSizes(masterPng, join(tempDir, t.name), SIZES);
    const entries = SIZES.map((s) => {
      if (s >= 256) {
        return { size: s, buf: readFileSync(join(tempDir, `${t.name}-${s}.png`)) };
      }
      const raw = readFileSync(join(tempDir, `${t.name}-${s}.rgba`));
      const expect = s * s * 4;
      if (raw.length !== expect) {
        throw new Error(`${t.name} ${s}px 原始数据大小异常: ${raw.length} != ${expect}`);
      }
      return { size: s, buf: bmpEntryFromRgba(s, raw) };
    });
    const out = join(OUT_DIR, `${t.name}.ico`);
    writeFileSync(out, buildIco(entries));
    const kb = (readFileSync(out).length / 1024).toFixed(1);
    console.log(`  ✓ ${t.label.padEnd(4)} -> ${t.name}.ico (${kb} KB)  [${t.exts.join(", ")}]`);
  }

  const preview = renderPreview(tempDir);
  console.log(`\n共生成 ${TYPES.length} 个图标 -> ${OUT_DIR}`);
  console.log(`预览图（上排 64px / 下排 16px 放大）：${preview}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
