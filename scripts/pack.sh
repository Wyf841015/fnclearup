#!/usr/bin/env bash
# ── fnclearup 打包脚本：先清运行时残留，再 fnpack ──
#
# 为什么需要它：fnpack 不读 .gitignore，会把 app/ 下的 *.sock / *.log /
# 运行时数据一并打进 app.tgz。本地调试（手动起 server.js）最容易留下
# app/fnclearup.sock 和日志，这些进了 fpk 会被装到用户机器上。
#
# 用法: bash scripts/pack.sh [--check-only]
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_ONLY=0
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1

echo "== 清理运行时残留 =="
# socket / 日志 / 临时文件 / 运行时数据目录
patterns=(
  "app/*.sock"
  "app/*.log"
  "app/*.tmp"
  "app/.test_*"
  "app/data/*"
  "tests/_probe_cmdline.js"
)
removed=0
for pat in "${patterns[@]}"; do
  for f in $pat; do
    [ -e "$f" ] || continue
    echo "  删除: $f"
    rm -rf "$f"
    removed=$((removed + 1))
  done
done
# 测试用临时目录（.test_* / .tmp_*）
for d in .test_* .tmp_*; do
  [ -d "$d" ] || continue
  echo "  删除目录: $d"
  rm -rf "$d"
  removed=$((removed + 1))
done
echo "  共清理 $removed 项"

if [ "$CHECK_ONLY" = "1" ]; then
  echo "== 仅检查模式，不打��� =="
  exit 0
fi

echo "== fnpack 打包 =="
fnpack build . || /usr/local/bin/fnpack build .

echo "== 校验产物 =="
[ -f fnclearup.fpk ] || { echo "✗ 未生成 fnclearup.fpk"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzOf fnclearup.fpk app.tgz > "$tmp/app.tgz" 2>/dev/null || true
if [ -s "$tmp/app.tgz" ]; then
  bad=$(tar -tzf "$tmp/app.tgz" 2>/dev/null | grep -E '\.sock$|\.log$|/\.test_|^data/' || true)
  if [ -n "$bad" ]; then
    echo "✗ app.tgz 里仍含运行时残留："
    echo "$bad" | sed 's/^/    /'
    exit 1
  fi
  echo "  ✓ app.tgz 干净（无 sock/log/运行时数据）"
fi
echo "  fpk: $(stat -c%s fnclearup.fpk) 字节"
echo "  SHA256: $(sha256sum fnclearup.fpk | awk '{print $1}')"
