#Requires -Version 5.1
<#
  DSH 记忆套件 · Windows 安装 / 卸载

  用法：
    .\install.ps1                       # 装到 ~\.dsh，默认每 3 小时归档
    .\install.ps1 -IntervalMinutes 60   # 指定频率
    .\install.ps1 -NoSchedule           # 只装文件，不建计划任务
    .\install.ps1 -Uninstall            # 卸载（保留记忆数据，目录改名为 memory.bak-时间戳）
    .\install.ps1 -DshHome D:\test\.dsh # 装到别处（测试用）
#>
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$ProfileName = 'desktop',
  [int]$IntervalMinutes = 180,
  [switch]$NoSchedule,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($msg) { Write-Host $msg }
function Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

$profileDir = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
$pluginDir = Join-Path $DshHome 'plugins\dsh-memory-panel'
$memoryDir = Join-Path $DshHome 'memory'
$nodeModules = Join-Path $profileDir 'node_modules'

function Get-Node {
  $candidates = @(
    (Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    (Get-Command node -ErrorAction SilentlyContinue).Source
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  throw '找不到 node：既没有 DSH 内置运行时，PATH 里也没有 node'
}

function Backup-File($path) {
  if (Test-Path $path) {
    $bak = "$path.bak-memorykit-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $path $bak -Force
    return $bak
  }
  return $null
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  Say "卸载 DSH 记忆套件（$DshHome）"
  if (Test-Path (Join-Path $profileDir 'package.json')) {
    $node = Get-Node
    $patch = @'
const fs = require('fs');
const p = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
delete j.dependencies['dsh-memory-panel'];
if (j.dsh && j.dsh.profile && Array.isArray(j.dsh.profile.bundles)) {
  j.dsh.profile.bundles = j.dsh.profile.bundles.filter((b) => b !== 'dsh-memory-panel');
}
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('profile 已移除 bundle 与依赖');
'@
    $tmp = Join-Path $env:TEMP "dsh-memorykit-uninstall-$PID.cjs"
    Set-Content -Path $tmp -Value $patch -Encoding UTF8
    & $node $tmp (Join-Path $profileDir 'package.json')
    Remove-Item $tmp -Force
    Ok 'profile 已清理'
  }
  $link = Join-Path $nodeModules 'dsh-memory-panel'
  if (Test-Path $link) {
    (Get-Item $link).Delete()
    Ok '已移除 node_modules 里的链接'
  }
  if (Test-Path $pluginDir) { Remove-Item $pluginDir -Recurse -Force; Ok "已删除 $pluginDir" }
  try { Unregister-ScheduledTask -TaskName 'DSH-Memory-Sync' -Confirm:$false -ErrorAction Stop; Ok '已删除计划任务' } catch { }
  if (Test-Path $memoryDir) {
    $bak = "$memoryDir.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $memoryDir $bak
    Ok "记忆数据保留在 $bak（确认不要了再手动删）"
  }
  Say "`n卸载完成。重启 DSH 后「记忆」一节会消失。"
  exit 0
}

# ---------------------------------------------------------------- install
Say "安装 DSH 记忆套件 → $DshHome"
if (-not (Test-Path $DshHome)) { New-Item -ItemType Directory -Path $DshHome | Out-Null; Warn "$DshHome 不存在，已创建（请确认 DSH 装好后再启动）" }

# 1) 记忆目录骨架
foreach ($d in @('bin', 'archive', 'backups', 'inbox', 'journal', 'monthly')) {
  New-Item -ItemType Directory -Path (Join-Path $memoryDir $d) -Force | Out-Null
}
Copy-Item (Join-Path $kit 'memory\bin\memctl.mjs') (Join-Path $memoryDir 'bin\memctl.mjs') -Force
$memoryFile = Join-Path $memoryDir 'MEMORY.md'
if (-not (Test-Path $memoryFile)) {
  Copy-Item (Join-Path $kit 'memory\MEMORY.md') $memoryFile -Force
  Ok '写入空的 MEMORY.md 模板'
} else {
  Warn 'MEMORY.md 已存在，保留原内容不覆盖'
}
Copy-Item (Join-Path $kit 'mem.cmd') (Join-Path $DshHome 'mem.cmd') -Force
Copy-Item (Join-Path $kit 'mem.sh') (Join-Path $DshHome 'mem.sh') -Force
Ok "记忆目录就绪：$memoryDir"

# 2) 插件文件
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Get-ChildItem (Join-Path $kit 'plugin') -File | Copy-Item -Destination $pluginDir -Force
Ok "插件就绪：$pluginDir"

# 3) 挂进 profile
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  Warn "没有找到 profile：$profileDir（装好并启动一次 DSH 后再跑本脚本，或加 -ProfileName web）"
} else {
  Backup-File (Join-Path $profileDir 'package.json') | ForEach-Object { if ($_) { Ok "已备份 package.json → $(Split-Path -Leaf $_)" } }
  $node = Get-Node
  $patch = @'
const fs = require('fs');
const p = process.argv[2];
const pluginDir = process.argv[3];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.dependencies = j.dependencies || {};
j.dependencies['dsh-memory-panel'] = 'file:' + pluginDir.replace(/\\/g, '/');
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : [];
if (!j.dsh.profile.bundles.includes('dsh-memory-panel')) j.dsh.profile.bundles.push('dsh-memory-panel');
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('bundle 已登记：' + j.dsh.profile.bundles.length + ' 条');
'@
  $tmp = Join-Path $env:TEMP "dsh-memorykit-profile-$PID.cjs"
  Set-Content -Path $tmp -Value $patch -Encoding UTF8
  & $node $tmp (Join-Path $profileDir 'package.json') $pluginDir
  Remove-Item $tmp -Force
  New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
  $link = Join-Path $nodeModules 'dsh-memory-panel'
  if (Test-Path $link) { (Get-Item $link).Delete() }
  New-Item -ItemType Junction -Path $link -Target $pluginDir | Out-Null
  Ok '已挂进 profile（node_modules 链接 + bundles）'
}

# 4) 归档频率
if ($NoSchedule) {
  Warn "已跳过计划任务；需要时运行：$DshHome\mem.cmd schedule --set $IntervalMinutes"
} else {
  & (Join-Path $DshHome 'mem.cmd') schedule --set $IntervalMinutes
}

Say ""
Say "完成。接下来："
Say "  1. 重启 DSH"
Say "  2. 设置 → 记忆（或 http://127.0.0.1:<端口>/memory-panel/）"
Say "  3. 先聊几轮，再点「立即归档新会话」看效果"
Say "  4. 命令行：$DshHome\mem.cmd status | sync | search 关键词 | schedule"
