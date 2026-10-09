#!/usr/bin/env node
/**
 * 发布前判定：这一版发哪几端、两份更新清单各写哪个版本号。
 *
 * 依据是当版发行说明开头一行里的「本版仅桌面 / 本版仅安卓」，没写就两端都发。
 * 为什么要两份清单：更新清单里只有一个 `version` 字段，桌面 updater 与安卓侧载检查过去读的是
 * 同一份 latest.json —— 只挂出安装包的那一端一升版本，另一端也会被提示去更新到一个没有它
 * 产物的页面。现在桌面读 latest.json、安卓读 latest-android.json，各自的版本只在真挂了
 * 对应产物时才推进；没发布的那一端把上一次的值原样重挂到本次 tag 下（`releases/latest/download/`
 * 的两个地址都得有东西，否则被跳过那一端的检查会整条落空）。
 *
 * 「上一次出过包的版本」不写死在仓库里，直接查 GitHub 上最新的、带该端产物的 Release——
 * 产物本身就是事实，不会和清单漂移。
 *
 * 用法：
 *   node scripts/release-plan.mjs --print              本地看判定结果
 *   node scripts/release-plan.mjs >> "$GITHUB_OUTPUT"  CI 里写成 job outputs
 */
import { readFileSync, existsSync } from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY || 'misakimiku2/H.E.I.D-Editor';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=50`;
const EXE_SUFFIX = '_x64-setup.exe';
const APK_SUFFIX = '_arm64.apk';

/** 拉取公开 Release 列表；失败就显式报错，绝不把「查不到」当成「沿用当前版本」 */
async function listReleases() {
  const headers = { 'User-Agent': 'heid-release-plan', Accept: 'application/vnd.github+json' };
  // CI 里传 github.token（匿名打 api.github.com 是共享 IP 的限流池，发版时容易撞 403）；
  // 本地不带令牌，匿名读公开仓库就够
  const token = process.env.RELEASE_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API, { headers });
  if (!res.ok) throw new Error(`列出 Release 失败：HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('列出 Release：响应不是数组');
  return data;
}

/** 最新的、挂了某端产物的正式 Release tag（去掉前缀 v） */
function newestTagWithAsset(releases, suffix) {
  const hit = releases.find(r => !r.draft && !r.prerelease
    && (r.assets ?? []).some(a => a.name?.endsWith(suffix)));
  if (!hit?.tag_name) throw new Error(`没找到任何挂了 *${suffix} 的 Release`);
  return hit.tag_name.replace(/^v/i, '');
}

/** 发行说明开头几行里的平台标记：仅桌面 → 不发安卓，仅安卓 → 不发桌面，没标记 → 两端都发 */
function platformsFromNotes(notesText) {
  const head = notesText.split('\n', 10).join('\n');
  if (head.includes('仅桌面')) return { desktop: true, android: false, marker: '仅桌面' };
  if (head.includes('仅安卓')) return { desktop: false, android: true, marker: '仅安卓' };
  return { desktop: true, android: true, marker: '两端' };
}

const notesPathFor = v => `docs/RELEASE-NOTES-v${v}.md`;

async function plan() {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const notesPath = notesPathFor(version);
  if (!existsSync(notesPath)) throw new Error(`缺当版发行说明 ${notesPath}（Release 正文与两端清单的 notes 都取它）`);

  const { desktop, android, marker } = platformsFromNotes(readFileSync(notesPath, 'utf8'));
  const releases = await listReleases();
  const desktopVersion = desktop ? version : newestTagWithAsset(releases, EXE_SUFFIX);
  const androidVersion = android ? version : newestTagWithAsset(releases, APK_SUFFIX);

  /* 未发布那一端的 notes 要取它自己那一版的文档：写当版说明会让手机弹出一份讲着桌面修复的说明 */
  for (const [label, v] of [['桌面', desktopVersion], ['安卓', androidVersion]]) {
    const p = notesPathFor(v);
    if (!existsSync(p)) throw new Error(`${label}清单的版本 ${v} 缺发行说明 ${p}`);
  }

  return {
    version, marker, desktop, android, desktopVersion, androidVersion,
    desktopNotes: notesPathFor(desktopVersion),
    androidNotes: notesPathFor(androidVersion),
  };
}

const p = await plan();

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(p, null, 2));
} else {
  /* GITHUB_OUTPUT 的布尔值写成 'true' / 'false'，workflow 里按字符串比 */
  console.log(`version=${p.version}`);
  console.log(`desktop=${p.desktop}`);
  console.log(`android=${p.android}`);
  console.log(`desktop_version=${p.desktopVersion}`);
  console.log(`android_version=${p.androidVersion}`);
  console.log(`desktop_notes=${p.desktopNotes}`);
  console.log(`android_notes=${p.androidNotes}`);
}

/* 判定过程留一行可核对的说明：回看 CI 日志时，这一行记录了按哪条标记走、两端清单各停在哪个版本 */
console.error(`发布判定（${p.marker}）：桌面发 ${p.desktop} / 安卓发 ${p.android}；`
  + `清单版本 桌面 ${p.desktopVersion}、安卓 ${p.androidVersion}`);
