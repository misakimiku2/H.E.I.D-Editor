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
# 1. 更新三处版本号并提交：
#    package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
# 2. 打标签推送：
git tag v1.0.1
git push origin v1.0.1
```

推送 `v*` 标签触发 `.github/workflows/release.yml`：

- **桌面（windows-latest）**：tauri-action 构建 NSIS 安装包与更新产物
  （`*-setup.exe`、`*.nsis.zip` + `.nsis.zip.sig`、`latest.json`），自动创建 GitHub Release
  并上传。`latest.json` 作为 Release 资产，恰为 `tauri.conf.json` 中 updater
  endpoints 指向的 `releases/latest/download/latest.json` —— 桌面端应用内更新由此闭环。
- **安卓**：构建 arm64 debug 签名 APK 附到同一 Release（侧载场景，不要求签名密钥）。

日常 CI（`.github/workflows/ci.yml`，push/PR 触发）运行 vitest + tsc + 前端构建、
Windows NSIS 构建（**关闭** `createUpdaterArtifacts`，无需 secrets）、安卓 arm64 debug APK 构建。

## 端上行为

- **桌面**：启动 4 秒后静默检查一次（24h 节流，localStorage `heid-update-last-check`）；
  「关于」弹窗可手动检查。发现新版本 → 自动弹确认框，确认后下载安装并重启。
- **安卓（侧载）**：无原生更新器。经既有 `http_get` 命令抓取同一份 `latest.json`，
  比较版本号；有新版提示「前往下载」，跳转 Releases 页面手动安装 APK。
- **浏览器模式**：无更新通道，所有检查直接跳过。

## 本地验证

```bash
# 本地带签名构建（验证 updater 产物能生成）：
TAURI_SIGNING_PRIVATE_KEY=$(cat src-tauri/keys/heid.key) npx tauri build
# 产物：src-tauri/target/release/bundle/nsis/ 下含 .exe / .nsis.zip / .nsis.zip.sig
```
