#!/usr/bin/env node
/**
 * 生成桌面更新清单 latest.json（tauri-plugin-updater 的 endpoint 资产）。
 *
 * 输入：
 *   --version    应用版本号（如 1.3.0）
 *   --sig        更新签名文件路径（tauri build 产出的 *-setup.exe.sig）
 *   --notes      更新说明 Markdown 文件路径（作为 notes 字段；缺省为空）
 *   --url        安装包下载地址（releases/download/v<version>/<exe 名>）
 *   --out        输出文件路径（默认 stdout）
 *
 * 结构对齐 tauri-plugin-updater 的验签管线（verify_signature：对 signature 字段
 * base64 解码一次后交给 minisign Signature::decode 解析多行文本）。
 * tauri v2 CLI 产出的 .sig 文件内容本身就是一层 base64 包装，因此 signature
 * 字段 = .sig 文件原文（不再额外编码，否则插件解码一次后拿到的仍是密文，
 * 会报「Invalid encoding in minisign data」）。双键 windows-x86_64(-nsis)
 * 对齐 tauri-action 历史产物。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const version = arg('version');
const sigPath = arg('sig');
const notesPath = arg('notes');
const url = arg('url');
const out = arg('out');

if (!version || !sigPath || !url) {
  console.error('用法: node gen-latest-json.mjs --version 1.3.0 --sig <setup.exe.sig> --url <下载地址> [--notes <md>] [--out latest.json]');
  process.exit(1);
}

const signature = readFileSync(sigPath, 'utf8').trim();
const notes = notesPath ? readFileSync(notesPath, 'utf8') : '';

const asset = { signature, url };
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': asset,
    'windows-x86_64-nsis': asset,
  },
};

const json = JSON.stringify(manifest, null, 2);
if (out) {
  writeFileSync(out, json);
  console.error(`latest.json 已生成 → ${out}（版本 ${version}，资产 ${basename(url)}）`);
} else {
  process.stdout.write(json);
}
