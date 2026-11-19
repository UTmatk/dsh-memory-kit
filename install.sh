#!/bin/sh
# DSH 记忆套件 · macOS / Linux 安装与卸载
#
#   ./install.sh                       # 装到 ~/.dsh，默认每 3 小时归档
#   ./install.sh --interval 60         # 指定频率（分钟）
#   ./install.sh --no-schedule         # 只装文件，不装调度
#   ./install.sh --uninstall           # 卸载（记忆数据改名保留）
#   DSH_HOME=/tmp/t ./install.sh       # 装到别处（测试用）
set -eu

KIT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${PROFILE_NAME:-desktop}"
INTERVAL=180
NO_SCHEDULE=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --no-schedule) NO_SCHEDULE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --profile) PROFILE_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
PLUGIN_DIR="$DSH_HOME/plugins/dsh-memory-panel"
MEMORY_DIR="$DSH_HOME/memory"

say() { printf '%s\n' "$*"; }
ok() { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!]  %s\n' "$*"; }

NODE=""
for c in "$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
[ -n "$NODE" ] || { echo "找不到 node，请先装 Node 或启动一次 DSH" >&2; exit 127; }

patch_profile() { # $1=action(install|remove)
  "$NODE" - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" "$1" <<'JS'
const fs = require('fs');
const [file, pluginDir, action] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
j.dependencies = j.dependencies || {};
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
const b = (j.dsh.profile.bundles = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : []);
if (action === 'install') {
  j.dependencies['dsh-memory-panel'] = 'file:' + pluginDir;
  if (!b.includes('dsh-memory-panel')) b.push('dsh-memory-panel');
} else {
  delete j.dependencies['dsh-memory-panel'];
  j.dsh.profile.bundles = b.filter((x) => x !== 'dsh-memory-panel');
}
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
console.log('bundles: ' + j.dsh.profile.bundles.length);
JS
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  say "卸载 DSH 记忆套件（$DSH_HOME）"
  if [ -f "$PROFILE_DIR/package.json" ]; then
    patch_profile remove && ok 'profile 已清理'
  fi
  [ -L "$PROFILE_DIR/node_modules/dsh-memory-panel" ] && rm -f "$PROFILE_DIR/node_modules/dsh-memory-panel" && ok '已移除 node_modules 链接'
  [ -d "$PLUGIN_DIR" ] && rm -rf "$PLUGIN_DIR" && ok "已删除 $PLUGIN_DIR"
  if command -v crontab >/dev/null 2>&1; then
    crontab -l 2>/dev/null | sed '/# >>> dsh-memory-sync >>>/,/# <<< dsh-memory-sync <<</d' | crontab - 2>/dev/null || true
    ok '已清理 crontab 标记块'
  fi
  rm -f "$HOME/Library/LaunchAgents/com.dsh.memory-sync.plist" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/dsh-memory-sync.timer" "$HOME/.config/systemd/user/dsh-memory-sync.service" 2>/dev/null || true
  if [ -d "$MEMORY_DIR" ]; then
    BAK="$MEMORY_DIR.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$MEMORY_DIR" "$BAK"
    ok "记忆数据保留在 $BAK"
  fi
  say ""
  say "卸载完成。重启 DSH 后「记忆」一节会消失。"
  exit 0
fi

# ---------------------------------------------------------------- install
say "安装 DSH 记忆套件 → $DSH_HOME"
mkdir -p "$DSH_HOME" "$MEMORY_DIR/"{bin,archive,backups,inbox,journal,monthly}
cp "$KIT/memory/bin/memctl.mjs" "$MEMORY_DIR/bin/memctl.mjs"
if [ ! -f "$MEMORY_DIR/MEMORY.md" ]; then
  cp "$KIT/memory/MEMORY.md" "$MEMORY_DIR/MEMORY.md"
  ok '写入空的 MEMORY.md 模板'
else
  warn 'MEMORY.md 已存在，保留原内容不覆盖'
fi
cp "$KIT/mem.sh" "$DSH_HOME/mem.sh"
chmod +x "$DSH_HOME/mem.sh"
ok "记忆目录就绪：$MEMORY_DIR"

mkdir -p "$PLUGIN_DIR"
cp "$KIT/plugin/"*.js "$KIT/plugin/"*.mjs "$KIT/plugin/package.json" "$KIT/plugin/cordis.patch.yml" "$PLUGIN_DIR/" 2>/dev/null || true
[ -f "$KIT/plugin/README.md" ] && cp "$KIT/plugin/README.md" "$PLUGIN_DIR/"
ok "插件就绪：$PLUGIN_DIR"

if [ -f "$PROFILE_DIR/package.json" ]; then
  cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-memorykit-$(date +%Y%m%d-%H%M%S)"
  patch_profile install && ok 'profile 已登记'
  mkdir -p "$PROFILE_DIR/node_modules"
  LINK="$PROFILE_DIR/node_modules/dsh-memory-panel"
  if [ -L "$LINK" ]; then
    rm -f "$LINK" && ln -s "$PLUGIN_DIR" "$LINK" && ok '已更新 node_modules 符号链接'
  elif [ -e "$LINK" ]; then
    warn "已存在 $LINK（目录或 Windows junction），保持原样不覆盖"
  else
    ln -s "$PLUGIN_DIR" "$LINK" && ok '已建立 node_modules 符号链接'
  fi
else
  warn "没有找到 profile：$PROFILE_DIR（先启动一次 DSH，或用 --profile web）"
fi

if [ "$NO_SCHEDULE" -eq 1 ]; then
  warn "已跳过调度；需要时运行：$DSH_HOME/mem.sh schedule --set $INTERVAL"
else
  "$DSH_HOME/mem.sh" schedule --set "$INTERVAL" || warn '调度安装失败，可稍后手动重试'
fi

say ""
say "完成。接下来："
say "  1. 重启 DSH"
say "  2. 设置 → 记忆（或 http://127.0.0.1:<端口>/memory-panel/）"
say "  3. 先聊几轮，再点「立即归档新会话」看效果"
say "  4. 命令行：$DSH_HOME/mem.sh status | sync | search 关键词 | schedule"
