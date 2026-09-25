#!/usr/bin/env bash
# ==========================================================================
# My Workbench —— 打包成 macOS .app
#
# 为什么不用 electron-packager：
#   本机的文件写入有宿主中介（brokered file token）拦着，electron-packager 解压
#   Electron 模板走到一半会被拒（Brokered file token refused: modify backup failed），
#   产物出不来。所以这里直接拿 node_modules 里已经解压好的 Electron.app 用 ditto 拷一份，
#   再手工改二进制名、Info.plist、图标，并把应用自己的文件放进 Contents/Resources/app/。
#   结果与 electron-packager 产出的结构一致（除未做代码签名 / 公证）。
#
# 用法：npm run pack   （或 bash build/pack.sh）
# ==========================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

APP_NAME="My Workbench"
BUNDLE_ID="com.arete.myworkbench"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="dist/${APP_NAME}-darwin-arm64"
APP="$OUT/${APP_NAME}.app"
TEMPLATE="node_modules/electron/dist/Electron.app"
PB=/usr/libexec/PlistBuddy

[ -d "$TEMPLATE" ] || { echo "找不到 Electron 模板：$TEMPLATE"; exit 1; }

echo "==> 打包 ${APP_NAME} ${VERSION}（arm64）"

# 1. 准备输出目录（整体替换）
mkdir -p "$OUT"
rm -rf "$APP"
ditto "$TEMPLATE" "$APP"

# 2. 主程序改名为「My Workbench」
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$APP_NAME"

# 3. 主 Info.plist
PLIST="$APP/Contents/Info.plist"
set_plist() { "$PB" -c "Set :$1 $2" "$PLIST" >/dev/null 2>&1 || "$PB" -c "Add :$1 string $2" "$PLIST" >/dev/null; }
set_plist CFBundleExecutable "$APP_NAME"
set_plist CFBundleName "$APP_NAME"
set_plist CFBundleDisplayName "$APP_NAME"
set_plist CFBundleIdentifier "$BUNDLE_ID"
set_plist CFBundleShortVersionString "$VERSION"
set_plist CFBundleVersion "$VERSION"
set_plist CFBundleIconFile "icon.icns"

# 4. 图标
cp build/icon.icns "$APP/Contents/Resources/icon.icns"

# 5. 四个 Helper 进程的 Info.plist：名字与 bundle id 跟着走
HELPER_DIR="$APP/Contents/Frameworks"
for helper in "$HELPER_DIR"/*.app; do
  [ -d "$helper" ] || continue
  hname="$(basename "$helper" .app)"           # Electron Helper / Electron Helper (GPU) …
  suffix="${hname#Electron Helper}"             # "" / " (GPU)" / " (Renderer)" / " (Plugin)"
  case "$suffix" in
    "")            hid="$BUNDLE_ID.helper" ;;
    " (GPU)")      hid="$BUNDLE_ID.helper.gpu" ;;
    " (Renderer)") hid="$BUNDLE_ID.helper.renderer" ;;
    " (Plugin)")   hid="$BUNDLE_ID.helper.plugin" ;;
    *)             hid="$BUNDLE_ID.helper" ;;
  esac
  hp="$helper/Contents/Info.plist"
  [ -f "$hp" ] || continue
  hset() { "$PB" -c "Set :$1 $2" "$hp" >/dev/null 2>&1 || "$PB" -c "Add :$1 string $2" "$hp" >/dev/null; }
  hset CFBundleIdentifier "$hid"
  hset CFBundleName "$APP_NAME Helper$suffix"
  hset CFBundleDisplayName "$APP_NAME Helper$suffix"
done

# 6. 应用自己的代码：package.json + src/ + 运行时依赖（jszip 及其依赖树）
RES="$APP/Contents/Resources"
APPDIR="$RES/app"
mkdir -p "$APPDIR"
cp package.json "$APPDIR/"
ditto src "$APPDIR/src"
mkdir -p "$APPDIR/node_modules"
for m in jszip lie immediate pako readable-stream core-util-is inherits isarray \
         process-nextick-args safe-buffer string_decoder util-deprecate setimmediate; do
  [ -d "node_modules/$m" ] || { echo "缺少运行时依赖：node_modules/$m"; exit 1; }
  ditto "node_modules/$m" "$APPDIR/node_modules/$m"
done

# 7. 说明：Resources/default_app.asar 是 Electron 自带的模板应用。
#    加载顺序是 app.asar → app/ → default_app.asar，我们有 app/，它不会被用到，
#    留着也不影响，就不动它了（本机的删除守卫对 app 包内的文件也不友好）。

# 8. 校验：结构完整、版本号正确
[ -x "$APP/Contents/MacOS/$APP_NAME" ] || { echo "主程序缺失"; exit 1; }
[ -f "$APPDIR/src/main/main.js" ] || { echo "应用代码缺失"; exit 1; }
echo "==> 完成：$APP"
echo "    版本   $("$PB" -c 'Print :CFBundleShortVersionString' "$PLIST")"
echo "    标识   $("$PB" -c 'Print :CFBundleIdentifier' "$PLIST")"
echo "    体积   $(du -sh "$APP" | cut -f1)"
