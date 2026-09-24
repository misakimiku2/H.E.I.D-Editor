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

## 主要问题：实时 fs 推送不稳，且会长期静默

在页面里挂 `heid-link-event` 监听器（`plugin:event|listen` 必须带 `target:{kind:'Any'}`），
每次由这台机向共享根追加一行 `README.txt`，间隔 20 s，共 5 次：

```
第 1 次：✅ 213 ms 到帧  {"type":"fs","data":"{\"dirs\":[\"\"]}"}
第 2~5 次：❌ 各等 12 s，一帧都没有
成功率 1/5
```

同一现象在几轮里重复出现：刚 `disconnect`+`reconnect` 之后写一次能到帧（`dirs:["nested"]`），
过一两分钟再写（无论改根级还是子目录、无论是这台机改还是桌面进程自己通过链路写）就收不到。

**读代码排掉了三个假设**（别再往这些方向查）：

- 不是推送泵睡死 —— `prepare()`（`link.rs:1236`）给连接设了 `set_read_timeout(POLL=20 ms)`，
  `run_pump` 每 20 ms 就转一圈并 `Push::take()`，所以帧一旦挂上必然在 20 ms 内写出。
  首帧 213 ms 也印证了这条通道本身是活的。
- 不是「帧只在有 RPC 往来的时候才 flush」—— 第七轮静默 8 s（期间一条 RPC 都不发）照样到过帧。
- 不是 `Push::take` 清空集合的副作用 —— `take()` 每回合 `std::mem::take` 整份取走，
  `queue_fs` 的超上限早退只在这一回合内丢名字，不会永久卡住。

**剩下的唯一解释方向：桌面那侧的 `notify` 递归监听根本没收到这些变更**，
而本机的实测形态恰好是「共享根指向一个**网络路径**（`\\192.168.31.87\git\link-test`）」。
Windows 上对重定向目录 / UNC 的 `ReadDirectoryChangesW` 变更通知本来就是**会漏**的，
「第一次到、后面静默」与 SMB2 lease/oplock 降级后的行为吻合。

### 下一步的判据实验（20 秒就能做完，能一刀切开两种结论）

把 .174 的共享根换成**那台机的本地目录**（例如 `C:\link-test`，放两三个文件即可），
重复同一套 5 次探测：

- **5/5 到帧** → 结论是「网络盘形态下实时更新不可靠」。产品上要决定：根是网络路径时
  要么在界面上如实标注（这一条会静默降级），要么手机侧对远程根加一条低频重列兜底
  （比如 3~5 s 一次，只在树可见时）。
- **仍然 1/5 左右** → 才是真的实现 bug，回到 `watch.rs` 的 `signal_of` / `Batch::add`
  与 `link.rs` 的 `sync_fs_watch`（换根后有没有重建）这条线上查。


## 另外三条小的

1. **`toobig` 文案自相矛盾**：7,000,000 字节的文件报「这个文件 6 MB，超过远程打开上限 6 MB」——
   实测大小与上限显示成同一个数，用户没法判断超了多少。要么给 6.7 MB，要么给「超出 0.7 MB」。
2. **`status.peerDevice` 一直是空串**（连上之后也是）→ 手机上「已连接的设备」没有名字可显示；
   `peerKeyId` 是有的，所以免扫重连不受影响。查桌面在 auth 里有没有把设备名带过来。
3. **桌面把「自己拒掉的票」记成「对端已关闭连接」**（面板「上次失败」那一行）——
   归因方向被写反，用户会去查网络而不是去刷新配对码。

## 环境账（下次别再重新发现一遍）

- AVD 每次开机都要 `adb shell cmd wifi connect-network AndroidWifi open` 才有路由；
  不做这步会误判成「模拟器不能测局域网」（这条结论把 阶段 4 的实测拖了一轮）。
- Android 15 拒绝把 `/sdcard/Download` 顶层选作 SAF 树根（DocumentsUI 直接显示「无法使用此文件夹」），
  要选它的子目录。开文件更省事的办法：MediaStore `content://media/external/file/<id>` + VIEW intent。
- 这个构建里 **没有 `window.__TAURI__`**，CDP 侧要用 `window.__TAURI_INTERNALS__.invoke`。
- **模拟器页面时钟比本机慢约 38.7 小时** —— 量延迟时不要混用页面 `Date.now()` 与 node 的时钟，
  会得到 `-139360 s` 这种负数。

## 复现工具

本轮的一次性驱动脚本在 `C:\Users\Misaki\AppData\Local\Temp\heid-lan-check{,2..8}.mjs`
（配对 / 协议逐条 / 写回环 / 冲突 / 免扫重连 / 帧监听 / 成功率统计）。
值得固化成 `scripts/link-lan-check.mjs`：它只需要一个能改的共享根，
不需要真机，就能把阶段 2/3/4 全跑一遍。
