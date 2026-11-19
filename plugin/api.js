/**
 * 记忆面板的数据层与页面模板。
 *
 * 单一实现，两个消费者：
 *   - index.js（host 插件）把 gatherState / search / runMemctl 挂到 /memory-panel/api/*
 *   - memctl.mjs report 直接 import 本文件，生成可双击打开的独立 HTML
 *
 * 只读 ~/.dsh/memory 与 ~/.dsh/AGENTS.md，写操作仅限调用 memctl 子进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

export const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh');
export const MEM = path.join(DSH_HOME, 'memory');
export const ARCHIVE = path.join(MEM, 'archive');
export const INBOX = path.join(MEM, 'inbox');
export const JOURNAL = path.join(MEM, 'journal');
export const MEMORY = path.join(MEM, 'MEMORY.md');
export const AGENTS = path.join(DSH_HOME, 'AGENTS.md');
export const MEMCTL = path.join(MEM, 'bin', 'memctl.mjs');
const NODE = path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

const read = (p, fb = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return fb; } };
const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const mtimeMs = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

function walk(dir, ext, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, acc);
    else if (e.name.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/** 档案文件：当月是散装 .md，旧月份是 archive-YYYY-MM.md.gz 打包件。 */
export function archiveFiles() {
  return [...walk(ARCHIVE, '.md'), ...walk(ARCHIVE, '.md.gz')].sort();
}

/** 读档案（.gz 自动解压）。 */
export function readDoc(file) {
  try {
    const buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) return zlib.gunzipSync(buf).toString('utf8');
    return buf.toString('utf8');
  } catch { return ''; }
}

// ─────────────────── 中文分词（无依赖） ───────────────────
/**
 * 中文没有空格，直接 regex 子串匹配只能命中完全相同写法。
 * 这里用 bigram：把一个连续汉字串切成所有相邻两字，查询与文本都切，
 * 于是「控件」能命中「控件版」「Form1 控件」，英文和数字仍按词切。
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const w of s.match(/[a-z0-9_]+/g) || []) {
    if (w.length >= 2 || /^\d+$/.test(w)) tokens.add(w);
  }
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) { tokens.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
    if (run.length <= 6) tokens.add(run);
  }
  return [...tokens];
}

/** MEMORY.md → 分节条目。 */
export function parseMemory(text) {
  const sections = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) { cur = { title: h2[1].trim(), entries: [] }; sections.push(cur); continue; }
    if (line.startsWith('# ')) continue;
    const item = /^-\s+(?:\[([^\]]*)\]\s*)?(.+)$/.exec(line.trim());
    // 模板里的 `- [YYYY-MM-DD] 说明文字` 是占位符，不是事实，别计成条目
    if (item && cur && !/^YYYY-MM-DD$/.test((item[1] || '').trim())) cur.entries.push({ date: item[1] || '', text: item[2].trim() });
    else if (line.trim() && cur && cur.entries.length === 0) cur.note = line.trim();
  }
  return sections.filter((s) => s.entries.length || s.note);
}

/** 汇总面板需要的全部状态。 */
export function gatherState() {
  const state = JSON.parse(read(path.join(MEM, 'state.json'), '{"sessions":{}}'));
  const rows = Object.values(state.sessions || {}).filter((r) => r.id && !r.skipped);
  rows.sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')));

  const docs = archiveFiles();
  const archiveFilesCount = docs.length;
  const archiveBytesTotal = docs.reduce((n, f) => n + size(f), 0);
  const memText = read(MEMORY, '# MEMORY\n\n(空)\n');
  const sections = parseMemory(memText);
  const inbox = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.endsWith('.md')) : [];
  const journal = fs.existsSync(JOURNAL) ? fs.readdirSync(JOURNAL).map((f) => ({ name: f, bytes: size(path.join(JOURNAL, f)) })) : [];

  const entryCount = sections.reduce((n, s) => n + s.entries.length, 0);
  const agentsText = read(AGENTS, '');
  const injectBytes = Buffer.byteLength(agentsText, 'utf8');
  const INJECT_BUDGET = 24576;

  // ── 健康度：只报能动手的事，不堆没有动作的指标 ──
  const todos = sections.find((s) => /待办/.test(s.title))?.entries.length ?? 0;
  let oldestInboxDays = 0;
  for (const f of inbox) {
    const age = (Date.now() - mtimeMs(path.join(INBOX, f))) / 86400000;
    if (age > oldestInboxDays) oldestInboxDays = age;
  }
  const lastArchive = rows.reduce((m, r) => (r.end && r.end > m ? r.end : m), '');
  const issues = [];
  if (inbox.length && oldestInboxDays >= 3) issues.push(`${inbox.length} 个待提炼包已积压 ${oldestInboxDays.toFixed(0)} 天（打开对话时会被并入）`);
  if (injectBytes > INJECT_BUDGET * 0.8) issues.push(`注入区 ${injectBytes} B 已占预算 ${Math.round((injectBytes / INJECT_BUDGET) * 100)}%，接近截断线`);
  if (!lastArchive) issues.push('还没有任何会话被归档过');
  const archiveAverage = archiveFilesCount ? Math.round(archiveBytesTotal / archiveFilesCount) : 0;
  const lint = lintMemory(sections);
  if (lint.exact > 0) issues.push(`MEMORY.md 有 ${lint.exact} 处完全重复`);

  return {
    generatedAt: new Date().toISOString(),
    paths: { memory: MEMORY, agents: AGENTS, archive: ARCHIVE, memctl: MEMCTL },
    lint,
    health: {
      ok: issues.length === 0,
      issues,
      injectBytes,
      injectBudget: INJECT_BUDGET,
      injectRatio: injectBytes / INJECT_BUDGET,
      todoCount: todos,
      archiveAverage,
      lastArchive,
      lintCount: lint.count,
    },
    stats: {
      sessions: rows.length,
      humanMsgs: rows.reduce((n, r) => n + (r.human || 0), 0),
      archiveFiles: archiveFilesCount,
      archiveBytes: archiveBytesTotal,
      memoryBytes: Buffer.byteLength(memText, 'utf8'),
      memoryEntries: entryCount,
      agentsBytes: size(AGENTS),
      injected: agentsText.length,
      inbox: inbox.length,
      journalFiles: journal.length,
    },
    sections,
    sessions: rows.map((r) => ({
      id: r.id, title: r.title || '(无标题)', cwd: r.cwd || '',
      start: r.start || '', end: r.end || '', human: r.human || 0,
      file: r.archivedTo ? path.basename(r.archivedTo) : '',
    })),
    inbox,
    journal,
  };
}

/** 在会话档案里检索：分词打分 + 原文命中加权，跨 .md 与 .md.gz。 */
export function search(query, limit = 60) {
  const q = String(query || '').trim();
  if (!q) return { query: q, hits: [], mode: 'tokenized' };
  const qTokens = tokenize(q);
  if (!qTokens.length) return { query: q, hits: [], mode: 'tokenized' };
  const qLower = q.toLowerCase();
  const hits = [];
  let scanned = 0;

  for (const file of archiveFiles()) {
    const text = readDoc(file);
    if (!text) continue;
    const lines = text.split('\n');
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length < 2) continue;
      const lower = line.toLowerCase();
      const lineTokens = new Set(tokenize(line));
      let matched = 0;
      for (const t of qTokens) if (lineTokens.has(t)) matched++;
      const exact = lower.includes(qLower) ? 1 : 0;
      const score = matched / qTokens.length + (exact ? 0.5 : 0);
      if (!best || score > best.score || (score === best.score && line.length > best.text.length)) {
        best = { line: i + 1, score, exact, matched, text: line };
      }
    }
    if (!best) continue;
    // 至少命中两个 token（查询本身只有一两个 token 时放宽），否则算噪音
    const need = Math.min(2, qTokens.length);
    if (best.matched < need && !best.exact) continue;
    scanned++;
    hits.push({
      session: path.basename(file).replace(/\.md(\.gz)?$/, ''),
      file: path.basename(file),
      line: best.line,
      score: Number(best.score.toFixed(3)),
      snippet: snippetAround(lines, best.line - 1, qTokens),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { query: q, hits: hits.slice(0, limit), total: hits.length, mode: 'tokenized', tokens: qTokens.length };
}

function snippetAround(lines, at, qTokens) {
  const from = Math.max(0, at - 1);
  const to = Math.min(lines.length, at + 2);
  return lines.slice(from, to).join('\n').slice(0, 600);
}

/** 读整份档案：本月散装 .md 直接读；旧月份从 .md.gz 里按会话切块。 */
export function readArchive(name) {
  const base = path.basename(String(name || '')).replace(/\.md$/, '');
  const plain = walk(ARCHIVE, '.md').find((f) => path.basename(f) === `${base}.md`);
  if (plain) return { ok: true, name: `${base}.md`, text: read(plain, ''), packed: false };

  for (const gz of walk(ARCHIVE, '.md.gz')) {
    const text = readDoc(gz);
    const begin = text.indexOf(`<!-- mc:session ${base}.md -->`);
    if (begin === -1) continue;
    const end = text.indexOf(`<!-- mc:end ${base}.md -->`, begin);
    const body = text.slice(begin + `<!-- mc:session ${base}.md -->`.length, end === -1 ? undefined : end).trim();
    return { ok: true, name: `${base}.md`, text: body, packed: true, bundle: path.basename(gz) };
  }
  return { ok: false, error: 'not-found', name: base };
}

// ─────────────────── 重复 / 冲突检测 ───────────────────
const RE_STRIP = /[`*_#>()[\]（）【】「」《》\s，,。.;；:：!！?？~～\-—|/\\]/g;
const normText = (t) => String(t).toLowerCase().replace(RE_STRIP, '');

function trigrams(s) {
  const out = new Set();
  for (let i = 0; i + 2 < s.length; i++) out.add(s.slice(i, i + 3));
  if (s.length <= 3) out.add(s);
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// 注意：带 /g 的正则用 .test() 会因 lastIndex 残留而时对时错，
// 所以判定用不带 g 的版本，剥词用带 g 的版本，两套分开。
const DONE_WORDS = '完成|已生效|已发布|已修好|已修|跑通|就绪|正常|已解决';
const TODO_WORDS = '未完成|未做|待重启|待确认|待补|还没|未拿到|仍未|尚未|待';
const DONE_RE = new RegExp('(' + DONE_WORDS + ')');
const TODO_RE = new RegExp('(' + TODO_WORDS + ')');
const DONE_ALL = new RegExp('(' + DONE_WORDS + ')', 'g');
const TODO_ALL = new RegExp('(' + TODO_WORDS + ')', 'g');

/** 去掉状态词后的「主题」，用于判断两条是不是在说同一件事。 */
const subjectOf = (t) => normText(t).replace(DONE_ALL, '').replace(TODO_ALL, '');

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** 找出 MEMORY.md 里重复与互相打架的条目。 */
export function lintMemory(sections) {
  const flat = [];
  for (const sec of sections || []) {
    for (const e of sec.entries) {
      const norm = normText(e.text);
      if (norm.length < 8) continue;   // 太短（如"已完成"）误报率高
      flat.push({ section: sec.title, date: e.date, text: e.text, norm, tri: trigrams(norm), subject: subjectOf(e.text) });
    }
  }
  const pairs = [];
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i];
      const b = flat[j];
      let kind = null;
      let score = 0;
      if (a.norm === b.norm) { kind = 'exact'; score = 1; }
      else {
        score = jaccard(a.tri, b.tri);
        if (score >= 0.82) kind = 'near';
        else {
          const opposing = (DONE_RE.test(a.text) && TODO_RE.test(b.text)) || (TODO_RE.test(a.text) && DONE_RE.test(b.text));
          // 同一个主题（去掉状态词后开头 ≥ 5 字相同）却一个说完成、一个说没做 → 状态打架
          if (opposing && commonPrefixLen(a.subject, b.subject) >= 4) { kind = 'conflict'; score = Math.max(score, 0.5); }
        }
      }
      if (!kind) continue;
      pairs.push({
        kind, score: Number(score.toFixed(2)),
        a: { section: a.section, date: a.date, text: a.text },
        b: { section: b.section, date: b.date, text: b.text },
      });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return {
    count: pairs.length,
    exact: pairs.filter((p) => p.kind === 'exact').length,
    near: pairs.filter((p) => p.kind === 'near').length,
    conflict: pairs.filter((p) => p.kind === 'conflict').length,
    pairs: pairs.slice(0, 40),
  };
}

// ─────────────────── MEMORY.md 读写 + 快照 ───────────────────
export const BACKUPS = path.join(MEM, 'backups');
const KEEP_SNAPSHOTS = 20;
const MAX_MEMORY_BYTES = 200 * 1024;

export function listSnapshots() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs.readdirSync(BACKUPS)
    .filter((f) => f.startsWith('MEMORY-') && f.endsWith('.md'))
    .sort()
    .reverse()
    .map((name) => ({ name, bytes: size(path.join(BACKUPS, name)) }));
}

/** 读 MEMORY.md 原文（给编辑器）。 */
export function readMemoryText() {
  const text = read(MEMORY, '');
  return {
    ok: true,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    mtime: (() => { try { return fs.statSync(MEMORY).mtime.toISOString(); } catch { return null; } })(),
    maxBytes: MAX_MEMORY_BYTES,
    snapshots: listSnapshots().slice(0, KEEP_SNAPSHOTS),
  };
}

function snapshotMemory(oldText) {
  if (!oldText.trim()) return null;
  fs.mkdirSync(BACKUPS, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `MEMORY-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.md`;
  const target = path.join(BACKUPS, name);
  fs.writeFileSync(target, oldText, 'utf8');
  const all = fs.readdirSync(BACKUPS).filter((f) => f.startsWith('MEMORY-')).sort().reverse();
  for (const stale of all.slice(KEEP_SNAPSHOTS)) {
    try { fs.unlinkSync(path.join(BACKUPS, stale)); } catch { /* 只读或占用，忽略 */ }
  }
  return name;
}

/** 写入 MEMORY.md：校验 → 快照旧版 → 原子写 → 重建注入区。 */
export async function writeMemoryText(text) {
  const next = String(text ?? '');
  const bytes = Buffer.byteLength(next, 'utf8');
  const problems = [];
  if (!next.trim()) problems.push('内容为空');
  if (bytes > MAX_MEMORY_BYTES) problems.push(`超过 ${Math.round(MAX_MEMORY_BYTES / 1024)}KB（当前 ${bytes} B）`);
  if (!/^#\s+\S/m.test(next)) problems.push('缺少一级标题（# ...）');
  if (!/^##\s+\S/m.test(next)) problems.push('缺少二级分节（## ...）');
  if (next.includes('MEMORY:MANAGED')) problems.push('不能写入托管区标记（MEMORY:MANAGED）');
  if (problems.length) return { ok: false, error: problems.join('；'), bytes };

  const before = read(MEMORY, '');
  const snap = snapshotMemory(before);
  const tmp = `${MEMORY}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, MEMORY);
  const render = await runMemctl(['render']);
  const after = readMemoryText();
  return { ok: true, bytes, snapshot: snap, render, memory: { bytes: after.bytes, mtime: after.mtime, snapshots: after.snapshots } };
}

/** 回滚到某份快照（先把当前态也快照一份）。 */
export async function restoreSnapshot(name) {
  const base = path.basename(String(name || ''));
  const src = path.join(BACKUPS, base);
  if (!base.startsWith('MEMORY-') || !fs.existsSync(src)) return { ok: false, error: '快照不存在' };
  const before = read(MEMORY, '');
  snapshotMemory(before);
  fs.copyFileSync(src, MEMORY);
  const render = await runMemctl(['render']);
  return { ok: true, restored: base, render, bytes: size(MEMORY) };
}

/** 跑 memctl 子命令（sync / ingest / render / status）。 */
export function runMemctl(args = ['sync']) {
  return new Promise((resolve) => {
    const exe = fs.existsSync(NODE) ? NODE : process.execPath;
    const child = spawn(exe, [MEMCTL, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, stdout: out.slice(-4000), stderr: err.slice(-2000), args }));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), args }));
  });
}

// ─────────────────────────────── 页面 ───────────────────────────────
const PAGE_CSS = `
:root{--bg:#0f1115;--panel:#161a22;--line:#242a36;--fg:#e7ecf3;--dim:#8b96a8;--acc:#5b9dff;--ok:#3fbf7f;--warn:#d9a544;--pill:#232a37}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6eb;--fg:#1b1f27;--dim:#6b7484;--acc:#2f6fed;--ok:#1f9d61;--warn:#a9741a;--pill:#eef1f6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--acc);text-decoration:none}
header{position:sticky;top:0;z-index:5;background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--bg) 88%,transparent));border-bottom:1px solid var(--line);padding:14px 18px 10px}
h1{margin:0 0 10px;font-size:15px;font-weight:650;letter-spacing:.2px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.card b{display:block;font-size:17px;font-weight:650;font-variant-numeric:tabular-nums}
.card span{color:var(--dim);font-size:11px}
nav{display:flex;gap:4px;flex-wrap:wrap;padding:10px 18px 0}
nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:5px 11px;border-radius:999px;cursor:pointer;font-size:12.5px}
nav button[aria-selected=true]{background:var(--pill);color:var(--fg);border-color:var(--line)}
main{padding:14px 18px 40px;max-width:1080px}
section[hidden]{display:none}
.sec{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}
.sec>h2{margin:0;padding:9px 13px;font-size:12.5px;font-weight:600;color:var(--acc);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
.sec>h2 i{font-style:normal;color:var(--dim);font-weight:400;font-size:11px}
.entry{padding:7px 13px;border-top:1px solid color-mix(in srgb,var(--line) 60%,transparent);display:flex;gap:9px}
.entry:first-of-type{border-top:0}
.entry .d{flex:0 0 78px;color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums;padding-top:2px}
.entry .t{flex:1;word-break:break-word}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 10px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:11px;border-top:0;position:sticky;top:0;background:var(--panel)}
tr:hover td{background:color-mix(in srgb,var(--acc) 6%,transparent)}
td.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--dim)}
.row{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
input[type=search],select{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 10px;font-size:13px;min-width:240px}
button.act{background:var(--pill);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12.5px}
button.act:hover{border-color:var(--acc)}
button.act[disabled]{opacity:.5;cursor:default}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px;white-space:pre-wrap;word-break:break-word;font:11.5px/1.5 ui-monospace,Consolas,monospace;max-height:60vh;overflow:auto;margin:0}
.hit{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin-bottom:8px}
.hit .meta{color:var(--dim);font-size:11px;margin-bottom:4px;display:flex;gap:8px}
.tag{display:inline-block;background:var(--pill);border-radius:5px;padding:0 5px;font-size:10.5px;color:var(--dim)}
.empty{color:var(--dim);padding:14px;text-align:center;font-size:12px}
.toast{position:fixed;right:16px;bottom:16px;background:var(--panel);border:1px solid var(--acc);border-radius:10px;padding:9px 13px;font-size:12px;max-width:420px;box-shadow:0 8px 30px #0006}
.health{margin-top:9px;padding:7px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel);font-size:11.5px;color:var(--dim);line-height:1.7}
.health b{font-weight:600}
.pill-ok{color:var(--ok)}.pill-warn{color:var(--warn)}
`;

const PAGE_JS = (staticState) => `
const STATIC = ${staticState ? JSON.stringify(staticState) : 'null'};
const api = async (p, opt) => {
  const r = await fetch(p, opt);
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(1) + ' MB';
const toast = (msg, bad) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<span class="' + (bad ? 'pill-warn' : 'pill-ok') + '">●</span> ' + esc(msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
};

function renderCards(s, health) {
  const cards = [
    ['会话', s.sessions], ['人类消息', s.humanMsgs], ['记忆条目', s.memoryEntries],
    ['档案', s.archiveFiles], ['档案体积', bytes(s.archiveBytes)], ['注入区', bytes(s.agentsBytes)],
    ['待提炼', s.inbox],
  ];
  document.getElementById('cards').innerHTML = cards
    .map(([k, v]) => '<div class="card"><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('');

  const h = health || {};
  const hue = h.ok ? 'pill-ok' : 'pill-warn';
  const lines = [
    '<b class="' + hue + '">' + (h.ok ? '正常' : '有 ' + (h.issues || []).length + ' 项待处理') + '</b>',
    '注入 ' + bytes(h.injectBytes || 0) + ' / ' + Math.round((h.injectBudget || 24576) / 1024) + 'KB（' + Math.round((h.injectRatio || 0) * 100) + '%）',
    '待办 ' + (h.todoCount ?? '—') + ' 条',
    '档案均 ' + bytes(h.archiveAverage || 0) + '/场',
    '最近归档 ' + (h.lastArchive || '—'),
  ];
  if ((h.issues || []).length) lines.push('<span class="pill-warn">⚠ ' + h.issues.map(esc).join('；') + '</span>');
  const box = document.getElementById('health');
  if (box) box.innerHTML = lines.join('　·　');
}

function renderMemory(st) {
  const tips = STATIC ? '' :
    '<div class="row" style="margin:0 0 10px"><button class="act" id="btn-edit-memory">编辑 MEMORY.md</button>' +
    '<span class="tag">保存前自动快照 · 保留最近 20 份</span></div>';
  const lint = st.lint && st.lint.count
    ? '<div class="sec"><h2>⚠ 重复与状态冲突<i>' + st.lint.count + ' 处（完全重复 ' + st.lint.exact + ' · 高度相似 ' + st.lint.near + ' · 状态打架 ' + st.lint.conflict + '）</i></h2>'
      + st.lint.pairs.map((p) => '<div class="entry"><div class="d">' + esc(p.kind) + '</div><div class="t">'
        + '<div style="color:var(--dim);font-size:11px">' + esc(p.a.section) + ' · ' + esc(p.a.date) + '</div>' + esc(p.a.text)
        + '<div style="color:var(--dim);font-size:11px;margin-top:4px">' + esc(p.b.section) + ' · ' + esc(p.b.date) + '</div>' + esc(p.b.text)
        + '</div></div>').join('')
      + '</div>'
    : '';
  document.getElementById('mem').innerHTML = tips + lint + (st.sections.map((sec) =>
    '<div class="sec"><h2>' + esc(sec.title) + '<i>' + sec.entries.length + ' 条</i></h2>' +
    (sec.entries.length
      ? sec.entries.map((e) => '<div class="entry"><div class="d">' + esc(e.date || '—') + '</div><div class="t">' + esc(e.text) + '</div></div>').join('')
      : '<div class="empty">（本节只有说明）</div>') +
    '</div>').join('')) || '<div class="empty">MEMORY.md 还是空的</div>';
}

// ── 编辑模式 ──
let editing = false;

async function openEditor() {
  if (editing) return;
  editing = true;
  const box = document.getElementById('mem');
  const j = await api('api/memory');
  box.innerHTML =
    '<div class="row"><span class="tag">' + bytes(j.bytes) + ' / 上限 ' + Math.round(j.maxBytes / 1024) + 'KB</span>' +
    '<span class="tag">快照 ' + (j.snapshots || []).length + ' 份</span></div>' +
    '<textarea id="mem-edit" spellcheck="false" style="width:100%;height:62vh;min-height:420px;background:var(--panel);' +
    'color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px;font:12px/1.6 ui-monospace,Consolas,monospace;' +
    'resize:vertical">' + esc(j.text) + '</textarea>' +
    '<div class="row" style="margin-top:10px"><button class="act" id="btn-save-memory">保存并重建注入区</button>' +
    '<button class="act" id="btn-cancel-edit">取消</button>' +
    (j.snapshots && j.snapshots.length
      ? '<select id="snap-pick">' + j.snapshots.map((s) => '<option value="' + esc(s.name) + '">' + esc(s.name.replace(/^MEMORY-|\.md$/g, '')) + '（' + bytes(s.bytes) + '）</option>').join('') + '</select>' +
        '<button class="act" id="btn-restore-snap">回滚到此快照</button>'
      : '') +
    '</div>';
}

function closeEditor() { editing = false; boot().catch(() => {}); }

async function saveMemory() {
  const ta = document.getElementById('mem-edit');
  const btn = document.getElementById('btn-save-memory');
  if (!ta || !btn) return;
  btn.disabled = true;
  try {
    const r = await fetch('api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ta.value }),
    });
    const j = await r.json();
    if (!j.ok) { toast('保存被拒：' + (j.error || '未知'), true); btn.disabled = false; return; }
    toast('已保存 ' + bytes(j.bytes) + (j.snapshot ? '，快照 ' + j.snapshot : ''));
    editing = false;
    await boot();
  } catch (e) { toast(String(e), true); btn.disabled = false; }
}

async function restoreSnapshot() {
  const sel = document.getElementById('snap-pick');
  if (!sel) return;
  if (!window.confirm('回滚到 ' + sel.value + '？当前内容会先自动快照一份。')) return;
  try {
    const r = await api('api/memory/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: sel.value }) });
    if (r.ok) { toast('已回滚到 ' + r.restored); editing = false; await boot(); }
    else toast('回滚失败：' + (r.error || '未知'), true);
  } catch (e) { toast(String(e), true); }
}

function renderSessions(st) {
  document.getElementById('ses').innerHTML =
    '<div class="sec"><h2>会话档案<i>' + st.sessions.length + ' 份</i></h2><table><thead><tr><th>结束时间</th><th>标题</th><th>人类消息</th><th>会话</th><th></th></tr></thead><tbody>' +
    st.sessions.map((r) =>
      '<tr><td class="mono">' + esc(r.end) + '</td><td>' + esc(r.title) + '</td><td>' + esc(r.human) + '</td>' +
      '<td class="mono">' + esc(r.id.slice(0, 20)) + '</td>' +
      '<td><a href="#" data-open="' + esc(r.file) + '">查看</a></td></tr>').join('') +
    '</tbody></table></div><pre id="viewer" hidden></pre>';
}

async function openArchive(name) {
  const box = document.getElementById('viewer');
  box.hidden = false;
  try {
    const j = await api('api/file?name=' + encodeURIComponent(name));
    box.textContent = j.ok ? j.text : '读取失败：' + j.error;
  } catch (e) { box.textContent = String(e); }
  box.scrollIntoView({ block: 'nearest' });
}

async function doSearch(q) {
  const box = document.getElementById('hits');
  box.textContent = '搜索中…';
  try {
    const j = await api('api/search?q=' + encodeURIComponent(q) + '&limit=60');
    box.innerHTML = j.hits.length
      ? j.hits.map((h) => '<div class="hit"><div class="meta"><span class="tag">' + esc(h.session.slice(0, 24)) + '</span><span>第 ' + h.line + ' 行</span></div><pre>' + esc(h.snippet) + '</pre></div>').join('')
      : '<div class="empty">没有匹配</div>';
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e) + '</div>'; }
}

const PRESETS = [[15,'每 15 分钟'],[30,'每 30 分钟'],[60,'每 1 小时'],[120,'每 2 小时'],[180,'每 3 小时（默认）'],[360,'每 6 小时'],[720,'每 12 小时'],[1440,'每天一次']];
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');
const BACKEND_LABEL = { 'win-schtasks': 'Windows 计划任务', launchd: 'launchd 用户代理', cron: '用户 crontab', systemd: 'systemd 用户定时器' };

function renderSchedule(s) {
  const box = document.getElementById('sched');
  if (!box) return;
  if (!s || !s.ok) {
    box.innerHTML = '<div class="empty">读不到调度状态：' + esc((s && s.error) || '未知原因') + '</div>';
    return;
  }
  const cur = s.intervalMinutes || 0;
  const opts = PRESETS.map(([m, t]) => '<option value="' + m + '"' + (m === cur ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
  const backend = BACKEND_LABEL[s.backend] || s.backend || '—';
  box.innerHTML =
    '<div class="row"><span style="color:var(--dim)">整理间隔</span><select id="interval">' + opts + '</select>' +
    '<button class="act" id="btn-save-interval">保存</button>' +
    '<span class="tag">当前 ' + esc(cur) + ' 分钟</span></div>' +
    '<div class="sec"><h2>运行状态<i>' + esc(backend) + ' · ' + esc(s.platform || '') + '</i></h2>' +
    '<div class="entry"><div class="d">下次</div><div class="t">' + (s.nextRun ? esc(fmt(s.nextRun)) : '<span style="color:var(--dim)">由系统调度器决定，面板读不到</span>') + '</div></div>' +
    '<div class="entry"><div class="d">上次</div><div class="t">' + (s.lastRun ? esc(fmt(s.lastRun)) + '　结果 ' + esc(s.lastResult) : '<span style="color:var(--dim)">—</span>') + '</div></div>' +
    '<div class="entry"><div class="d">状态</div><div class="t">' + esc(s.state || (s.exists ? '已安装' : '未安装')) + '</div></div>' +
    (s.hint ? '<div class="entry"><div class="d">提示</div><div class="t pill-warn">' + esc(s.hint) + '</div></div>' : '') +
    '</div>' +
    '<div class="sec"><h2>各平台落点</h2>' +
    '<div class="entry"><div class="d">Windows</div><div class="t">计划任务 <code>DSH-Memory-Sync</code>（PowerShell Register-ScheduledTask）</div></div>' +
    '<div class="entry"><div class="d">macOS</div><div class="t"><code>~/Library/LaunchAgents/com.dsh.memory-sync.plist</code>（launchd，StartInterval）</div></div>' +
    '<div class="entry"><div class="d">Linux</div><div class="t">用户 <code>crontab</code> 标记块；没有 crontab 时退回 <code>~/.config/systemd/user/dsh-memory-sync.timer</code></div></div>' +
    '</div>' +
    '<div class="sec"><h2>说明</h2><div class="empty" style="text-align:left;line-height:1.8">' +
    '这个频率只控制「归档」：解压新会话日志 → 写档案 → 生成待提炼包 → 重建注入区。<b>纯本地，不花 token。</b><br>' +
    '记忆提炼（写 MEMORY.md）不按时间跑，发生在你下次开对话时，由注入区的规程触发。<br>' +
    '终端也能改：<code>mem.cmd schedule --set 60</code>（Windows）/ <code>./mem.sh schedule --set 60</code>（macOS/Linux）。' +
    '</div></div>';
}

async function saveInterval() {
  const sel = document.getElementById('interval');
  const btn = document.getElementById('btn-save-interval');
  if (!sel || !btn) return;
  btn.disabled = true;
  try {
    const j = await api('api/schedule?minutes=' + encodeURIComponent(sel.value), { method: 'POST' });
    if (j.ok) {
      toast('已改为每 ' + j.minutes + ' 分钟归档');
      renderSchedule(j.schedule);
    } else {
      toast('保存失败：' + (j.error || '未知'), true);
      btn.disabled = false;
    }
  } catch (e) { toast(String(e), true); btn.disabled = false; }
}

async function doSync(kind) {  const btn = document.getElementById('btn-' + kind);
  btn.disabled = true;
  try {
    const j = await api('api/' + kind, { method: 'POST' });
    toast((j.stdout || '').trim().split('\\n').slice(-3).join(' · ') || ('exit ' + j.code), j.code !== 0);
    await boot();
  } catch (e) { toast(String(e), true); }
  btn.disabled = false;
}

async function boot() {
  const st = STATIC || await api('api/state');
  renderCards(st.stats, st.health);
  renderMemory(st);
  renderSessions(st);
  document.getElementById('paths').innerHTML = Object.entries(st.paths)
    .map(([k, v]) => '<div class="entry"><div class="d">' + esc(k) + '</div><div class="t mono">' + esc(v) + '</div></div>').join('');
  document.getElementById('inbox').innerHTML = st.inbox.length
    ? st.inbox.map((f) => '<div class="entry"><div class="t">' + esc(f) + '</div></div>').join('')
    : '<div class="empty">没有待提炼包</div>';
  document.getElementById('gen').textContent = new Date(st.generatedAt).toLocaleString('zh-CN');
  if (!STATIC) {
    try { renderSchedule(await api('api/schedule')); }
    catch (e) { const b = document.getElementById('sched'); if (b) b.innerHTML = '<div class="empty">' + esc(e) + '</div>'; }
  } else {
    const b = document.getElementById('sched');
    if (b) b.innerHTML = '<div class="empty">离线快照不含计划任务状态，请在应用内打开面板查看</div>';
  }
  return st;
}

document.addEventListener('click', (ev) => {
  const open = ev.target.closest('[data-open]');
  if (open) { ev.preventDefault(); openArchive(open.getAttribute('data-open')); return; }
  const tab = ev.target.closest('nav button');
  if (tab) {
    for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b === tab));
    for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== tab.dataset.tab;
  }
});

const input = document.getElementById('q');if (input) {
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { if (input.value.trim()) doSearch(input.value); }, 220); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(input.value); });
}
document.getElementById('btn-sync').addEventListener('click', () => doSync('sync'));
document.getElementById('btn-render').addEventListener('click', () => doSync('render'));
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t || !t.id) return;
  if (t.id === 'btn-edit-memory') { openEditor().catch((e) => toast(String(e), true)); return; }
  if (t.id === 'btn-save-memory') { saveMemory(); return; }
  if (t.id === 'btn-cancel-edit') { closeEditor(); return; }
  if (t.id === 'btn-restore-snap') { restoreSnapshot(); return; }
  if (t.id === 'btn-save-interval') { saveInterval(); return; }
  if (t.id === 'btn-compact') { doSync('compact'); return; }
});
boot().catch((e) => { document.getElementById('cards').innerHTML = '<div class="empty">' + esc(e) + '</div>'; });

// 深链：#auto / #t-auto / #search 直接切到对应标签
const want = location.hash.replace(/^#/, '');
if (want) {
  const id = want.startsWith('t-') ? want : 't-' + want;
  const b = document.querySelector('nav button[data-tab="' + id + '"]');
  if (b) b.click();
}
`;

/** 生成整页 HTML。传入 staticState 时数据内嵌，可直接双击打开。 */
export function pageHtml(staticState = null) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 记忆面板</title>
<style>${PAGE_CSS}</style></head>
<body>
<header>
  <h1>DSH 长期记忆 <span class="tag" id="gen"></span></h1>
  <div class="cards" id="cards"></div>
  <div class="health" id="health"></div>
  <nav>
    <button data-tab="t-mem" aria-selected="true">记忆条目</button>
    <button data-tab="t-ses" aria-selected="false">会话档案</button>
    <button data-tab="t-search" aria-selected="false">全文检索</button>
    <button data-tab="t-auto" aria-selected="false">自动化</button>
    <button data-tab="t-sys" aria-selected="false">系统与路径</button>
  </nav>
</header>
<main>
  <section id="t-mem"><div id="mem"></div></section>
  <section id="t-ses" hidden><div id="ses"></div></section>
  <section id="t-search" hidden>
    <div class="row"><input id="q" type="search" placeholder="在全部会话档案里搜关键词，回车立即搜"></div>
    <div id="hits"><div class="empty">输入关键词开始检索</div></div>
  </section>
  <section id="t-auto" hidden><div id="sched"></div></section>
  <section id="t-sys" hidden>
    <div class="row"><button class="act" id="btn-sync">立即归档新会话</button><button class="act" id="btn-render">重建注入区</button><button class="act" id="btn-compact">压缩旧月份归档</button></div>
    <div class="sec"><h2>待提炼包</h2><div id="inbox"></div></div>
    <div class="sec"><h2>路径</h2><div id="paths"></div></div>
  </section>
</main>
<script>${PAGE_JS(staticState)}</script>
</body></html>`;
}
