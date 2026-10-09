#!/usr/bin/env node
/**
 * 生成安卓侧载的版本清单 latest-android.json（挂在每个 Release 下，与桌面的 latest.json 同批）。
 *
 * 安卓没有原生更新器，只用它做「有没有新版」的判断，因此字段只到 parseLatestJson 认得了止：
 * `version` + `notes`。签名、下载地址一概不放——那两个属于桌面 updater 的协议，而且
 * 清单里的版本可能不是本次发布那一版（桌面单独发版时它停在上一次安卓版本），放地址就会指错。
 *
 * 用法：node scripts/gen-android-latest.mjs --version 1.5.5 \
 *         --notes docs/RELEASE-NOTES-v1.5.5.md --out latest-android.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const version = arg('version');
const notesPath = arg('notes');
const out = arg('out');

if (!version || !notesPath) {
  console.error('用法: node gen-android-latest.mjs --version <清单版本> --notes <该版的发行说明> [--out latest-android.json]');
  process.exit(1);
}

const manifest = { version, notes: readFileSync(notesPath, 'utf8') };
const json = JSON.stringify(manifest, null, 2);

if (out) {
  writeFileSync(out, json);
  console.error(`latest-android.json 已生成 → ${out}（版本 ${version}，说明 ${basename(notesPath)}）`);
} else {
  process.stdout.write(json);
}
