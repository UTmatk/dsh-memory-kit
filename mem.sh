#!/bin/sh
# DSH 记忆工具包装（POSIX：macOS / Linux）
# 用法：mem.sh sync | status | search 关键词 | schedule [--set 分钟] | compact
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE="$DIR/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ]; then
  echo "找不到 node：既没有内置运行时，也不在 PATH 里" >&2
  exit 127
fi
exec "$NODE" "$DIR/memory/bin/memctl.mjs" "$@"
