#!/usr/bin/env node
/**
 * 把发布产物同步到 Gitee Release，作为中国大陆的直连下载镜像。
 *
 * 为什么需要它：整条更新链原本只有 GitHub 一个源，而 `github.com` 在国内不挂代理到不了，
 * 桌面端的表现是自动检查静默失败、用户永远停在旧版。方案与实测记录见 docs/update-mirror-plan.md。
 *
 * 端点行为都是 2026-09-22 在目标仓库上实测出来的，三处反直觉的地方：
 *   1. 建 release 必须同时给 `target_commitish` 与 `body`，缺任一个只回一句 messages；
 *      且仓库必须已有提交（空仓库报「创建标签失败」）。
 *   2. 附件走 `POST /releases/{id}/attach_files`，`access_token` **必须在 query 上**——
 *      当 multipart 字段传会返回空响应、附件静默不落地。
 *   3. 同名附件**不覆盖**：同一 release 上重复上传同名文件会挂两份，而直链永远返回第一次那份。
 *      所以固定 tag 的 latest.json 只能「删掉整个 release → 按同一 tag 重建 → 重新上传」，
 *      这也正是本脚本对 `mirror-latest` 做的事。
 *   4. `attach_files` 要**收完整个包才回话**：8 MB 安装包从境外 runner 传过去实测要 5 分钟以上，
 *      而 Node 的 fetch（undici）默认 `headersTimeout` 正好 300 s，于是报成
 *      `fetch failed / Headers Timeout Error`，看着像 Gitee 挂了，其实它还在收。
 *      所以上传这一路走 `node:https`（没有那条隐式上限），其余小请求仍用 fetch。
 *      —— v1.5.0 发布时 CI 上连挂两次都是这一条，第二次重跑同样卡在 5 分钟整。
 *
 * 用法（由 .github/workflows/release.yml 的 mirror-gitee 任务调用）：
 *   GITEE_TOKEN=... node scripts/mirror-gitee.mjs \
 *     --version 1.4.2 --tag v1.4.2 \
 *     --notes docs/RELEASE-NOTES-v1.4.2.md \
 *     --file H.I.D.E_1.4.2_x64-setup.exe \
 *     --file H.I.D.E_1.4.2_arm64.apk \
 *     --manifest latest-mirror.json
 *
 * `--manifest` 指向已生成好的镜像版 latest.json（其 platforms.url 必须已经是 Gitee 直链），
 * 脚本把它传到固定 tag 的 release 上，并回读校验。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { request } from 'node:https';

const API = 'https://gitee.com/api/v5';
/** 承载 latest.json 的固定 tag：Gitee 没有 GitHub 的 `releases/latest/download/...` 那种「永远最新」路径 */
const LATEST_TAG = 'mirror-latest';
const LATEST_FILE = 'latest.json';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argsAll(name) {
  return process.argv.reduce((acc, v, i) => (v === `--${name}` ? [...acc, process.argv[i + 1]] : acc), []);
}

const token = process.env.GITEE_TOKEN;
const repo = process.env.GITEE_REPO || 'misakimiku2/heid-editor';
const version = arg('version');
const tag = arg('tag');
const notesPath = arg('notes');
const files = argsAll('file');
const manifest = arg('manifest');

if (!token || !version || !tag || files.length === 0 || !manifest) {
  console.error('用法: GITEE_TOKEN=... node scripts/mirror-gitee.mjs --version X --tag vX --file <产物> [--file ...] --manifest latest.json [--notes <md>]');
  process.exit(1);
}

/** 令牌只出现在 query 上，任何输出都不整行打印 URL */
const q = () => `access_token=${token}`;
const safe = s => String(s).split(token).join('<redacted>');

async function call(label, path, init) {
  const res = await fetch(`${API}/${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} 失败：HTTP ${res.status} ${safe(text).slice(0, 300)}`);
  return text;
}

async function createRelease({ tagName, name, body }) {
  const payload = {
    access_token: token,
    tag_name: tagName,
    name,
    body,
    target_commitish: 'master',
  };
  const text = await call(
    `创建 release ${tagName}`,
    `repos/${repo}/releases`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const id = JSON.parse(text).id;
  if (!id) throw new Error(`创建 release ${tagName}：响应里没有 id（${safe(text).slice(0, 200)}）`);
  return id;
}

async function findReleaseId(tagName) {
  const text = await call('列出 release', `repos/${repo}/releases?${q()}`);
  return JSON.parse(text).find(r => r.tag_name === tagName)?.id ?? null;
}

async function deleteRelease(id) {
  await call(`删除 release ${id}`, `repos/${repo}/releases/${id}?${q()}`, { method: 'DELETE' });
}

async function listReleases() {
  return JSON.parse(await call('列出 release', `repos/${repo}/releases?${q()}`));
}

/**
 * 上传附件：走 node:https 而不是 fetch。
 * Gitee 的 `attach_files` 要收完整个包才回话，8 MB 安装包从境外 runner 传过去实测 5 分钟以上，
 * 而 undici（Node 的 fetch）默认 300 s 就把响应头判超时了 —— 那条上限对这种"慢但在传"的
 * 大文件上传没有意义，只会把一次成功的发布报成失败。core 的 https.request 只受这里显式
 * 设的 socket 超时约束（20 分钟），到点会主动断开并说清是超时而不是 Gitee 拒绝。
 */
function postMultipart(pathWithQuery, fieldName, filePath, fileName, timeoutMs = 20 * 60_000) {
  return new Promise((resolve, reject) => {
    const boundary = `----heid${Date.now().toString(36)}`;
    const head = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, readFileSync(filePath), tail]);
    const req = request(
      {
        hostname: 'gitee.com',
        path: `/api/v5/${pathWithQuery}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`上传 ${fileName}：${Math.round(timeoutMs / 60000)} 分钟内没有响应`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function uploadFile(releaseId, filePath, nameOverride) {
  const name = nameOverride ?? basename(filePath);
  const { status, text } = await postMultipart(
    `repos/${repo}/releases/${releaseId}/attach_files?${q()}`, 'file', filePath, name,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`上传 ${name} 失败：HTTP ${status} ${safe(text).slice(0, 300)}`);
  }
  const asset = JSON.parse(text);
  if (!asset.browser_download_url) throw new Error(`上传 ${name}：响应里没有直链字段`);
  if (asset.name !== name) throw new Error(`上传 ${name}：Gitee 存成了 ${asset.name}，直链名对不上`);
  return asset;
}

/** 附件直链形态与 GitHub 同构：/releases/download/<tag>/<file> */
export function assetUrl(tagName, fileName) {
  return `https://gitee.com/${repo}/releases/download/${tagName}/${fileName}`;
}

/** 只取 1 个字节，确认直链公开可达（不带任何鉴权）且大小正确 */
async function verifyDownload(url, expectedSize) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (!(res.status === 206 || res.status === 200)) {
    throw new Error(`直链不可达：${url} → HTTP ${res.status}`);
  }
  const range = res.headers.get('content-range');
  const total = range ? Number(range.split('/')[1]) : undefined;
  if (expectedSize !== undefined && total !== undefined && total !== expectedSize) {
    throw new Error(`直链大小不符：${url} 声明 ${total}，本地 ${expectedSize}`);
  }
  return total ?? expectedSize;
}

const notes = notesPath ? readFileSync(notesPath, 'utf8') : `H.I.D.E ${tag}`;

/* 1) 版本 release。Gitee 上同名附件不会覆盖（直链会一直返回第一次传的那份），
      所以重跑发布时必须把带旧附件的 release 删掉按同一 tag 重建，空 release 才复用 */
const AUTO_ARCHIVES = /\.(zip|tar\.gz)$/i;
const existing = (await listReleases()).find(r => r.tag_name === tag);
const reusable = existing && (existing.assets ?? []).every(a => AUTO_ARCHIVES.test(a.name));
if (existing && !reusable) {
  console.log(`Gitee release ${tag} 上已有附件，同名不覆盖 → 删除后按同一 tag 重建`);
  await deleteRelease(existing.id);
}
const releaseId = reusable
  ? existing.id
  : await createRelease({ tagName: tag, name: `H.I.D.E ${tag}`, body: notes });
console.log(`Gitee release ${tag}（id ${releaseId}）`);

/* 2) 传产物，逐个回读直链确认公开可达且体积对得上 */
for (const file of files) {
  const asset = await uploadFile(releaseId, file);
  const size = readFileSync(file).byteLength;
  await verifyDownload(asset.browser_download_url, size);
  console.log(`✓ ${basename(file)} ${(size / 1024 / 1024).toFixed(1)} MB → ${asset.browser_download_url}`);
}

/* 3) 固定 tag 的 latest.json：删了重建，才能让同一个 URL 指向新清单 */
const stale = await findReleaseId(LATEST_TAG);
if (stale) {
  await deleteRelease(stale);
  console.log(`已删除旧的 ${LATEST_TAG} release（id ${stale}）`);
}
const latestReleaseId = await createRelease({
  tagName: LATEST_TAG,
  name: 'H.I.D.E 更新清单（勿删：updater 端点）',
  body: '这个 release 只承载 `latest.json`，供桌面应用内更新的第二端点使用。每次发版会被删除重建，下载地址保持不变。',
});
const manifestAsset = await uploadFile(latestReleaseId, manifest, LATEST_FILE);
await verifyDownload(manifestAsset.browser_download_url, readFileSync(manifest).byteLength);
console.log(`✓ ${LATEST_FILE} → ${manifestAsset.browser_download_url}`);

/* 4) 回读校验：镜像清单里的版本要对得上，且下载地址指向 Gitee 而不是 GitHub */
const remote = await (await fetch(manifestAsset.browser_download_url)).text();
const parsed = JSON.parse(remote);
if (parsed.version !== version) throw new Error(`镜像清单版本不符：远端 ${parsed.version} ≠ ${version}`);
for (const [key, platform] of Object.entries(parsed.platforms ?? {})) {
  if (!platform.url.includes('gitee.com')) {
    throw new Error(`镜像清单的 ${key}.url 没指向 Gitee（${platform.url}）——只镜像清单等于没镜像`);
  }
}
console.log(`镜像完成：${repo} · ${tag} · 清单 ${manifestAsset.browser_download_url}`);
