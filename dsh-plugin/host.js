/**
 * DSH Cordis Host half — mahjong JSONL worker supervisor.
 * WORKSPACE is auto-probed; override with env DSH_MAHJONG_WORKSPACE if needed.
 */
const path = require('path');
const fs = require('fs');

function probeWorkspace() {
  const candidates = [];
  if (process.env.DSH_MAHJONG_WORKSPACE) candidates.push(process.env.DSH_MAHJONG_WORKSPACE);
  if (process.env.WORKSPACE) candidates.push(process.env.WORKSPACE);
  candidates.push(process.cwd());
  try {
    candidates.push(path.resolve(__dirname, '..'));
    candidates.push(path.resolve(__dirname, '../..'));
  } catch (_) {}
  candidates.push('C:/Users/Administrator/WorkBuddy/2026-08-18-15-00-32/mahjong-harness');
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const worker = path.join(dir, 'harness', 'worker.py');
      if (fs.existsSync(worker)) return path.resolve(dir);
    } catch (_) {}
  }
  return path.resolve(process.cwd());
}

function probePython(workspace) {
  if (process.env.DSH_MAHJONG_PYTHON) return process.env.DSH_MAHJONG_PYTHON;
  const isWin = process.platform === 'win32';
  const local = isWin
    ? path.join(workspace, 'Mortal', '.venv', 'Scripts', 'python.exe')
    : path.join(workspace, 'Mortal', '.venv', 'bin', 'python');
  if (fs.existsSync(local)) return local;
  return isWin ? 'python' : 'python3';
}

const WORKSPACE = probeWorkspace();
const PYTHON = probePython(WORKSPACE);

return {
  inject: ['subprocess'],
  apply(ctx) {
    const sessions = new Map();
    const credentials = ctx.get('credentials');
    const subprocess = ctx.subprocess;
    let buffer = '';
    let worker;
    let restartCount = 0;
    const MAX_RESTARTS = 5;

    function safeState(state) {
      if (!state || typeof state !== 'object') return { status: 'unknown' };
      return {
        sessionId: typeof state.sessionId === 'string' ? state.sessionId : '',
        status: typeof state.status === 'string' ? state.status : 'unknown',
        seed: Number(state.seed || 0),
        model: typeof state.model === 'string' ? state.model : '',
        scores: Array.isArray(state.scores) ? state.scores.slice(0, 4).map(Number) : [25000, 25000, 25000, 25000],
        lastEvent: state.lastEvent && typeof state.lastEvent === 'object' ? state.lastEvent : null,
        eventCount: Number(state.eventCount || 0),
        violations: Number(state.violations || 0),
        fallbacks: Number(state.fallbacks || 0),
        llmCalls: Number(state.llmCalls || 0),
        elapsedMs: Number(state.elapsedMs || 0),
        error: typeof state.error === 'string' ? state.error : null,
        events: Array.isArray(state.events) ? state.events.slice(-200) : undefined,
      };
    }

    function markWorkerDead(reason) {
      for (const [key, session] of sessions) {
        if (key.startsWith('request:')) {
          try { session.reject(new Error(reason)); } catch (_) {}
          sessions.delete(key);
          continue;
        }
        if (session && session.state && ['starting', 'running', 'cancelling'].includes(session.state.status)) {
          session.state = Object.assign({}, session.state, { status: 'failed', error: reason });
        }
      }
    }

    function onFrame(frame) {
      if (!frame || typeof frame !== 'object') return;
      if (frame.id) {
        const pending = sessions.get('request:' + frame.id);
        if (pending) {
          sessions.delete('request:' + frame.id);
          if (frame.error) pending.reject(new Error(frame.error.message || 'worker error'));
          else pending.resolve(frame.result);
          return;
        }
      }
      if (typeof frame.sessionId !== 'string') return;
      const session = sessions.get(frame.sessionId);
      if (!session) return;
      if (frame.event === 'session') session.state = safeState(frame.data);
      if (frame.event === 'mjai') {
        const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
        session.events.push(data);
        session.state = Object.assign({}, session.state, { lastEvent: data, eventCount: session.events.length });
      }
      if (frame.event === 'decision') {
        session.state = Object.assign({}, session.state, { lastDecision: frame.data });
      }
    }

    function attachWorkerHandlers(proc) {
      proc.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { onFrame(JSON.parse(line)); } catch (_) {}
        }
      });
      proc.on('exit', (code, signal) => {
        const reason = 'worker exited (code=' + code + ', signal=' + (signal || 'none') + ')';
        worker = undefined;
        buffer = '';
        markWorkerDead(reason);
        if (restartCount < MAX_RESTARTS) {
          restartCount += 1;
          try { ensureWorker(); } catch (_) {}
        }
      });
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', () => {});
    }

    function ensureWorker() {
      if (worker) return worker;
      worker = subprocess.spawn({
        argv: [PYTHON, '-m', 'harness.worker'],
        cwd: WORKSPACE,
        graceMs: 1500,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4000 } },
        env: Object.assign({}, process.env, { PYTHONPATH: WORKSPACE, PYTHONDONTWRITEBYTECODE: '1' }),
      });
      attachWorkerHandlers(worker);
      return worker;
    }

    function send(method, params) {
      const id = 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const proc = ensureWorker();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          sessions.delete('request:' + id);
          reject(new Error('worker request timeout'));
        }, 120000);
        sessions.set('request:' + id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try {
          proc.stdin.write(JSON.stringify({ id: id, method: method, params: params }) + '\n');
        } catch (error) {
          sessions.delete('request:' + id);
          clearTimeout(timer);
          reject(error);
        }
      });
    }

    async function resolveApiKey() {
      try {
        if (credentials && typeof credentials.resolve === 'function') {
          const value = await credentials.resolve({ namespace: 'mahjong', name: 'LLM_API_KEY' });
          if (value) return String(value);
        }
      } catch (_) {}
      return process.env.LLM_API_KEY || '';
    }

    async function start(args) {
      const apiKey = await resolveApiKey();
      const sessionId = 'mj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      sessions.set(sessionId, { state: { sessionId: sessionId, status: 'starting' }, events: [] });
      const result = await send('session.start', {
        sessionId: sessionId,
        seed: args && args.seed != null ? Number(args.seed) : 7,
        model: (args && args.model) || 'deepseek-ai/DeepSeek-V4-Flash',
        apiKey: apiKey,
        baseUrl: (args && args.baseUrl) || 'https://api.siliconflow.cn/v1',
        budget: args && args.budget != null ? Number(args.budget) : undefined,
        mock: !!(args && args.mock),
        logDir: path.join(WORKSPACE, 'logs', 'dsh'),
      });
      const state = safeState(result);
      const entry = sessions.get(sessionId) || { events: [] };
      entry.state = state;
      sessions.set(sessionId, entry);
      return state;
    }

    async function status(args) {
      const sessionId = args && args.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      const local = sessions.get(sessionId);
      try {
        const result = await send('session.status', { sessionId: sessionId });
        const state = safeState(result);
        if (local) {
          state.events = local.events.slice(-200);
          state.eventCount = Math.max(Number(state.eventCount || 0), local.events.length);
          local.state = state;
        }
        return state;
      } catch (error) {
        if (local && local.state) {
          return Object.assign({}, local.state, {
            events: local.events.slice(-200),
            error: local.state.error || String(error.message || error),
          });
        }
        throw error;
      }
    }

    async function exportSession(args) {
      const sessionId = args && args.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      const result = await send('session.export', { sessionId: sessionId });
      const state = safeState(result);
      const local = sessions.get(sessionId);
      if (local && local.events.length) {
        state.events = local.events.slice();
        state.eventCount = local.events.length;
      }
      return state;
    }

    function tool(name, description, parameters, handler) {
      return { name: name, description: description, parameters: parameters, execute: handler };
    }

    const harness = ctx.harness || {
      registerTool: function (c, t) {
        if (c.tools && typeof c.tools.register === 'function') c.tools.register(t);
        else if (typeof c.registerTool === 'function') c.registerTool(t);
      },
      handle: function (name, fn) {
        if (ctx.handle) ctx.handle(name, fn);
      },
    };

    harness.registerTool(ctx, tool(
      'mahjong_start',
      '开始一局日本麻将（对话内紧凑卡片，不自动全屏）。可选 seed / mock / budget / model。',
      {
        type: 'object',
        properties: {
          seed: { type: 'number' },
          mock: { type: 'boolean' },
          budget: { type: 'number' },
          model: { type: 'string' },
          baseUrl: { type: 'string' },
        },
      },
      start
    ));
    harness.registerTool(ctx, tool(
      'mahjong_status',
      '查询日本麻将对局状态。',
      { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
      status
    ));
    harness.registerTool(ctx, tool(
      'mahjong_cancel',
      '取消一局仍在运行的日本麻将。',
      { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
      async function (args) { return safeState(await send('session.cancel', { sessionId: args.sessionId })); }
    ));
    harness.registerTool(ctx, tool(
      'mahjong_export',
      '导出一局的 MJAI 事件和统计，不包含 prompt 或密钥。',
      { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
      exportSession
    ));

    ctx.effect(function () {
      return function () {
        if (worker) { try { worker.terminate(); } catch (_) {} }
        worker = undefined;
        sessions.clear();
      };
    }, 'mahjong-worker');

    harness.handle('mahjong.status', async function (args) { return status(args); });
    harness.handle('mahjong.export', async function (args) { return exportSession(args); });

    if (ctx.logger && ctx.logger.info) ctx.logger.info('[mahjong] workspace=' + WORKSPACE + ' python=' + PYTHON);
  },
};
