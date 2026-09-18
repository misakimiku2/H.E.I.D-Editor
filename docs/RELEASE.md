# 发布流程（v1.0.0 起）

> 本文描述 H.I.D.E 的发布链路：更新签名密钥、GitHub secrets、tag 发布操作、
> 桌面自动更新与安卓侧载的版本检查如何衔接。

## 一次性准备

### 1. 更新签名密钥

密钥已生成，私钥位于本地 **`src-tauri/keys/heid.key`**（已被 .gitignore 排除，绝不入库），
公钥内嵌在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。

- **务必备份私钥**：丢失后无法为更新签名，已发布客户端将永远收不到应用内更新
  （只能重新换钥 + 发新版，旧版需手动重装）。
- 当前私钥未设密码（`--password ""` 生成）；`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 相关处留空即可。
- 如需换钥：`npx tauri signer generate -w src-tauri/keys/heid.key`，把新公钥写进
  `tauri.conf.json`，再更新 GitHub secrets。

### 2. GitHub secrets（仓库 Settings → Secrets and variables → Actions）

| Secret | 值 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `src-tauri/keys/heid.key` 文件的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 留空（密钥未设密码） |

## 发布操作

```bash
# 1. 准备当版发行说明文档 docs/RELEASE-NOTES-v{完整版本}.md（每版单独成文）
#    （既是 Release 页面正文，也经 latest.json 的 notes 成为应用内更新说明）
# 2. 更新四处版本号并提交：
#    package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml / src/lib/update.ts
# 3. 打标签推送：
git tag v1.0.1
git push origin v1.0.1
```

> 💡 排查提示：Release 的 `created_at` 是标签所指向提交的时间（GitHub 惯例），
> 不是发布对象的创建时刻；若 Release 停在草稿态（draft），`releases/tags/{tag}`
> 对未鉴权请求会 404、`releases/latest` 也不会指向它——v1.3.1 发布时
> softprops 创建草稿后上传失败未及发布，即为此现象（已改用 gh CLI 直接创建
> 已发布 Release，不会再现）。

推送 `v*` 标签触发 `.github/workflows/release.yml`：

- **桌面（windows-latest）**：`npx tauri build` 带签名构建 NSIS 安装包
  （`*-setup.exe` + `.exe.sig`）→ `scripts/gen-latest-json.mjs` 生成 `latest.json`
  （notes 取自当版发行说明文档）→ `gh release create/upload` 发布。
  `latest.json` 作为 Release 资产，恰为 `tauri.conf.json` 中 updater
  endpoints 指向的 `releases/latest/download/latest.json` —— 桌面端应用内更新由此闭环。
  （2026-09-18 起弃用 tauri-action 与 softprops/action-gh-release 的资产上传：
  两者先后在 windows-latest 上稳定报「Error creating asset temp dir」，
  softprops 在 ubuntu 上正常——疑似其新版上传实现在 Windows 上的缺陷，
  改用 runner 预装的 gh CLI 规避。）
- **安卓**：构建 arm64 debug 签名 APK 附到同一 Release（侧载场景，不要求签名密钥）。
  **2026-09-18 起暂缓**（`android-release` 任务 `if: false`，先专注桌面端；恢复时移除该行）。

日常 CI（`.github/workflows/ci.yml`，push/PR 触发）运行 vitest + tsc + 前端构建、
Windows NSIS 构建（**关闭** `createUpdaterArtifacts`，无需 secrets）、安卓 arm64 debug APK 构建。

## 端上行为

- **桌面**：启动 4 秒后静默检查一次（**无节流，每次启动都检查**——节流曾导致发版后 24h 内
  启动的客户端收不到提示）；「关于」弹窗可手动检查。
  - 发现新版本 → **窗口左下角弹出更新通知卡片**（通用通知系统 `lib/notifications.ts`）：
    点击卡片或「下载并安装」直接下载，完成后自动重启；「忽略此版本」持久化
    （localStorage `heid-update-ignored`，同版本不再弹，更新的版本仍会提示）；X 仅本次关闭。
  - 安装时发行说明写入 localStorage `heid-update-release-notes`（历史列表，最新在前，
    上限 20 份）；更新重启后自动打开一次**只读更新文档标签页**（Markdown 预览视图，
    不可编辑/保存，恒为预览；瞬态标签不进会话快照，重启不保留、不重复弹出）。
    之后可在「关于」→「更新文档」重看最新一份；旁边折叠按钮展开可回看过往版本的文档。
- **安卓（侧载）**：无原生更新器。经既有 `http_get` 命令抓取同一份 `latest.json`，
  比较版本号；有新版弹出通知卡片，「前往下载」跳转 Releases 页面手动安装 APK。
- **浏览器模式**：无更新通道，所有检查直接跳过。

## 本地验证

```bash
# 本地带签名构建（验证 updater 产物能生成）。
# 注意：密钥为加密容器格式，PASSWORD 必须显式置空，否则签名步骤会交互式挂起等待输入：
TAURI_SIGNING_PRIVATE_KEY=$(cat src-tauri/keys/heid.key) \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npx tauri build
# 产物：src-tauri/target/release/bundle/nsis/ 下含安装包 .exe 与更新签名 .exe.sig
```

## 安装包外观

NSIS 向导配置在 `tauri.conf.json` 的 `bundle.windows.nsis`：`languages: ["SimpChinese"]`
（简体中文向导，卸载向导同步生效），`headerImage`（150×57）/ `sidebarImage`（164×314）
为品牌图 BMP，源文件 `src-tauri/icons/installer-header.bmp` / `installer-sidebar.bmp`
（由 `icon.png` 经脚本生成：取主体深色为底、居中/左置粘贴品牌图标）。
