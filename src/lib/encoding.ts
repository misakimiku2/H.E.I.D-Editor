/**
 * 文本编码（纯函数，字节 → 文本）：
 * - 桌面端（Tauri）由 Rust 命令 read_text_file / write_text_file 用 encoding_rs 精确检测与编码；
 * - 安卓（SAF 字节流）与浏览器模式使用本模块：BOM → 严格 UTF-8 → 常见中文/日文编码启发式 → 回退。
 * 编码 id 统一使用 WHATWG label（与 TextDecoder / encoding_rs 双侧兼容）。
 */

export interface EncodingOption {
  id: string;
  label: string;
}

/** 状态栏「编码」菜单提供的手动选项 */
export const ENCODING_OPTIONS: EncodingOption[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'gbk', label: 'GBK' },
  { id: 'gb18030', label: 'GB18030' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'big5', label: 'Big5' },
  { id: 'shift_jis', label: 'Shift_JIS' },
  { id: 'windows-1252', label: 'Windows-1252' },
];

export function encodingLabel(id: string): string {
  return ENCODING_OPTIONS.find(o => o.id === id)?.label ?? id;
}

/** 解码结果：text 不含 BOM；bom 表示文件带 BOM（保存时写回） */
export interface DecodedText {
  text: string;
  encoding: string;
  bom: boolean;
  /** 解码存在无法映射的字节（已用 U+FFFD 替代） */
  lossy: boolean;
  /** 疑似二进制（前 8KB 含 NUL），text 仅供查看 */
  binary: boolean;
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = 0xff;
const UTF16BE_BOM = 0xfe;

function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2];
}

/** 用指定编码解码；utf-8 BOM 由调用方按需剥离，UTF-16 BOM 由解码器自动消费 */
export function decodeWith(bytes: Uint8Array, encoding: string): string {
  return new TextDecoder(encoding).decode(bytes);
}

/** 按指定编码解码并剥离 BOM（UTF-8 3 字节 / UTF-16 2 字节），bom 标志返回给调用方 */
export function decodeAs(bytes: Uint8Array, encoding: string): { text: string; bom: boolean; lossy: boolean } {
  let bom = false;
  let data = bytes;
  if (encoding === 'utf-8' && startsWithUtf8Bom(bytes)) {
    bom = true;
    data = bytes.subarray(3);
  } else if (encoding === 'utf-16le' && bytes.length >= 2 && bytes[0] === UTF16LE_BOM && bytes[1] === UTF16BE_BOM) {
    bom = true;
    data = bytes.subarray(2);
  } else if (encoding === 'utf-16be' && bytes.length >= 2 && bytes[0] === UTF16BE_BOM && bytes[1] === UTF16LE_BOM) {
    bom = true;
    data = bytes.subarray(2);
  }
  const decoded = decodeWith(data, encoding);
  return { text: decoded, bom, lossy: decoded.includes('\uFFFD') };
}

/**
 * 启发式编码检测（安卓 / 浏览器路径）：
 * 1. BOM（UTF-8 / UTF-16 LE / BE）→ 精确；
 * 2. 前 8KB 含 NUL → 判二进制（NUL 是合法 UTF-8，必须先于严格校验），lossy UTF-8 仅供展示；
 * 3. 严格 UTF-8 通过 → utf-8；
 * 4. GBK / Big5 / Shift_JIS 无替换字符者按序认定；
 * 5. 回退 GBK（目标用户最常见，lossy）。
 */
export function detectEncoding(bytes: Uint8Array): DecodedText {
  if (bytes.length === 0) {
    return { text: '', encoding: 'utf-8', bom: false, lossy: false, binary: false };
  }
  if (startsWithUtf8Bom(bytes)) {
    const { text, lossy } = decodeAs(bytes, 'utf-8');
    return { text, encoding: 'utf-8', bom: true, lossy, binary: false };
  }
  if (bytes.length >= 2 && bytes[0] === UTF16LE_BOM && bytes[1] === UTF16BE_BOM) {
    return { text: decodeWith(bytes.subarray(2), 'utf-16le'), encoding: 'utf-16le', bom: true, lossy: false, binary: false };
  }
  if (bytes.length >= 2 && bytes[0] === UTF16BE_BOM && bytes[1] === UTF16LE_BOM) {
    return { text: decodeWith(bytes.subarray(2), 'utf-16be'), encoding: 'utf-16be', bom: true, lossy: false, binary: false };
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (head.includes(0)) {
    return { text: decodeWith(bytes, 'utf-8'), encoding: 'utf-8', bom: false, lossy: true, binary: true };
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    return { text: strict.decode(bytes), encoding: 'utf-8', bom: false, lossy: false, binary: false };
  } catch {
    /* 非 UTF-8，继续检测 */
  }
  for (const encoding of ['gbk', 'big5', 'shift_jis']) {
    try {
      const text = decodeWith(bytes, encoding);
      if (!text.includes('\uFFFD')) {
        return { text, encoding, bom: false, lossy: false, binary: false };
      }
    } catch {
      /* 引擎不支持该编码标签则跳过 */
    }
  }
  return { text: decodeWith(bytes, 'gbk'), encoding: 'gbk', bom: false, lossy: true, binary: false };
}
