#!/usr/bin/env bash
# 构建可分发 zip: dist/fomo-magnifier-v<版本>.zip
# 只含运行必需文件; 解压得到单层 fomo-magnifier/ 目录, 直接"加载已解压的扩展程序"。
# 临时目录由 mktemp 创建, 留给系统 /tmp 回收, 脚本自身不做递归删除。
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
TMP=$(mktemp -d)
STAGE="$TMP/fomo-magnifier"
mkdir -p "$STAGE" dist
cp manifest.json content.js background.js popup.html popup.js LICENSE PRIVACY.md README.md "$STAGE/"
cp -r icons "$STAGE/icons"
OUT="$PWD/dist/fomo-magnifier-v${VER}.zip"
rm -f "$OUT"
( cd "$TMP" && zip -qr "$OUT" fomo-magnifier )
echo "built: $OUT"
