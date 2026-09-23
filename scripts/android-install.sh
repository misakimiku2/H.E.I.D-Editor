#!/usr/bin/env bash
# 出签名 release 包并装到所有连着的安卓设备。
#
#   ./scripts/android-install.sh              构建 + 安装（约 5-10 分钟）
#   ./scripts/android-install.sh install-only 跳过构建，只装现成的 APK（几秒）
#
# 为什么是 release 而不是 debug：真机上装的是 release 签名，debug 包要先卸载才能装、
# 会清掉应用数据（SAF 授权、会话、记住的镜头）。release 走本地 keystore，`install -r` 原地升级不丢数据。
# 装完脚本会 force-stop：不重启进程的话跑的还是旧代码（这个坑白查过一轮）。
set -euo pipefail
cd "$(dirname "$0")/.."

APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk

if [ "${1:-}" != "install-only" ]; then
  echo "== 构建 aarch64 签名 release 包（Rust 编译占大头，耐心等）"
  TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/keys/heid.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    npm run tauri android build -- --apk --target aarch64
fi

if [ ! -f "$APK" ]; then
  echo "找不到 $APK，先跑一次不带参数的构建" >&2
  exit 1
fi

echo "== 安装到所有在线设备"
# 先把设备列表收进数组再循环。adb shell 会读走 stdin，如果直接在 `while read` 里调它，
# 第一台装完后剩下的设备行就被吃掉了——表现是只有手机装成功、平板静默跳过。
mapfile -t devices < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')

if [ "${#devices[@]}" = "0" ]; then
  echo "没有在线的安卓设备（adb devices 看一眼）" >&2
  exit 1
fi

fail=0
for serial in "${devices[@]}"; do
  [ -n "$serial" ] || continue
  echo "-- $serial"
  if ! adb -s "$serial" install -r "$APK" </dev/null; then
    echo "!! $serial 安装失败（跳过后继续装其他设备）" >&2
    fail=1
    continue
  fi
  adb -s "$serial" shell am force-stop com.nexus.editor </dev/null
done

[ "$fail" = "0" ] || exit 1
echo "== 完成，共 ${#devices[@]} 台。重新点开 App 就是新代码。"
echo "   扫码诊断：进扫一扫后点底部那行调试字，展开的日志截图即可回传。"
