#!/usr/bin/env node
/**
 * memctl — DSH 会话自动归档 / 记忆提炼 / 注入 工具
 *
 * 数据位置（默认）：~/.dsh/memory
 *   archive/YYYY-MM/session-xxxx.md   每会话一份可读档案
 *   inbox/<ts>.md                     增量待提炼包（交给 AI 并入 MEMORY.md）
 *   state.json                         增量指纹
 *   MEMORY.md                          长期记忆主库（唯一真源）
 *   journal/YYYY-MM.md                 边聊边记的即时流水
 * 注入位置：~/.dsh/AGENTS.md 的托管区（每次新会话自动进入上下文）
 *
 * 命令：
 *   ingest            扫描 ~/.dsh/sessions，解压、解析、写档案、生成 inbox（无需 AI）
 *   status            统计
 *   inbox             刷新并打印待提炼包
 *   pending           有未提炼包时 exit 0 并打印路径，否则 exit 1
 *   render            用 MEMORY.md 重建 AGENTS.md 托管区
 *   search <kw...>    在档案里检索（-n 上下文行，-l 限制）
 *   show <前缀>       打印某会话档案
 *   sync = ingest + render 一步到位
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = process.env.USERPROFILE || process.env.HOME;
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const MEM = path.join(DSH_HOME, 'memory');
const ARCHIVE = path.join(MEM, 'archive');
const INBOX = path.join(MEM, 'inbox');
const JOURNAL = path.join(MEM, 'journal');
const STATE = path.join(MEM, 'state.json');
const MEMORY = path.join(MEM, 'MEMORY.md');
const AGENTS = path.join(DSH_HOME, 'AGENTS.md');
const BIN = path.join(MEM, 'bin');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BLOCK_BEGIN = '<!-- MEMORY:MANAGED:BEGIN -->';
const BLOCK_END = '<!-- MEMORY:MANAGED:END -->';
const INJECT_BUDGET = 24576;

// ────────────────────────────── utils ──────────────────────────────
const now = () => new Date();
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isoMin = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const monthKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true });
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeAtomic = (p, s) => {
  mkdirp(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, s, 'utf8');
  fs.renameSync(tmp, p);
};

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (p.type === 'text') return p.text || '';
        if (p.type === 'image') return '[图片]';
        if (p.type === 'attachment') return '[附件]';
        return '';
      })
      .join('\n');
  }
  if (typeof content === 'object' && content.text) return content.text;
  return '';
}

// ─────────────────────── zstd 多帧解码 ───────────────────────
function magicOffsets(buf) {
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4; }
  return offs;
}
function decodeFramed(buf) {
  const offs = magicOffsets(buf);
  if (!offs.length) throw new Error('no zstd frame');
  if (offs[0] !== 0) offs.unshift(0);
  const parts = [];
  let failed = 0;
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k];
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(s, e));
      if (out?.length) parts.push(out);
    } catch {
      failed++;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(s));
        if (out?.length) parts.push(out);
      } catch { /* skip */ }
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offs.length, failed };
}

function walkSessions(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSessions(p, acc);
    else if (e.name === 'session.v4.jsonl.zstd') acc.push(p);
  }
  return acc;
}

// ─────────────────────── 解析单个会话 ───────────────────────
function parseSession(file) {
  const buf = fs.readFileSync(file);
  const { text, frames, failed } = decodeFramed(buf);
  const lines = text.split('\n').filter((l) => l.trim());
  const ev = [];
  for (const l of lines) {
    try { ev.push(JSON.parse(l)); } catch { /* 截断的尾行 */ }
  }
  const head = ev.find((o) => o.type === 'session') || {};
  const id = head.id || path.basename(path.dirname(file));
  const cwd = head.cwd || '';
  const depth = head.delegationDepth || 0;
  const createdAt = head.createdAt || (ev.find((o) => o.time)?.time ?? Date.now());
  let title = '';
  let lastTime = createdAt;

  const users = [];      // 人类侧输入
  const asst = [];       // 助手输出（按 turn 归并）
  const tools = [];      // 工具名
  const files = new Set();

  for (const o of ev) {
    if (o.time && o.time > lastTime) lastTime = o.time;
    switch (o.type) {
      case 'session/title':
        if (o.data?.title) title = o.data.title;
        break;
      case 'user/message': {
        const d = o.data || {};
        const kind = d.source?.kind || 'unknown';
        const t = textOf(d.content ?? d.message?.content ?? d.text).trim();
        if (!t) break;
        if (kind === 'user') users.push({ t: o.time, text: t });
        break;
      }
      case 'assistant/message': {
        const d = o.data || {};
        const t = textOf(d.content ?? d.message?.content).trim();
        if (!t) break;
        asst.push({ t: o.time, text: t, turn: d.turn });
        break;
      }
      case 'tool/call': {
        const d = o.data || {};
        const nm = d.name || d.tool || '?';
        tools.push(nm);
        const args = d.arguments ?? d.input;
        const s = typeof args === 'string' ? args : JSON.stringify(args || '');
        for (const m of s.matchAll(/(?:[A-Za-z]:\\\\[^"\\\n]{2,180}\.(?:cs|py|js|mjs|ts|ps1|md|json|txt|csproj|sln|html|css|yml|yaml|xlsx|docx|png|zip))/g)) {
          files.add(m[0].replace(/\\\\/g, '\\'));
        }
        break;
      }
      case 'workspace/changes': {
        const d = o.data || {};
        for (const c of (d.changes || d.files || [])) {
          const p = c?.path || c?.file || (typeof c === 'string' ? c : '');
          if (p) files.add(p);
        }
        break;
      }
      default:
        break;
    }
  }

  // 每轮末条助手消息才是"结论/决策"候选
  const byTurn = new Map();
  for (const a of asst) {
    const k = a.turn ?? 0;
    byTurn.set(k, a);
  }
  const conclusions = [...byTurn.values()].sort((x, y) => x.t - y.t);

  return { id, cwd, depth, createdAt, lastTime, title, users, conclusions, tools, files: [...files], bytes: buf.length, frames, failed, textLen: text.length };
}

function renderArchive(s) {
  const L = [];
  L.push('---');
  L.push(`session: ${s.id}`);
  L.push(`title: ${s.title || '(无标题)'}`);
  L.push(`cwd: ${s.cwd}`);
  L.push(`start: ${isoMin(s.createdAt)}`);
  L.push(`end: ${isoMin(s.lastTime)}`);
  L.push(`human_msgs: ${s.users.length}`);
  L.push(`tools: ${s.tools.length}`);
  L.push('---');
  L.push('');
  if (s.users.length) {
    L.push('## 我说过的话（原始要求 = 最高价值信号）');
    L.push('');
    for (const u of s.users) L.push(`- \`${isoMin(u.t)}\` ${u.text.replace(/\n+/g, ' ⏎ ').slice(0, 1500)}`);
    L.push('');
  }
  if (s.conclusions.length) {
    L.push('## 每轮结论 / 决策点（助手末条，截断）');
    L.push('');
    for (const c of s.conclusions) L.push(`### \`${isoMin(c.t)}\`\n\n${c.text.slice(0, 2200)}\n`);
  }
  if (s.files.length) {
    L.push('## 触及的文件');
    L.push('');
    for (const f of s.files.slice(0, 120)) L.push(`- ${f}`);
    L.push('');
  }
  const tc = {};
  for (const t of s.tools) tc[t] = (tc[t] || 0) + 1;
  L.push('## 工具用量');
  L.push('');
  L.push(Object.entries(tc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ') || '(无)');
  L.push('');
  return L.join('\n');
}

// ─────────────────────── ingest ───────────────────────
function cmdIngest(opts = {}) {
  mkdirp(ARCHIVE); mkdirp(INBOX); mkdirp(JOURNAL); mkdirp(BIN);
  const state = readJson(STATE, { sessions: {}, version: 1 });
  const files = walkSessions(SESSIONS).sort();
  const changed = [];
  const stats = { scanned: 0, new: 0, updated: 0, skipped: 0, failed: 0 };

  for (const file of files) {
    stats.scanned++;
    const st = fs.statSync(file);
    const folder = path.basename(path.dirname(file));
    const prev = state.sessions[folder];
    if (prev && prev.size === st.size && !opts.force) { stats.skipped++; continue; }
    let s;
    try {
      s = parseSession(file);
    } catch (e) {
      stats.failed++;
      if (!opts.quiet) console.error('[skip]', folder, e.message);
      continue;
    }
    if (s.depth > 0) {   // 子代理会话：内部执行噪音，不进记忆
      state.sessions[folder] = { id: s.id, size: st.size, delegation: s.depth, title: s.title, skipped: 'subagent' };
      stats.skipped++;
      continue;
    }
    const outPath = path.join(ARCHIVE, monthKey(s.createdAt), `${s.id}.md`);
    writeAtomic(outPath, renderArchive(s));
    const seenBefore = prev?.humanSeen ?? 0;
    state.sessions[folder] = {
      id: s.id, size: st.size, title: s.title, cwd: s.cwd,
      start: isoMin(s.createdAt), end: isoMin(s.lastTime),
      human: s.users.length, humanSeen: seenBefore,
      archivedTo: path.relative(MEM, outPath),
    };
    if (prev) stats.updated++; else stats.new++;
    changed.push({ s, folder, seenBefore });
  }

  // 增量待提炼包：只装「自从上次打包之后新增的内容」，避免整场会话重复灌入
  let inboxPath = '';
  const fresh = [];
  for (const { s, folder, seenBefore } of changed.sort((a, b) => a.s.createdAt - b.s.createdAt)) {
    const deltaUsers = s.users.slice(seenBefore);
    if (!deltaUsers.length) continue;   // 没有新的人类输入就没有可提炼的东西
    fresh.push({ s, deltaUsers, cons: s.conclusions.slice(-2), isNew: seenBefore === 0 });
    state.sessions[folder].humanSeen = s.users.length;
  }
  if (fresh.length) {
    const ts = now();
    const name = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.md`;
    inboxPath = path.join(INBOX, name);
    const L = [];
    L.push(`# 待提炼增量包 ${isoMin(Date.now())}（${fresh.length} 个会话有新内容）`);
    L.push('');
    L.push('> 交给 AI：只提取**长期有用**的事实与决策，合并进 MEMORY.md；纯过程性内容丢弃。');
    L.push('');
    for (const { s, deltaUsers, cons, isNew } of fresh) {
      L.push(`## 会话 ${s.id.slice(0, 16)} | ${s.title || '(无标题)'} | ${isoMin(s.createdAt)}${isNew ? '' : ' | 续接'}`);
      L.push(`cwd: ${s.cwd}`);
      L.push('');
      if (deltaUsers.length) {
        L.push('### 人类要求');
        for (const u of deltaUsers) L.push(`- [${isoMin(u.t)}] ${u.text.replace(/\n+/g, ' ⏎ ').slice(0, 900)}`);
        L.push('');
      }
      if (cons.length) {
        L.push('### 末尾结论');
        for (const c of cons) L.push(`- [${isoMin(c.t)}] ${c.text.replace(/\n+/g, ' ').slice(0, 700)}`);
        L.push('');
      }
      if (deltaUsers.length && s.files.length) {
        L.push('### 产出/触及文件');
        for (const f of s.files.slice(0, 25)) L.push(`- ${f}`);
        L.push('');
      }
    }
    writeAtomic(inboxPath, L.join('\n'));
  }
  writeAtomic(STATE, JSON.stringify(state, null, 2));

  if (!opts.quiet) {
    console.log(`scanned=${stats.scanned} new=${stats.new} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`);
    if (inboxPath) console.log('inbox:', inboxPath);
  }
  return { stats, inboxPath };
}

// ─────────────────────── status ───────────────────────
function cmdStatus() {
  const state = readJson(STATE, { sessions: {} });
  const list = Object.values(state.sessions);
  const pending = pendingInboxes();
  const archiveFiles = fs.existsSync(ARCHIVE) ? countFiles(ARCHIVE) : 0;
  let journalBytes = 0;
  if (fs.existsSync(JOURNAL)) for (const f of fs.readdirSync(JOURNAL)) journalBytes += fs.statSync(path.join(JOURNAL, f)).size;
  const memBytes = fs.existsSync(MEMORY) ? fs.statSync(MEMORY).size : 0;
  const agentsBytes = fs.existsSync(AGENTS) ? fs.statSync(AGENTS).size : 0;
  console.log(`会话总数        ${list.length}`);
  console.log(`人类消息总数    ${list.reduce((a, b) => a + (b.human || 0), 0)}`);
  console.log(`档案文件        ${archiveFiles} (${path.relative(HOME, ARCHIVE)})`);
  console.log(`MEMORY.md       ${memBytes} B`);
  console.log(`AGENTS.md       ${agentsBytes} B`);
  console.log(`journal         ${journalBytes} B`);
  console.log(`待提炼包        ${pending.length}`);
  if (pending.length) for (const p of pending) console.log('  -', path.basename(p));
  const last = list.filter((x) => x.end).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  if (last) console.log(`最近归档        ${last.end} ${last.title || ''}`);
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

function pendingInboxes() {
  if (!fs.existsSync(INBOX)) return [];
  return fs.readdirSync(INBOX).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => path.join(INBOX, f)).sort();
}

function cmdPending() {
  const p = pendingInboxes();
  if (!p.length) { console.log('no-pending'); process.exit(1); }
  for (const x of p) console.log(x);
}

// ─────────────────────── render → AGENTS.md ───────────────────────
function cmdRender(opts = {}) {
  const memRaw = fs.existsSync(MEMORY) ? fs.readFileSync(MEMORY, 'utf8') : '# MEMORY\n\n(空)\n';
  let memText = memRaw.trim();
  let truncated = false;
  if (Buffer.byteLength(memText, 'utf8') > INJECT_BUDGET) {
    memText = memText.slice(0, INJECT_BUDGET) + '\n\n…（已截断，全文见 ~/.dsh/memory/MEMORY.md）';
    truncated = true;
  }
  const pending = pendingInboxes();
  const memctl = path.join(BIN, 'memctl.mjs');
  const body = [];
  body.push(BLOCK_BEGIN);
  body.push('<!-- 本区由 `mem memctl render` 自动生成，手改会被覆盖：要改记忆就改 ~/.dsh/memory/MEMORY.md -->');
  body.push('');
  body.push('## 长期记忆（自动注入）');
  body.push('');
  body.push(memText);
  body.push('');
  body.push('## 记忆作业规程（每轮都生效）');
  body.push('');
  body.push(`1. 用户说出长期有效的事实/偏好/纠正/项目状态时，立刻追加一行到 \`~/.dsh/memory/journal/<YYYY-MM>.md\`，格式 \`- [YYYY-MM-DD] 内容\`（一个事实一行，不写过程）。`);
  body.push(`2. 在上面的长期记忆里找不到的历史细节，用 \`node "${memctl}" search <关键词>\` 检索会话档案，不要凭印象猜。`);
  body.push('3. 上述记忆与本轮用户明确说法冲突时，以用户当前说法为准，并顺手修正 MEMORY.md 与 journal。');
  body.push('4. 记忆里没有的不编造；标注 `[未确认]`。');
  if (pending.length) {
    body.push('');
    body.push(`## ⚠ 待提炼记忆增量：${pending.length} 个包`);
    body.push('');
    body.push('本轮开工前（或收尾时）执行：读取下列文件 → 只抽取长期有用的事实/决策 → 合并进 `~/.dsh/memory/MEMORY.md`（去重、按日期标注）→ 删除该包 → `node "' + memctl + '" render` 重建注入区。');
    for (const p of pending.slice(-5)) body.push(`- ${p}`);
  }
  body.push('');
  body.push(BLOCK_END);

  const prev = fs.existsSync(AGENTS) ? fs.readFileSync(AGENTS, 'utf8') : '';
  let out;
  const bi = prev.indexOf(BLOCK_BEGIN);
  const ei = prev.indexOf(BLOCK_END);
  if (bi !== -1 && ei > bi) {
    out = prev.slice(0, bi) + body.join('\n') + prev.slice(ei + BLOCK_END.length);
  } else {
    const manual = prev.trim();
    out = (manual ? `${manual}\n\n` : '') + body.join('\n') + '\n';
  }
  writeAtomic(AGENTS, out);
  console.log(`AGENTS.md ${Buffer.byteLength(out, 'utf8')} B (记忆注入 ${Buffer.byteLength(memText, 'utf8')} B${truncated ? '，已截断' : ''}，待提炼 ${pending.length})`);
}

// ─────────────────────── search ───────────────────────
async function cmdSearch(argv) {
  let ctx = 0, limit = 40;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n') ctx = Number(argv[++i]) || 0;
    else if (a === '-l') limit = Number(argv[++i]) || 40;
    else words.push(a);
  }
  if (!words.length) { console.error('用法: memctl search <关键词...> [-n 上下文行] [-l 上限]'); process.exit(2); }

  // 优先走插件的分词检索（中文 bigram + 自动解压 .gz 归档）
  const apiPath = path.join(DSH_HOME, 'plugins', 'dsh-memory-panel', 'api.js');
  if (fs.existsSync(apiPath)) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(apiPath).href);
    const r = mod.search(words.join(' '), limit);
    if (!r.hits.length) { console.log('(无匹配)'); return; }
    console.log(r.hits.map((h) => `\n${h.session}:${h.line}  score=${h.score}\n${h.snippet}`).join('\n'));
    return;
  }

  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const out = [];
  for (const f of walkMd(ARCHIVE)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const from = Math.max(0, i - ctx);
      const to = Math.min(lines.length, i + ctx + 1);
      out.push(`\n${path.basename(f, '.md')}:${i + 1}\n${lines.slice(from, to).join('\n')}`);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  console.log(out.length ? out.join('\n') : '(无匹配)');
}

function walkMd(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc.sort();
}

function cmdShow(prefix) {
  if (!prefix) { console.error('用法: memctl show <会话id前缀>'); process.exit(2); }
  const hit = walkMd(ARCHIVE).find((f) => path.basename(f).includes(prefix));
  if (!hit) { console.error('找不到会话', prefix); process.exit(1); }
  console.log(fs.readFileSync(hit, 'utf8'));
}

// ─────────────────────── compact（旧月份滚动压缩） ───────────────────────
/**
 * 当月档案保持散装 .md（面板能直接点开、单份可读）；
 * 更早的月份合并成 archive-YYYY-MM.md.gz，每场会话用
 * `<!-- mc:session xxx.md -->` 块标记包住，面板按块取回原文。
 * .gz 用 Node 自带 zlib，搜索时按需解压，不引入依赖。
 */
function cmdCompact(opts = {}) {
  const cur = monthKey(Date.now());
  const months = fs.existsSync(ARCHIVE)
    ? fs.readdirSync(ARCHIVE, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name) && e.name < cur)
        .map((e) => e.name)
    : [];
  const done = [];
  for (const m of months) {
    const dir = path.join(ARCHIVE, m);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (!files.length) { try { fs.rmdirSync(dir); } catch { /* 非空 */ } continue; }
    const chunks = [];
    for (const f of files.sort()) {
      const id = f.replace(/\.md$/, '');
      chunks.push(`<!-- mc:session ${id}.md -->\n${fs.readFileSync(path.join(dir, f), 'utf8')}\n<!-- mc:end ${id}.md -->\n`);
    }
    const body = Buffer.from(chunks.join('\n'), 'utf8');
    const gz = path.join(ARCHIVE, `archive-${m}.md.gz`);
    writeAtomic(gz, zlib.gzipSync(body, { level: 9 }));
    for (const f of files) fs.unlinkSync(path.join(dir, f));
    try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
    done.push({ month: m, sessions: files.length, rawBytes: body.length, gzBytes: fs.statSync(gz).size });
    const monthly = path.join(MEM, 'monthly', `${m}.md`);
    if (!fs.existsSync(monthly)) {
      writeAtomic(monthly, [
        `# ${m} 归档摘要`, '',
        `- ${files.length} 场会话，原文打包在 archive/${path.basename(gz)}（${fs.statSync(gz).size} B，原 ${body.length} B）`,
        '- 原文仍可检索：面板「全文检索」或 `mem.cmd search <关键词>`',
        '',
      ].join('\n'));
    }
  }
  if (!opts.quiet) {
    console.log(done.length
      ? done.map((d) => `${d.month}: ${d.sessions} 场 ${d.rawBytes} → ${d.gzBytes} B（省 ${Math.round((1 - d.gzBytes / d.rawBytes) * 100)}%）`).join('\n')
      : '没有需要压缩的月份');
  }
  return done;
}

// ─────────────────────── report（可视化面板快照） ───────────────────────
async function writeDashboard() {
  const apiPath = path.join(DSH_HOME, 'plugins', 'dsh-memory-panel', 'api.js');
  if (!fs.existsSync(apiPath)) return '';
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(apiPath).href);
  const out = path.join(MEM, 'dashboard.html');
  writeAtomic(out, mod.pageHtml(mod.gatherState()));
  return out;
}

// ─────────────────────── main ───────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const opts = { force: rest.includes('--force'), quiet: rest.includes('--quiet') };
switch (cmd) {
  case 'ingest':
    cmdIngest(opts);
    break;
  case 'status':
    cmdStatus();
    break;
  case 'pending':
    cmdPending();
    break;
  case 'inbox': {
    const r = cmdIngest({ ...opts, quiet: true });
    const p = pendingInboxes();
    if (!p.length) { console.log('无待提炼增量'); break; }
    for (const x of p) console.log(x);
    break;
  }
  case 'render':
    cmdRender(opts);
    break;
  case 'sync': {
    const r = cmdIngest(opts);
    cmdCompact({ quiet: true });
    cmdRender(opts);
    const d = await writeDashboard();
    if (d && !opts.quiet) console.log('dashboard:', d);
    void r;
    break;
  }
  case 'compact':
    cmdCompact(opts);
    break;
  case 'report': {
    const d = await writeDashboard();
    console.log(d ? `dashboard: ${d}` : '未安装 dsh-memory-panel 插件，跳过');
    break;
  }
  case 'schedule': {
    const schedPath = path.join(DSH_HOME, 'plugins', 'dsh-memory-panel', 'schedule.mjs');
    if (!fs.existsSync(schedPath)) { console.log('未安装 dsh-memory-panel 插件，跳过'); break; }
    const { pathToFileURL } = await import('node:url');
    const m = await import(pathToFileURL(schedPath).href);
    const at = rest.indexOf('--set');
    if (at !== -1 && rest[at + 1] !== undefined) {
      const r = await m.setScheduleMinutes(rest[at + 1]);
      if (!r.ok) { console.log('失败：' + r.error); process.exit(1); }
      console.log(`已设为每 ${r.minutes} 分钟（${r.platform} / ${r.schedule?.backend || m.platform}）\n`);
    }
    console.log(await m.describeSchedule());
    break;
  }
  case 'search':
    await cmdSearch(rest);
    break;
  case 'show':
    cmdShow(rest[0]);
    break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*/, ''));
}
