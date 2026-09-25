# 2026-09-25 跨机局域网实测结论（v1.5 阶段 2/3/4）

拓扑：桌面 = 另一台电脑 `192.168.31.174:47123`（`--no-bundle` 出的裸 exe），共享根
`\\192.168.31.87\git\link-test`（**就是这台机的 `C:\Users\Misaki\Desktop\git\link-test`**，
所以手机端写进去的东西我能在这台机按字节核对）；客户端 = `aurora35` 上的 x86_64 debug 包
（含阶段 0–4 + `d5c7e47`），CDP 驱动，页面里自挂事件监听器取证。

样例：`README.txt`（LF 里夹一行 CRLF）、`中文 名称.md`、`gbk.txt`（GBK + CRLF）、
`nested/pair.json`、`nested/a/b/deep.js`、`node_modules/fake-pkg/`、`blob.dat`（7,000,000 B）。

## 通过的（逐条有返回值为证）

| 项 | 结果 |
| --- | --- |
| 短码配对（跨机） | 2 s 内 `connected:true`；票有效时一次通过 |
| 免扫重连 | `disconnect` → `link_client_reconnect(keyId=e349b2b2…)` → `connected:true`，**桌面零点击** |
| `list` 根 / 子目录 | 正常，含中文名与 `node_modules`（列目录不做黑名单，符合设计） |
| `read` GBK 自动识别 | `encoding:"gbk"`、`lossy:false`，中文解得对 |
| `read` 换行保留 | `"line one\nline two CRLF-next\r\nline three\n"` 原样带回 |
| `read` 基线 | 每次带回 `hash`，写回环要用它 |
| `write` 落盘 | 手机写 → 这台机按字节核对**完全一致**（含中文、LF） |
| `write` 冲突 | 拿过期基线再写 → `conflict:true` 且带回 `serverHash`，没有静默覆盖 |
| 路径逃逸 | `../x` → `badpath`；`C:/Windows/win.ini` → `absolute`；UNC → `absolute`；`nested/../../x` → `badpath`。四类全拒 |
| 超限文件 | `blob.dat` → `toobig`，如实拒绝不卡住 |
| 阶段 3 标签同步 | `tabs` 带回桌面标签（welcome.ts / 更新文档 v1.4.2.md…含 language、mdView、dirty） |
| 错误回传 | 桌面拒绝原因原样到手机（`对端拒绝（ticket）：…`） |
| 防火墙（§11.1） | guest→`192.168.31.174:47123` TCP 建连 rc=0；对照组（这台机无人监听的端口）立刻 Connection refused → 不是 NAT 假象。**应用自己 bind 的端口在另一台真机上入站可达** |

## ~~主要问题：实时 fs 推送不稳，且会长期静默~~ —— **已推翻：那是验收脚本自己造的**

**2026-09-25 上午更正。** 下面这段结论连同它引出的「网络盘形态」整条假设都不成立，
真正的因由是**探针把 Tauri 的前端回调注册成了一次性的**：

```js
window.__TAURI_INTERNALS__.transformCallback(cb, true)   // ← 第二个参数是 `once`，不是 persistent
```

`registerCallback` 里 `if (once) unregisterCallback(id)` —— 回调收到**第一条**就把自己注销，
之后每一条事件都静默丢失。所以「每次注册只到一帧、其余全静默」是工具的 signature，不是产品的。
把第二个参数去掉之后，同一套探测：

| 形态 | 结果 |
| --- | --- |
| 桌面 = 另一台电脑 `.174`，共享根 = **那台机的本地目录** | **5/5 到帧**，首帧 54 / 60 / 59 / 82 / 66 ms（中位 60 ms） |
| 桌面 = 这台机的 dev，共享根 = 本地目录，一次连接内 5 轮 | **5/5**，首帧 26 ms；每次保存产生 2 帧（truncate + 写入落在相邻两个 300 ms 窗口，符合设计） |

**定位这条用的三路独立对质**（下次遇到「只到一次」照这个顺序量，别再拿单一计数下结论）：
桌面侧 `[heid-fsDBG] 泵要发`（证明帧写出了）、手机端 logcat 的 `RustStderr` 标签
（证明 10 帧全收到且 `app.emit` 全部成功）、页面里的监听计数（只有 1 条）——
三路一对齐，掉点就锁死在「Rust → 界面」这一格，而那格正是探针自己站的。

顺带留下两条**与本次误判无关、但同一段代码里真实存在**的东西：

1. `run_pump` 里 `let _ = app.emit(EVENT_REMOTE, ...)` 把 emit 失败咽得干干净净，
   这次定位时那一格没有任何痕迹。已改成失败记一行（不影响链路状态，与「附属失败别碰 `connected`」同一口径）。
2. **手机在桌面点「允许」之前就报 `connected:true`**（本轮实测撞到的真缺陷）：
   TOFU 挂起期间手机侧已经转成已连接、界面上看不出区别，而每一条 `link_request` 都要等满 30 s 才失败；
   桌面那边 60 s 后记的是「配对请求被拒绝或超时」。**用户侧形态**就是：扫完码手机显示「已连接」，
   桌面弹窗没人点（或点了拒绝），手机从此卡在一条连不通的链路上，报错还都指向网络方向。

### 原来那份「判据实验」的结论

实验本身（换成本地目录重跑 5 次）**做完了**，答案是「本地根 5/5」；
但因为对照组也是同一把坏尺子，它证明的只是「尺子两次都在量同一个东西」。
剩下的**唯一没量过的形态**是「共享根指向网络路径（UNC）时桌面侧 notify 收不收得到变更」——
现在没有任何证据说它有问题，也不再是发版阻塞项；真要量就把根换成 `\\<这台机>\git\link-test` 再跑一次
`node scripts/link-lan-check.mjs fsprobe 5 20`。



### 修好尺子之后，量出来的一条真缺陷（已修）

`link-verify` 的 I 段有一条「`node_modules` 里 40 次写入不产生任何 fs 帧」。探针修好之后它**稳定**失败
（排空前一轮的尾巴也照样失败），所以不是抖动：`watch.rs::Batch::add` 只判**祖先层**的黑名单，
而 Windows 在一个目录里建/删条目时会把「那个目录本身」也通知一次 ——
`<根>\node_modules` 这一条没有祖先层，它的 parent 恰好是根，于是漏出一帧 `dirs:[""]`，
手机端就白重列一次根。一次 `npm install` 于是仍会涌进推送队列，正是那条黑名单本来要挡住的事。

修法只加一句「最后一层名字命中黑名单时，再问一次它是不是目录」，**不能按字面把黑名单名字整个吃掉**：
`.gitignore` / `.env` 这类点文件的名字也以 `.` 开头，而它们是文本编辑器真要改的东西，
按字面判就等于让这些变更从此没有提示。目录被删掉的那一刻 `is_dir()` 为假 → 照旧报根，
而那确实就是根的内容变了。判据钉成一对（`watch.rs` 新增用例）：`node_modules` 自身不报、`.gitignore` 照报。

## 另外四条小的

1. **`toobig` 文案自相矛盾**：7,000,000 字节的文件报「这个文件 6 MB，超过远程打开上限 6 MB」——
   实测大小与上限显示成同一个数，用户没法判断超了多少。要么给 6.7 MB，要么给「超出 0.7 MB」。
2. **`status.peerDevice` 一直是空串**（连上之后也是）→ 手机上「已连接的设备」没有名字可显示；
   `peerKeyId` 是有的，所以免扫重连不受影响。查桌面在 auth 里有没有把设备名带过来。
   2026-09-25 第二轮跨机重测仍然是空串 —— 这条与 fs 那次误判无关，是真的。
3. **桌面把「自己拒掉的票」记成「对端已关闭连接」**（面板「上次失败」那一行）——
   归因方向被写反，用户会去查网络而不是去刷新配对码。
4. **手机在桌面点「允许」之前就报已连接**（上面「推翻」一节里那条，实测证据：TOFU 挂起期间
   手机 `connected:true`、每条 `link_request` 等满 30 s、桌面 60 s 后记「配对请求被拒绝或超时」）。

## 环境账（下次别再重新发现一遍）

- AVD 每次开机都要 `adb shell cmd wifi connect-network AndroidWifi open` 才有路由；
  不做这步会误判成「模拟器不能测局域网」（这条结论把 阶段 4 的实测拖了一轮）。
- Android 15 拒绝把 `/sdcard/Download` 顶层选作 SAF 树根（DocumentsUI 直接显示「无法使用此文件夹」），
  要选它的子目录。开文件更省事的办法：MediaStore `content://media/external/file/<id>` + VIEW intent。
- 这个构建里 **没有 `window.__TAURI__`**，CDP 侧要用 `window.__TAURI_INTERNALS__.invoke`。
- **模拟器页面时钟比本机慢约 38.7 小时** —— 量延迟时不要混用页面 `Date.now()` 与 node 的时钟，
  会得到 `-139360 s` 这种负数。

## 复现工具

**已固化成 `scripts/link-lan-check.mjs`**（2026-09-25）：`status`（链路与共享根现状）、
`reconnect <keyId> --host=`（免扫重连）、`fsprobe [n] [间隔秒] --file=`（实时推送成功率与首帧延迟）、
`protocol`（阶段 2/3 逐条：读写/基线/冲突/四类逃逸/超限/标签/未知命令）、`pair <6 位短码>`。
它只需要一个能改的共享根 + 一条局域网链路，不需要真机。跑之前 `adb forward` 由脚本自己做
（`--serial=emulator-5554`，模拟器上 WebView 的调试口挂在 `webview_devtools_remote_<pid>`）。

**这一份里所有帧计数的坑都修掉了**：`transformCallback` 的第二个参数是 `once`，
常驻监听**不要传第二个参数**（脚本里注明了原因，别再改回去）。
Temp 下的 `heid-lan-check{,2..8}.mjs` 是当时的原始探针，只作留档，不要再拿来跑判据。
