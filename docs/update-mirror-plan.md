# 国内可达的更新 / 下载渠道方案

记录于 2026-09-22 · 目标版本待定（v1.4.2 候选项）· 约束：**不花钱**（软件免费，不为此上付费服务）

## 问题

整条更新与下载链只有 GitHub 一个源，而 `github.com` 在中国大陆不挂代理基本到不了：

| 位置 | 现状 |
| --- | --- |
| `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` | 只有一条 GitHub 地址；Tauri 这里**本来就支持数组**，按顺序回退 |
| `src/lib/update.ts` → `LATEST_JSON_URL` | 单个常量，安卓侧经 `http_get` 抓它（`useUpdater.ts:63`、`App.tsx:848`） |
| `src/lib/update.ts` → `RELEASES_PAGE` | 安卓「前往下载」跳的页面（`useUpdater.ts:125`） |

用户侧的实际表现：**桌面端永远停在旧版且毫不知情**（检查失败是静默跳过的，界面上没有任何提示），
安卓端装了之后收不到更新、点「前往下载」打不开页面。

## 三条路线的可达性与成本

| 路线 | 墙内可达 | 花费 | CI 能否自动 | 备注 |
| --- | --- | --- | --- | --- |
| Cloudflare R2 / Pages / Workers 免费额度 | **不绑自有域名就不稳**（`workers.dev` / `pages.dev` 受 DNS 污染，2022 年起就有记录） | 托管 0 元，域名 ¥50–80/年 | 能（S3 兼容上传） | 违反「不花钱」，除非已有域名 |
| 阿里 OSS / 腾讯 COS 按量 | 可达（用桶默认域名不需要备案） | 每月几毛～几块，但要绑支付方式 | 能 | 同上，且要实名 + 充值 |
| **Gitee Release 镜像** | **可达且快** | **0 元** | **待验证**（见下） | 需要 Gitee 账号 + 实名认证 |

结论：**在「一分钱不花」这个前提下，国内可达的候选只剩 Gitee。** 其余免费海外托管都要靠域名才能救回来。

## 建议分三步走

### 第一步：先让「多源」和「失败可见」成立（0 元，纯本仓库改动，不依赖任何新服务）

这一步单独就有价值——做完之后哪怕还没有镜像，用户至少知道「检查更新失败了」而不是无声无息。

1. `tauri.conf.json` 的 `endpoints` 改成数组（先放 GitHub 一条，镜像地址到位后加第二行）。
2. `update.ts` 把 `LATEST_JSON_URL` 改成 `LATEST_JSON_URLS: string[]`，安卓侧 `http_get` 按顺序试到成功为止；
   `RELEASES_PAGE` 同样加一个镜像下载页常量。
3. **检查失败不再静默**：桌面端在「关于」弹窗里显示「检查更新失败（网络不可达）」+ 一个「复制下载链接」按钮；
   启动时的静默检查失败仍不打扰用户，只更新「关于」里的状态。
4. 补测试：多源回退（第一个 404 / 超时 → 用第二个）、失败态渲染。

### 第二步：Gitee 镜像（0 元，需要他注册 + 实名）

**2026-09-22 实测结论（在 `gitee.com/misakimiku2/h.-e.-i.-d-editor` 上跑通后已清理干净，只剩 README 提交）：**

| 动作 | 端点 / 结果 |
| --- | --- |
| 建 release | `POST /api/v5/repos/{owner}/{repo}/releases`，参数 `tag_name` / `name` / `body` / **`target_commitish`（必填，缺了只回 `{"messages":["target_commitish is missing"]}`）**。仓库必须已有提交，空仓库会报「创建标签失败」 |
| 传附件 | `POST /api/v5/repos/{owner}/{repo}/releases/{id}/attach_files`，`multipart/form-data`，字段名 `file` → **201**。`access_token` **必须放 query**：当表单字段传会静默失败（HTTP 空响应，release 上什么都没有） |
| 公开直链 | `https://gitee.com/{owner}/{repo}/releases/download/{tag}/{file}` —— **不带任何鉴权 200**，15 MB 用时 8.5 秒、SHA-256 与源文件逐字节一致 |
| 体积 | 15 MB（真实 APK 大小）可传，未见限制 |
| 删除 | `DELETE /api/v5/repos/{owner}/{repo}/releases/{id}` → 204；tag 用 `git push <url> :refs/tags/<tag>` 删 |

直链形态与 GitHub 的 `/releases/download/<tag>/<file>` **完全同构**，所以镜像版 `latest.json` 只需替换
host 与 owner/repo，路径结构不动。

**必须设计掉的一个坑**：Gitee 没有 GitHub 的 `releases/latest/download/...`（永远指向最新版）这条路径。
所以镜像的 updater 端点不能按版本 tag 走，要维护一个固定 tag（如 `mirror-latest`）的 release，
每次发版把 `latest.json` 重传上去，端点才稳定：
`https://gitee.com/{owner}/{repo}/releases/download/mirror-latest/latest.json`。
安装包本身按版本 tag 放即可（`latest.json` 里写的是带版本号的完整地址）。
→ **下一步先验证**：同一 tag 的 release 上重复上传同名附件是覆盖、报错，还是留下两份。

其余步骤：

1. 令牌放 GitHub Secrets（`GITEE_TOKEN`），本地调试用仓库外的 `~/.gitee_token`，不进对话也不进提交。
2. CI 加 `mirror-gitee` 任务：`needs:` 桌面任务，下载四个产物 → 建 release → 传附件 → 重传固定 tag 的 `latest.json`。
3. `scripts/gen-latest-json.mjs` 加「镜像版清单」开关，把 `platforms.*.url` 改写成 Gitee 直链。
   **这一步是关键**：镜像那份清单里的下载地址必须指向 Gitee，否则用户拿到清单仍回 GitHub 取包，等于只镜像了一张纸。
4. `tauri.conf.json` 的 `endpoints` 与 `update.ts` 的 `LATEST_JSON_URLS` 各追加一行镜像地址（两处都已支持多源）。
5. 安卓「前往下载」在 GitHub 不可达时指向 Gitee 的 Release 页。

### 第三步（可选，跳过不影响前两步）：自有域名 + Cloudflare R2

只有当他手上已经有域名、或将来愿意为品牌域名花钱时才做。收益是：一个自己控制的下载页与 updater 端点，
不依赖任何第三方平台的政策变化。

## 为什么镜像是安全的

桌面更新走 minisign 签名校验，公钥内嵌在 `tauri.conf.json`，**校验与文件从哪台机器下载无关**：
镜像被劫持、被替换成别的 exe，签名对不上就装不上。安卓侧是用户自己下载 APK，
系统按 release keystore 校验（`CN=H.I.D.E`），换源的后果最多是装不上，不会被静默替换。
所以「多一个镜像」不引入新的信任面——这也是为什么公共 gh-proxy 加速串我不建议进 updater：
那是把信任交给第三方，而镜像只是换搬运工。

## 实施状态（2026-09-22）

- **第一步已完成**：`update.ts` 的 `LATEST_JSON_URLS`（多源按序回退）+ `fetchLatestJson` +
  `UpdateSourceUnavailableError`；`useUpdater` 的 `autoCheckFailed` / `errorKind` / `sourceUrl`；
  「关于」里的失败留痕与「复制下载链接」；桌面 `endpoints` 两条。
- **第二步已接线**：`scripts/mirror-gitee.mjs` + `release.yml` 的 `mirror-gitee` 任务 +
  `tauri.conf.json` 第二 endpoint + 安卓下载页跟随命中的源（`downloadPageFor`）。
  令牌放 GitHub Secrets `GITEE_TOKEN`。
- **待做**：拿一次真实发版（或手工跑一次脚本）验证镜像端到端跑通。
  注意 `verifyDownload` 用的是 Range 请求，Gitee 是否稳定支持 `bytes=0-0` 尚未实测——
  不支持时脚本会退化成整文件下载校验（慢但对），或按实测结果改成只校验 HTTP 200。

## 参考

- Cloudflare workers.dev 在国内的 DNS 污染问题：https://cloud.tencent.com/developer/article/2133923
- Gitee Release 说明（只写网页端，未写附件 API）：https://help.gitee.com/repository/release/what-is-release
- Gitee 官方仓库里关于「创建 Release 与上传附件 API」的未答 issue：https://gitee.com/oschina/git-osc/issues/I7UFD9
