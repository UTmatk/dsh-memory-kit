/**
 * dsh-memory-panel —— Host 半边。
 *
 * 只做一件事：在 DSH 的 HTTP 服务器上认领 /memory-panel 前缀，把记忆库的数据
 * 与操作暴露成一个小 JSON API + 一个自包含页面。刻意不注册 Typert Remote：
 * 同源的普通 fetch 就够用，少一层编解码和类型投影。
 *
 * 所有写操作都只是调用 memctl.mjs 子进程（sync / render / ingest），
 * 面板自身不直接改任何记忆文件。
 */
import {
  pageHtml, gatherState, search, readArchive, runMemctl, MEM, ARCHIVE, INBOX,
  readMemoryText, writeMemoryText, restoreSnapshot,
} from './api.js';
import { readSchedule, setScheduleMinutes } from './schedule.mjs';

const MAX_BODY = 512 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const inject = ['webServer'];

const PREFIX = '/memory-panel';

function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res, code, body) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const sub = url.pathname.slice(PREFIX.length) || '/';
        const method = req.method || 'GET';

        if (method === 'GET' && (sub === '/' || sub === '' || sub === '/index.html')) {
          return html(res, 200, pageHtml());
        }
        if (method === 'GET' && sub === '/api/state') {
          return json(res, 200, gatherState());
        }
        if (method === 'GET' && sub === '/api/search') {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
          return json(res, 200, search(url.searchParams.get('q') || '', limit));
        }
        if (method === 'GET' && sub === '/api/file') {
          return json(res, 200, readArchive(url.searchParams.get('name') || ''));
        }
        if (method === 'POST' && (sub === '/api/sync' || sub === '/api/render' || sub === '/api/ingest' || sub === '/api/compact')) {
          const cmd = sub.slice('/api/'.length);
          const args = cmd === 'sync' ? ['sync', '--quiet'] : [cmd];
          return json(res, 200, await runMemctl(args));
        }
        if (method === 'GET' && sub === '/api/memory') {
          return json(res, 200, readMemoryText());
        }
        if (method === 'POST' && sub === '/api/memory') {
          let body = {};
          try { body = JSON.parse(await readBody(req) || '{}'); }
          catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
          const result = await writeMemoryText(body.text);
          return json(res, result.ok ? 200 : 400, result);
        }
        if (method === 'POST' && sub === '/api/memory/restore') {
          let body = {};
          try { body = JSON.parse(await readBody(req) || '{}'); }
          catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
          const result = await restoreSnapshot(body.name);
          return json(res, result.ok ? 200 : 400, result);
        }
        if (method === 'GET' && sub === '/api/schedule') {
          return json(res, 200, await readSchedule());
        }
        if (method === 'POST' && sub === '/api/schedule') {
          const minutes = Number(url.searchParams.get('minutes'));
          const result = await setScheduleMinutes(minutes);
          return json(res, result.ok ? 200 : 400, result);
        }
        if (method === 'GET' && sub === '/api/paths') {
          return json(res, 200, { memory: MEM, archive: ARCHIVE, inbox: INBOX });
        }
        return json(res, 404, { error: 'not-found', sub });
      },
    });
    ctx.logger?.info?.(`memory-panel: serving ${PREFIX}/`);
    return () => dispose();
  }, 'memory-panel: /memory-panel routes');
}
