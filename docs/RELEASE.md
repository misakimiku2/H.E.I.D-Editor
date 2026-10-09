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
| `GITEE_TOKEN` | Gitee 私人令牌（只勾 `projects` 权限），国内镜像任务用；缺失时该任务显式报错 |

### 3. 安卓 release 签名（v1.4 起）

桌面更新签名之外，安卓侧载 APK 自 v1.4 起用独立 keystore 做 release 签名（此前为 debug 签名，
升级安装时系统要求签名一致，v1.3.x debug 包无法直接覆盖安装 v1.4.0+，需卸载重装一次）。

- **密钥已生成**：`src-tauri/gen/android/app/heid-release.keystore`（alias `heid`，RSA 2048，
  有效期 30 年），密码存于 `src-tauri/gen/android/keystore.properties`——两者均已被
  .gitignore 排除，**务必备份**：丢失后无法再以同签名发版，已安装用户需卸载重装。
- `app/build.gradle.kts` 的 `signingConfigs` 在 keystore.properties 存在时自动接上
  release 签名，缺失时退回 debug 签名（保证 fork / 无密钥环境构建不失败）。
- **GitHub secrets**（`android-release` 任务用，缺失时该任务显式报错）：

  | Secret | 值 |
  | --- | --- |
  | `HEID_ANDROID_KEYSTORE_B64` | `base64 -w0 src-tauri/gen/android/app/heid-release.keystore` 的输出 |
  | `HEID_ANDROID_KEYSTORE_PASSWORD` | `keystore.properties` 里的 `storePassword` 值 |

## 发布操作

```bash
# 1. 准备当版发行说明文档 docs/RELEASE-NOTES-v{完整版本}.md（每版单独成文）
#    （既是 Release 页面正文，也经更新清单的 notes 成为应用内更新说明）
#    只发一端时，在那篇开头的 `>` 信息行里写死「本版仅桌面」或「本版仅安卓」——
#    CI 的 detect 任务按这一行决定跑哪几段（scripts/release-plan.mjs），没写就两端都发
# 2. 更新版本号（六处，全部同步）：
#    package.json / package-lock.json（根两处）/ src-tauri/tauri.conf.json /
#    src-tauri/Cargo.toml / src-tauri/Cargo.lock / src/lib/update.ts 的 FALLBACK_APP_VERSION
#    安卓 versionCode 由 tauri 按版本号自动推导（1.4.0 → 1004000），不用手改
# 3. 打标签推送：
git tag v1.0.1
git push origin v1.0.1
```

> 单端发版会吃掉一个版本号：v1.5.6 只出了桌面包，下一版安卓就得从 v1.5.7 起，
> 不能复用 1.5.6（两端共用同一套版本号，安卓包内的 `versionName` 由它推导）。

> 💡 排查提示：Release 的 `created_at` 是标签所指向提交的时间（GitHub 惯例），
> 不是发布对象的创建时刻；若 Release 停在草稿态（draft），`releases/tags/{tag}`
> 对未鉴权请求会 404、`releases/latest` 也不会指向它——v1.3.1 发布时
> softprops 创建草稿后上传失败未及发布，即为此现象（已改用 gh CLI 直接创建
> 已发布 Release，不会再现）。

推送 `v*` 标签触发 `.github/workflows/release.yml`，任务是 `detect` → `desktop-release` /
`android-release`（按标记只跑该跑的那几段）→ `update-channels` → `mirror-gitee`：

- **detect**：跑 `scripts/release-plan.mjs`，读当版发行说明开头一行的「本版仅桌面 / 本版仅安卓」
  决定后面跑哪几段，并查出**两端各自「上一次真出过包的版本」**——判据是 GitHub 上最新的、
  挂了 `*_x64-setup.exe` / `*_arm64.apk` 的正式 Release，产物本身就是事实，不会和清单漂移。
- **桌面（windows-latest）**：`npx tauri build` 带签名构建 NSIS 安装包
  （`*-setup.exe` + `.exe.sig`）→ `gh release create/upload` 建正文并挂产物。
  （2026-09-18 起弃用 tauri-action 与 softprops/action-gh-release 的资产上传：两者先后在
  windows-latest 上稳定报「Error creating asset temp dir」，softprops 在 ubuntu 上正常——
  疑似其新版上传实现在 Windows 上的缺陷，改用 runner 预装的 gh CLI 规避。）
- **安卓**：v1.4 起恢复发布并升级为 **release 签名 APK**（`android-release` 任务，arm64）。
  签名密钥经 secrets `HEID_ANDROID_KEYSTORE_B64` / `HEID_ANDROID_KEYSTORE_PASSWORD` 提供，
  缺失时任务以显式报错失败；详见「一次性准备 → 安卓 release 签名」。
  产物上传前重命名为 `H.I.D.E_<版本>_arm64.apk`（gradle 原名 `app-universal-release.apk`
  在 `--target aarch64` 下名不副实），并断言包内确有 `lib/arm64-v8a/`。
  它 `needs: desktop-release` 且条件里带 `!cancelled()`：桌面被跳过时依赖的 result 是 `skipped`，
  不加这个函数 GitHub 会连带把安卓也跳过。
- **两端更新清单**（`update-channels`，每版都跑）：`scripts/gen-latest-json.mjs` 生成 `latest.json`
  （版本写 detect 给的**桌面版本**，notes 取那一版的发行说明，地址指向那一版的 tag）、
  `scripts/gen-android-latest.mjs` 生成 `latest-android.json`（只写版本号与说明，里面不放任何
  下载地址——清单版本可能不是本次那一版，放地址就会指错），两份都挂到**本次 tag** 下。
  两端读的都是 `releases/latest/download/...`，所以清单必须落在本次 tag 上才生效；
  这一版本没出包的那一端在这里原样沿用上一次的值，也就不会被提示更新到一个没有自己产物的版本。
  签名一律从「清单所写那一版」的 tag 拉：本版出了桌面包就在本次 tag 上，没出就在上一版 tag 上。
- **国内镜像**（`mirror-gitee`，`needs` 上面几段）：只同步本版**实际出了包**的那几端产物到
  Gitee Release（`misakimiku2/heid-editor`），并重建固定 tag `mirror-latest` 上的两份清单——
  桌面那份把地址改写成 Gitee 直链，安卓那份与 GitHub 内容一致。它就是 `tauri.conf.json` 里
  updater 的第二 endpoint，也是安卓版本检查的第二个源。为什么需要它、以及 Gitee 那几处反直觉的
  API 行为，记在 [update-mirror-plan.md](update-mirror-plan.md) 与 `scripts/mirror-gitee.mjs` 头部。
  镜像失败不影响 GitHub 侧已完成的发布（该任务在最后，仅自身标红）。

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
- **安卓（侧载）**：无原生更新器。经既有 `http_get` 命令抓取**安卓自己的**版本清单
  `latest-android.json`（候选源同样是 GitHub → Gitee 镜像两条），比较版本号；有新版弹出通知卡片，
  「前往下载」跳转 Releases 页面手动安装 APK。桌面单独发版时这份清单的版本不动，手机也就什么都不弹。
  - ⚠️ 已知限制：v1.5.5 及更早装在手机上的客户端读的还是共享的 `latest.json`，所以**桌面单独发版
    时它们仍会弹一次**「发现新版本」，点进去没有对应版本的 APK；用户点「忽略此版本」后该版不再弹。
    这条从下一版安卓包（读 `latest-android.json` 的那版起）才彻底断掉。
- **浏览器模式**：无更新通道，所有检查直接跳过。

## 本地验证

```bash
# 本地带签名构建（验证 updater 产物能生成）。
# 注意：密钥为加密容器格式，PASSWORD 必须显式置空，否则签名步骤会交互式挂起等待输入：
TAURI_SIGNING_PRIVATE_KEY=$(cat src-tauri/keys/heid.key) \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npx tauri build
# 产物：src-tauri/target/release/bundle/nsis/ 下含安装包 .exe 与更新签名 .exe.sig

# 安卓 release 签名构建（需本地存在 keystore.properties，签名自动接入）：
npx tauri android build --apk --target aarch64
# 产物：src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk（已签名）
```

## 安装包外观

NSIS 向导配置在 `tauri.conf.json` 的 `bundle.windows.nsis`：`languages: ["SimpChinese"]`
（简体中文向导，卸载向导同步生效），`headerImage`（150×57）/ `sidebarImage`（164×314）
为品牌图 BMP，源文件 `src-tauri/icons/installer-header.bmp` / `installer-sidebar.bmp`
（由 `icon.png` 经脚本生成：取主体深色为底、居中/左置粘贴品牌图标）。

## 安卓桌面图标（v1.4.0 起）

安卓图标与桌面图标**分开维护**，源图在 `src/assets/`：

- `heid-icon-dark.svg` / `heid-icon-light.svg`：应用内与桌面用的圆角窗口标（含顶部栏与三个圆点）。
- `heid-icon-android.svg`：安卓启动图标专用——满幅 `#111827` 底 + 居中 `>_<`，几何取自桌面稿 ×2。
  **刻意不含顶部栏与圆点**：自适应图标（adaptive icon）的圆形/方形遮罩只保留中心 66 % 安全区，
  那条栏会被切掉大半，48 dp 下三个点也糊成一团。

改了 `heid-icon-android.svg` 之后重新生成：

```bash
# 1) SVG 光栅化成 1024×1024 PNG —— tauri icon 只吃位图不吃 SVG。
#    无依赖做法：chrome --headless=new --window-size=1024,1024 --screenshot=<png> file:///<svg>
# 2) 生成全密度位图 + 自适应图层
npx tauri icon <png>
# 3) 关键：tauri icon 会顺手重写 src-tauri/icons/ 整套桌面与 Windows 图标，
#    必须还原、只留 gen/android 的改动，否则已发布的桌面图标被安卓构图覆盖
git checkout -- src-tauri/icons && rm -rf src-tauri/icons/ios src-tauri/icons/64x64.png
```

生成物落在 `src-tauri/gen/android/app/src/main/res/`：`mipmap-{m,h,xh,xxh,xxxh}dpi/` 下的
`ic_launcher.png` / `ic_launcher_round.png` / `ic_launcher_foreground.png`，自适应定义
`mipmap-anydpi-v26/ic_launcher{,_round}.xml`，背景色 `values/ic_launcher_background.xml`
（模板默认 `#fff`，已改品牌深色 `#111827`）。
