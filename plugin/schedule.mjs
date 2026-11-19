/**
 * 归档频率的读写 —— 三平台调度后端。
 *
 *   win32   → Windows 计划任务（PowerShell Register-ScheduledTask / Get-ScheduledTaskInfo）
 *   darwin  → launchd 用户级 LaunchAgent（StartInterval，秒）
 *   linux   → 用户 crontab 标记块；没有 crontab 就退回 systemd --user timer
 *
 * 为什么不一概用「进程内 setInterval」：归档的对象是磁盘上的会话日志，
 * 跟 DSH 开不开没关系；应用关了也该继续归档，所以必须落到系统调度器。
 *
 * 所有「生成配置文本」的逻辑都是纯函数（buildPlist / buildCronLine /
 * upsertCronBlock / parseCronBlock），可以脱离对应系统单测；
 * 真正执行命令的只有 readSchedule / setScheduleMinutes。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh');
export const MEM = path.join(DSH_HOME, 'memory');
const CONFIG = path.join(MEM, 'config.json');
const MEMCTL = path.join(MEM, 'bin', 'memctl.mjs');

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 10080;

const WIN_TASK = 'DSH-Memory-Sync';
const LAUNCHD_LABEL = 'com.dsh.memory-sync';
const CRON_BEGIN = '# >>> dsh-memory-sync >>>';
const CRON_END = '# <<< dsh-memory-sync <<<';
const SYSTEMD_UNIT = 'dsh-memory-sync';

export const platform = process.platform;

function nodeBin() {
  const candidates = [
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
    process.execPath,
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'node';
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e && e.message || e) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.on('error', (e) => resolve({ code: -1, out: '', err: String(e && e.message || e) }));
  });
}

function runPowerShell(script) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

// ───────────────────────── 纯函数：各平台配置文本 ─────────────────────────

/** 分钟 → cron 表达式。cron 最小粒度 1 分钟；整小时用 "0 星号/n" 更好读。 */
export function cronExpression(minutes) {
  const n = Math.max(1, Math.round(minutes));
  if (n < 60) return `*/${n} * * * *`;
  if (n % 60 === 0) {
    const h = n / 60;
    if (h === 1) return '0 * * * *';
    if (h <= 23) return `0 */${h} * * *`;
    if (h === 24) return '0 3 * * *';
    return `0 3 */${Math.max(1, Math.round(h / 24))} * *`;
  }
  return `*/${Math.min(59, n)} * * * *`;
}

/** cron 里那一条要执行的命令（日志追加到 memory/sync.log）。 */
export function syncCommand(dshHome = DSH_HOME) {
  const log = path.join(dshHome, 'memory', 'sync.log');
  return `"${nodeBin()}" "${MEMCTL}" sync --quiet >> "${log}" 2>&1`;
}

export function buildCronLine(minutes, dshHome = DSH_HOME) {
  return `${cronExpression(minutes)} ${syncCommand(dshHome)}`;
}

/** 把标记块写进 crontab 文本（幂等：先删旧块再追加）。 */
export function upsertCronBlock(crontabText, line) {
  const lines = String(crontabText || '').split('\n');
  const kept = [];
  let inside = false;
  for (const l of lines) {
    if (l.trim() === CRON_BEGIN) { inside = true; continue; }
    if (l.trim() === CRON_END) { inside = false; continue; }
    if (!inside) kept.push(l);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(CRON_BEGIN, line, CRON_END, '');
  return kept.join('\n');
}

/** 从 crontab 文本里读回当前间隔（分钟）。 */
export function parseCronBlock(crontabText) {
  const text = String(crontabText || '');
  const begin = text.indexOf(CRON_BEGIN);
  if (begin === -1) return null;
  const end = text.indexOf(CRON_END, begin);
  const block = text.slice(begin, end === -1 ? undefined : end);
  const line = block.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return line ? minutesOfCron(line.trim()) : null;
}

/** cron 表达式 → 分钟（只解析本文件会生成的形状，够用即可）。 */
export function minutesOfCron(expr) {
  const parts = expr.split(/\s+/).slice(0, 5);
  if (parts.length < 5) return 0;
  const [min, hour] = parts;
  if (/^\*\/\d+$/.test(min)) return Number(min.slice(2));
  if (min === '0' && /^\*\/\d+$/.test(hour)) return Number(hour.slice(2)) * 60;
  if (min === '0' && hour === '*') return 60;
  if (min === '0' && /^\d+$/.test(hour)) return 1440;
  return 0;
}

/** launchd plist 文本。StartInterval 单位是秒。 */
export function buildPlist(minutes, label = LAUNCHD_LABEL, dshHome = DSH_HOME) {
  const seconds = Math.max(60, Math.round(minutes) * 60);
  const log = path.join(dshHome, 'memory', 'sync.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin()}</string>
    <string>${MEMCTL}</string>
    <string>sync</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>
  <integer>${seconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export function parsePlistInterval(text) {
  const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(String(text || ''));
  return m ? Math.round(Number(m[1]) / 60) : 0;
}

/** systemd 用户 timer 的两个文件（没有 crontab 时的退路）。 */
export function buildSystemdUnits(minutes, dshHome = DSH_HOME) {
  const service = `[Unit]
Description=DSH memory sync

[Service]
Type=oneshot
ExecStart="${nodeBin()}" "${MEMCTL}" sync --quiet
`;
  const timer = `[Unit]
Description=DSH memory sync timer

[Timer]
OnUnitActiveSec=${Math.max(60, Math.round(minutes) * 60)}s
OnBootSec=2min
Unit=${SYSTEMD_UNIT}.service

[Install]
WantedBy=timers.target
`;
  void dshHome;
  return { service, timer };
}

// ───────────────────────── Windows ─────────────────────────

const WIN_QUERY = `
$ErrorActionPreference = 'SilentlyContinue'
$n = '${WIN_TASK}'
$t = Get-ScheduledTask -TaskName $n
if ($null -eq $t) { '{"exists":false}' | Write-Output; exit 0 }
$i = Get-ScheduledTaskInfo -TaskName $n
$minutes = 0
$iv = $null
try { $iv = $t.Triggers[0].Repetition.Interval } catch {}
if ($iv -is [timespan]) {
  $minutes = [int][math]::Round($iv.TotalMinutes)
} elseif ($iv -ne $null) {
  $txt = [string]$iv
  if ($txt -match '^P(?:(\\d+)D)?(?:T(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?)?$') {
    $d = [int]('0' + $matches[1]); $h = [int]('0' + $matches[2]); $m = [int]('0' + $matches[3]); $s = [int]('0' + $matches[4])
    $minutes = $d * 1440 + $h * 60 + $m + [int][math]::Round($s / 60.0)
  }
}
if ($minutes -le 0 -and $i.LastRunTime -and $i.NextRunTime) {
  $minutes = [int][math]::Round(($i.NextRunTime - $i.LastRunTime).TotalMinutes)
}
$next = $null
if ($i.NextRunTime) { $next = $i.NextRunTime.ToString('o') }
$last = $null
if ($i.LastRunTime) { $last = $i.LastRunTime.ToString('o') }
[pscustomobject]@{
  exists = $true
  intervalMinutes = $minutes
  nextRun = $next
  lastRun = $last
  lastResult = $i.LastTaskResult
  state = [string]$t.State
} | ConvertTo-Json -Compress
`;

async function winRead() {
  const r = await runPowerShell(WIN_QUERY);
  let parsed = null;
  if (r.out) {
    const line = r.out.split(/\r?\n/).filter(Boolean).pop();
    try { parsed = JSON.parse(line); } catch { parsed = null; }
  }
  if (!parsed) return { ok: false, backend: 'win-schtasks', error: r.err || 'powershell 无输出' };
  return { ok: true, backend: 'win-schtasks', taskName: WIN_TASK, ...parsed };
}

async function winSet(minutes) {
  const script = `
$ErrorActionPreference = 'Stop'
$n = '${WIN_TASK}'
$mem = Join-Path $env:USERPROFILE '.dsh\\mem.cmd'
if (-not (Test-Path $mem)) { '{"ok":false,"error":"mem.cmd not found"}' | Write-Output; exit 1 }
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c chcp 65001 >nul & "{0}" sync --quiet' -f $mem)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${minutes}) -RepetitionDuration (New-TimeSpan -Days 3650)
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $n -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
'{"ok":true}' | Write-Output
`;
  const r = await runPowerShell(script);
  const last = r.out.split(/\r?\n/).filter(Boolean).pop() || '';
  if (r.code !== 0 || !last.includes('"ok":true')) return { ok: false, error: r.err || last || 'Register-ScheduledTask 失败' };
  return { ok: true };
}

// ───────────────────────── macOS ─────────────────────────

const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

async function darwinRead() {
  const p = plistPath();
  if (!fs.existsSync(p)) return { ok: true, backend: 'launchd', exists: false, intervalMinutes: 0, state: '未安装' };
  const text = fs.readFileSync(p, 'utf8');
  const minutes = parsePlistInterval(text);
  const list = await run('launchctl', ['list']);
  const loaded = list.out.split('\n').some((l) => l.includes(LAUNCHD_LABEL));
  return {
    ok: true, backend: 'launchd', exists: true, intervalMinutes: minutes,
    nextRun: null, lastRun: null, lastResult: loaded ? 0 : null,
    state: loaded ? '已加载' : '未加载', plist: p,
  };
}

async function darwinSet(minutes) {
  const p = plistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buildPlist(minutes), 'utf8');
  const uid = process.getuid ? process.getuid() : 501;
  await run('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);   // 旧实例不存在会报错，忽略
  const boot = await run('launchctl', ['bootstrap', `gui/${uid}`, p]);
  if (boot.code !== 0) {
    await run('launchctl', ['unload', '-w', p]);
    const load = await run('launchctl', ['load', '-w', p]);
    if (load.code !== 0) return { ok: false, error: boot.err || load.err || 'launchctl 加载失败' };
  }
  return { ok: true };
}

// ───────────────────────── Linux ─────────────────────────

async function hasCrontab() {
  const r = await run('sh', ['-c', 'command -v crontab']);
  return r.code === 0 && r.out.length > 0;
}

const unitDir = () => path.join(os.homedir(), '.config', 'systemd', 'user');

async function linuxRead() {
  if (await hasCrontab()) {
    const r = await run('crontab', ['-l']);
    const text = r.code === 0 ? r.out : '';
    const minutes = parseCronBlock(text);
    return {
      ok: true, backend: 'cron', exists: minutes !== null,
      intervalMinutes: minutes || 0, nextRun: null, lastRun: null,
      lastResult: minutes ? 0 : null, state: minutes ? '已登记' : '未安装',
    };
  }
  const timer = path.join(unitDir(), `${SYSTEMD_UNIT}.timer`);
  if (fs.existsSync(timer)) {
    const text = fs.readFileSync(timer, 'utf8');
    const m = /OnUnitActiveSec=(\d+)s/.exec(text);
    return {
      ok: true, backend: 'systemd', exists: true,
      intervalMinutes: m ? Math.round(Number(m[1]) / 60) : 0,
      nextRun: null, lastRun: null, lastResult: 0, state: '已安装', unit: timer,
    };
  }
  return { ok: true, backend: 'cron', exists: false, intervalMinutes: 0, state: '未安装', hint: '系统没有 crontab，也没有 systemd timer' };
}

async function linuxSet(minutes) {
  if (await hasCrontab()) {
    const cur = await run('crontab', ['-l']);
    const text = cur.code === 0 ? cur.out : '';
    const next = upsertCronBlock(text, buildCronLine(minutes));
    const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, error: r.stderr || 'crontab 写入失败' };
    return { ok: true };
  }
  // 没有 crontab：写 systemd 用户 timer
  const dir = unitDir();
  fs.mkdirSync(dir, { recursive: true });
  const { service, timer } = buildSystemdUnits(minutes);
  fs.writeFileSync(path.join(dir, `${SYSTEMD_UNIT}.service`), service, 'utf8');
  fs.writeFileSync(path.join(dir, `${SYSTEMD_UNIT}.timer`), timer, 'utf8');
  await run('systemctl', ['--user', 'daemon-reload']);
  const en = await run('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]);
  if (en.code !== 0) return { ok: false, error: en.err || 'systemctl 启用失败' };
  return { ok: true };
}

// ───────────────────────── 对外接口 ─────────────────────────

function backendName() {
  if (platform === 'win32') return 'win-schtasks';
  if (platform === 'darwin') return 'launchd';
  return 'cron';
}

/** 读当前频率与运行状态。 */
export async function readSchedule() {
  let raw;
  try {
    if (platform === 'win32') raw = await winRead();
    else if (platform === 'darwin') raw = await darwinRead();
    else raw = await linuxRead();
  } catch (e) {
    raw = { ok: false, backend: backendName(), error: String(e && e.message || e) };
  }
  const cfg = readConfig();
  if (raw.ok && !raw.intervalMinutes && cfg.intervalMinutes) raw.intervalMinutes = cfg.intervalMinutes;
  return { ...raw, platform, config: cfg };
}

/** 改频率（分钟），重建同一份调度项。 */
export async function setScheduleMinutes(minutes) {
  const n = Math.round(Number(minutes));
  if (!Number.isFinite(n) || n < MIN_MINUTES || n > MAX_MINUTES) {
    return { ok: false, error: `间隔必须在 ${MIN_MINUTES}~${MAX_MINUTES} 分钟之间`, minutes: n, platform };
  }
  let r;
  try {
    if (platform === 'win32') r = await winSet(n);
    else if (platform === 'darwin') r = await darwinSet(n);
    else r = await linuxSet(n);
  } catch (e) {
    r = { ok: false, error: String(e && e.message || e) };
  }
  if (!r.ok) return { ...r, minutes: n, platform };
  writeConfig({ intervalMinutes: n, platform, backend: backendName(), updatedAt: new Date().toISOString() });
  const after = await readSchedule();
  return { ok: true, minutes: n, platform, schedule: after };
}

/** 终端用：打印当前调度状态（跨平台一致输出）。 */
export async function describeSchedule() {
  const s = await readSchedule();
  const lines = [
    `平台      ${s.platform}`,
    `后端      ${s.backend}`,
    `间隔      ${s.intervalMinutes || '?'} 分钟`,
    `状态      ${s.state || (s.exists ? '已安装' : '未安装')}`,
    s.nextRun ? `下次      ${s.nextRun}` : '',
    s.lastRun ? `上次      ${s.lastRun}（结果 ${s.lastResult}）` : '',
    s.hint ? `提示      ${s.hint}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
