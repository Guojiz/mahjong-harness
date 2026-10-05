/**
 * DSH Cordis Host half — mahjong-harness runtime supervisor.
 *
 * This file is the BODY of an async function evaluated inside the DSH
 * dynamic-package sandbox (`cordis_define` → `code.host`). It is written to the
 * sandbox contract, which is deliberately narrower than Node.js:
 *
 *   available globals : console, harness.{defineTool,registerTool,handle},
 *                       btoa/atob, TextEncoder/TextDecoder, Math, Date, JSON, Promise
 *   trapped globals   : require, process, setTimeout, setInterval, setImmediate,
 *                       clearTimeout, clearInterval, fetch  (each throws a redirect)
 *   ctx façade        : ctx.tools.register / ctx.tools.schemas / ctx.tools.get,
 *                       ctx.get(name), ctx.effect / on / once / provide,
 *                       timer verbs ctx.timeout / ctx.interval (after inject: ['timer']),
 *                       plus any service declared in `inject`
 *
 * Consequences the code below honours:
 *   - no path/fs/process → the workspace and the Python executable come from the
 *     the `mahjong_start` arguments / profile config / session cwd (`cordis_run` passes no config);
 *   - no setTimeout → request timeouts use `ctx.timeout` (fiber-scoped, disposed with the run);
 *   - no process.env → child environment carries only PYTHONPATH / PYTHONDONTWRITEBYTECODE;
 *     the subprocess service inherits its own scrubbed parent environment (PATH included);
 *   - tools must come from `harness.defineTool` and be handed to `harness.registerTool`,
 *     because the registry rejects anything without the dynamic-tool marker;
 *   - `output.render` must return an ARRAY of content blocks.
 *
 * `dsh-plugin/index.cjs` loads this same file as a module for persistent profile installs.
 */

const DEFAULT_VIEWER_HOST = '127.0.0.1';
const DEFAULT_VIEWER_PORT = 8765;
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const REQUEST_TIMEOUT_MS = 120000;
const MAX_WORKER_RESTARTS = 5;
const MAX_VIEWER_RESTARTS = 3;

/**
 * The sandbox JSON-clones every tool result and bridge-handler result and rejects
 * `undefined` members ("lossless JSON data"). A round-trip drops them, so every
 * value that leaves this plugin goes through it.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

/** Join two path fragments without `node:path` (unavailable in the sandbox). */
function joinPath(base, segment) {
  const separator = String(base).indexOf('\\') >= 0 ? '\\' : '/';
  return String(base).replace(/[\\/]+$/, '') + separator + segment;
}

/** PYTHONPATH list separator for the workspace's platform. */
function pathListSeparator(base) {
  return String(base).indexOf('\\') >= 0 ? ';' : ':';
}

function looksLikeWindows(base) {
  return String(base).indexOf('\\') >= 0 || /^[A-Za-z]:/.test(String(base));
}

return {
  name: 'mahjong-harness',
  inject: ['subprocess', 'timer', 'tools'],
  apply(ctx, config) {
    const settings = isObject(config) ? config : {};
    const VIEWER_HOST = settings.viewerHost === 'localhost' ? 'localhost' : DEFAULT_VIEWER_HOST;
    let VIEWER_PORT = normalizePort(settings.viewerPort, DEFAULT_VIEWER_PORT);
    const BASE_URL = typeof settings.baseUrl === 'string' && settings.baseUrl ? settings.baseUrl : DEFAULT_BASE_URL;
    const MODEL = typeof settings.model === 'string' && settings.model ? settings.model : DEFAULT_MODEL;
    const CONFIGURED_WORKSPACE = typeof settings.workspace === 'string' ? settings.workspace : '';
    const CONFIGURED_PYTHON = typeof settings.python === 'string' ? settings.python : '';
    const subprocess = ctx.get('subprocess');
    const credentials = ctx.get('credentials');

    /** Session records, plus in-flight request promises under `request:<id>`. */
    const sessions = new Map();
    let worker;
    let viewer;
    let viewerReady = false;
    let disposed = false;
    let restartCount = 0;
    let viewerRestartCount = 0;
    let buffer = '';
    let workspaceCache = '';
    let pythonOverride = '';
    let lastExec;

    function workspaceFromExec(exec) {
      if (!isObject(exec)) return '';
      const agent = exec.agent;
      if (isObject(agent)) {
        if (typeof agent.cwd === 'string' && agent.cwd) return agent.cwd;
        if (isObject(agent.meta) && typeof agent.meta.cwd === 'string' && agent.meta.cwd) return agent.meta.cwd;
        const session = agent.session;
        if (isObject(session)) {
          if (typeof session.cwd === 'string' && session.cwd) return session.cwd;
          // `Agent.session` is a real Session; its durable header carries the cwd.
          if (isObject(session.header) && typeof session.header.cwd === 'string' && session.header.cwd) {
            return session.header.cwd;
          }
        }
      }
      if (typeof exec.cwd === 'string' && exec.cwd) return exec.cwd;
      return '';
    }

    function workspaceFromRegistry() {
      let registry;
      try {
        registry = ctx.get('workspaceRegistry');
      } catch (_) {
        return '';
      }
      if (!registry || typeof registry.list !== 'function') return '';
      let entries;
      try {
        entries = registry.list();
      } catch (_) {
        return '';
      }
      if (!Array.isArray(entries)) return '';
      for (const entry of entries) {
        if (!isObject(entry)) continue;
        for (const key of ['path', 'cwd', 'directory', 'root', 'canonicalPath']) {
          if (typeof entry[key] === 'string' && entry[key]) return entry[key];
        }
      }
      return '';
    }

    /**
     * The repository root holding `harness/worker.py`.
     *
     * The sandbox cannot read the filesystem or the environment, and the dynamic
     * `cordis_run` path passes NO plugin config (`DynamicCordisRunnerService.run`
     * mounts the host half with `ctx.plugin(guardedPlugin(plugin))`), so the order is:
     *   1. `mahjong_start`'s explicit `workspace` argument,
     *   2. the profile-path `config.workspace`,
     *   3. the calling agent's session cwd (`exec.agent.session.header.cwd`),
     *   4. the first registered workspace.
     */
    function resolveWorkspace(exec) {
      if (workspaceCache) return workspaceCache;
      const candidate = CONFIGURED_WORKSPACE || workspaceFromExec(exec) || workspaceFromRegistry();
      if (!candidate) {
        throw new Error(
          'mahjong-harness: 无法确定仓库路径。请在 mahjong_start 里显式传入 workspace，' +
            '例如 mahjong_start workspace="/绝对路径/mahjong-harness" seed=7 mock=true；' +
            'profile 安装路径也可以改用 config.workspace。'
        );
      }
      workspaceCache = String(candidate).replace(/[\\/]+$/, '');
      return workspaceCache;
    }

    function resolvePython(workspace) {
      if (pythonOverride) return pythonOverride;
      if (CONFIGURED_PYTHON) return CONFIGURED_PYTHON;
      return looksLikeWindows(workspace) ? 'python' : 'python3';
    }

    function childEnv(workspace) {
      return {
        PYTHONPATH: joinPath(workspace, 'Mortal/mortal') + pathListSeparator(workspace) + workspace,
        PYTHONDONTWRITEBYTECODE: '1',
      };
    }

    function viewerUrl(sessionId) {
      if (!viewerReady) return undefined;
      return 'http://' + VIEWER_HOST + ':' + VIEWER_PORT + '/view/' + encodeURIComponent(sessionId);
    }

    function logDir(workspace) {
      return joinPath(workspace, 'logs/dsh');
    }

    function ensureViewer(exec) {
      if (viewer) return viewer;
      if (disposed) throw new Error('mahjong plugin is disposed');
      const workspace = resolveWorkspace(exec || lastExec);
      const python = resolvePython(workspace);
      const handle = subprocess.spawn({
        argv: [
          python,
          '-m',
          'harness.serve_logs',
          '--host',
          VIEWER_HOST,
          '--port',
          String(VIEWER_PORT),
          '--session-dir',
          logDir(workspace),
        ],
        cwd: workspace,
        graceMs: 1500,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4000 } },
        env: childEnv(workspace),
      });
      viewer = handle;
      if (handle.stdout && typeof handle.stdout.on === 'function') {
        handle.stdout.on('data', (chunk) => {
          if (String(chunk).indexOf('MJAI log server:') >= 0) viewerReady = true;
        });
      }
      if (handle.done && typeof handle.done.then === 'function') {
        handle.done.then(
          () => {
            if (viewer !== handle) return;
            viewer = undefined;
            viewerReady = false;
            if (!disposed && viewerRestartCount < MAX_VIEWER_RESTARTS) {
              viewerRestartCount += 1;
              try {
                ensureViewer(lastExec);
              } catch (_) {}
            }
          },
          () => {
            if (viewer !== handle) return;
            viewer = undefined;
            viewerReady = false;
          }
        );
      }
      return handle;
    }

    function safeState(state) {
      if (!isObject(state)) return { status: 'unknown' };
      return {
        sessionId: typeof state.sessionId === 'string' ? state.sessionId : '',
        status: typeof state.status === 'string' ? state.status : 'unknown',
        seed: Number(state.seed || 0),
        model: typeof state.model === 'string' ? state.model : '',
        scores: Array.isArray(state.scores) ? state.scores.slice(0, 4).map(Number) : [25000, 25000, 25000, 25000],
        lastEvent: isObject(state.lastEvent) ? state.lastEvent : null,
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
        if (key.indexOf('request:') === 0) {
          try {
            session.reject(new Error(reason));
          } catch (_) {}
          sessions.delete(key);
          continue;
        }
        if (session && session.state && ['starting', 'running', 'cancelling'].indexOf(session.state.status) >= 0) {
          session.state = Object.assign({}, session.state, { status: 'failed', error: reason });
        }
      }
    }

    function onFrame(frame) {
      if (!isObject(frame)) return;
      if (frame.id) {
        const pending = sessions.get('request:' + frame.id);
        if (pending) {
          sessions.delete('request:' + frame.id);
          if (frame.error) pending.reject(new Error((frame.error && frame.error.message) || 'worker error'));
          else pending.resolve(frame.result);
          return;
        }
      }
      if (typeof frame.sessionId !== 'string') return;
      const session = sessions.get(frame.sessionId);
      if (!session) return;
      if (frame.event === 'session') session.state = safeState(frame.data);
      if (frame.event === 'mjai') {
        const data = isObject(frame.data) ? frame.data : {};
        session.events.push(data);
        session.state = Object.assign({}, session.state, { lastEvent: data, eventCount: session.events.length });
      }
      if (frame.event === 'decision') {
        session.state = Object.assign({}, session.state, { lastDecision: frame.data });
      }
    }

    function attachWorkerHandlers(handle) {
      handle.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            onFrame(JSON.parse(line));
          } catch (_) {}
        }
      });
      if (handle.stderr && typeof handle.stderr.on === 'function') handle.stderr.on('data', () => {});
      handle.done.then(
        (outcome) => {
          if (worker !== handle) return;
          const code = outcome && outcome.exitCode;
          const signal = outcome && outcome.signal;
          worker = undefined;
          buffer = '';
          markWorkerDead('worker exited (code=' + code + ', signal=' + (signal || 'none') + ')');
          if (!disposed && restartCount < MAX_WORKER_RESTARTS) {
            restartCount += 1;
            try {
              ensureWorker(lastExec);
            } catch (_) {}
          }
        },
        (error) => {
          if (worker !== handle) return;
          worker = undefined;
          buffer = '';
          markWorkerDead('worker failed to start: ' + ((error && error.message) || String(error)));
        }
      );
    }

    function ensureWorker(exec) {
      if (exec) lastExec = exec;
      if (worker) return worker;
      if (disposed) throw new Error('mahjong plugin is disposed');
      const workspace = resolveWorkspace(exec || lastExec);
      const python = resolvePython(workspace);
      const handle = subprocess.spawn({
        argv: [python, '-m', 'harness.worker'],
        cwd: workspace,
        graceMs: 1500,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4000 } },
        env: childEnv(workspace),
      });
      worker = handle;
      attachWorkerHandlers(handle);
      return handle;
    }

    /** Fiber-scoped timeout: `setTimeout` is trapped in the sandbox. */
    function scheduleTimeout(fn, ms) {
      if (typeof ctx.timeout !== 'function') return function () {};
      const stop = ctx.timeout(fn, ms);
      return typeof stop === 'function' ? stop : function () {};
    }

    function send(method, params, exec) {
      const handle = ensureWorker(exec);
      const id = 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      return new Promise((resolve, reject) => {
        let settled = false;
        const stopTimer = scheduleTimeout(() => {
          settled = true;
          sessions.delete('request:' + id);
          reject(new Error('worker request timed out after ' + REQUEST_TIMEOUT_MS + ' ms'));
        }, REQUEST_TIMEOUT_MS);
        const finish = (fn) => (value) => {
          if (settled) return;
          settled = true;
          try {
            stopTimer();
          } catch (_) {}
          fn(value);
        };
        sessions.set('request:' + id, { resolve: finish(resolve), reject: finish(reject) });
        try {
          handle.stdin.write(JSON.stringify({ id: id, method: method, params: params }) + '\n');
        } catch (error) {
          sessions.delete('request:' + id);
          finish(reject)(error);
        }
      });
    }

    async function resolveApiKey() {
      try {
        if (credentials && typeof credentials.resolve === 'function') {
          const resolved = await credentials.resolve({ namespace: 'mahjong', name: 'LLM_API_KEY' });
          if (typeof resolved === 'string') return resolved;
          if (isObject(resolved) && typeof resolved.value === 'string') return resolved.value;
        }
      } catch (_) {}
      return '';
    }

    /** Tool-call ids are stable across host and client, so the card can derive the session id. */
    function sessionIdFor(exec) {
      const callId = isObject(exec) && exec.callId !== undefined ? String(exec.callId) : '';
      if (callId) return 'mj-' + callId;
      return 'mj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }

    async function start(args, exec) {
      const input = isObject(args) ? args : {};
      if (exec) lastExec = exec;
      // The dynamic path cannot deliver plugin config, so the tool call itself is the
      // supported place to name the checkout when the session cwd is not the repo.
      if (typeof input.workspace === 'string' && input.workspace) {
        workspaceCache = input.workspace.replace(/[\\/]+$/, '');
      }
      if (typeof input.python === 'string' && input.python) pythonOverride = input.python;
      if (input.viewerPort !== undefined && input.viewerPort !== null) {
        VIEWER_PORT = normalizePort(input.viewerPort, VIEWER_PORT);
      }
      ensureViewer(exec);
      const apiKey = await resolveApiKey();
      const sessionId = sessionIdFor(exec);
      sessions.set(sessionId, { state: { sessionId: sessionId, status: 'starting' }, events: [] });
      let result;
      try {
        result = await send(
          'session.start',
          {
            sessionId: sessionId,
            seed: input.seed !== undefined && input.seed !== null ? Number(input.seed) : 7,
            model: input.model || MODEL,
            apiKey: apiKey,
            baseUrl: BASE_URL,
            budget: input.budget !== undefined && input.budget !== null ? Number(input.budget) : undefined,
            mock: !!input.mock,
            logDir: logDir(resolveWorkspace(exec)),
          },
          exec
        );
      } catch (error) {
        sessions.delete(sessionId);
        throw error;
      }
      const state = safeState(result);
      state.viewerUrl = viewerUrl(sessionId);
      const entry = sessions.get(sessionId) || { events: [] };
      entry.state = state;
      sessions.set(sessionId, entry);
      return state;
    }

    async function status(args, exec) {
      if (exec) lastExec = exec;
      const sessionId = args && args.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      const local = sessions.get(sessionId);
      try {
        const result = await send('session.status', { sessionId: sessionId }, exec);
        const state = safeState(result);
        state.viewerUrl = viewerUrl(sessionId);
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
            error: local.state.error || String((error && error.message) || error),
          });
        }
        throw error;
      }
    }

    async function exportSession(args, exec) {
      if (exec) lastExec = exec;
      const sessionId = args && args.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      const result = await send('session.export', { sessionId: sessionId }, exec);
      const state = safeState(result);
      state.viewerUrl = viewerUrl(sessionId);
      const local = sessions.get(sessionId);
      if (local && local.events.length) {
        state.events = local.events.slice();
        state.eventCount = local.events.length;
      }
      return state;
    }

    async function cancel(args, exec) {
      if (exec) lastExec = exec;
      const sessionId = args && args.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      const state = safeState(await send('session.cancel', { sessionId: sessionId }, exec));
      state.viewerUrl = viewerUrl(sessionId);
      return state;
    }

    function renderJson(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value) }];
    }

    const OUTPUT = { schema: { type: 'json' }, render: renderJson };

    harness.registerTool(
      ctx,
      harness.defineTool({
        name: 'mahjong_start',
        description:
          '开始一局日本麻将（对话内紧凑卡片，不自动全屏）。可选 seed / mock / budget / model。未配置 LLM_API_KEY 时用 mock=true 走规则引擎。',
        parameters: {
          seed: { type: 'number', description: '牌局种子，默认 7' },
          mock: { type: 'boolean', description: 'true 时用规则引擎代替真实 LLM' },
          budget: { type: 'number', description: '真实 LLM 调用预算上限' },
          model: { type: 'string', description: 'OpenAI-compatible 模型 ID' },
          workspace: {
            type: 'string',
            description: 'mahjong-harness 仓库绝对路径；动态插件路径拿不到 config，会话 cwd 不在仓库时用它显式指定',
          },
          python: { type: 'string', description: 'Python 可执行文件，默认 python3' },
          viewerPort: { type: 'number', description: '本机回放服务端口，默认 8765' },
        },
        output: OUTPUT,
        async execute(args, exec) {
          return plain(await start(args, exec));
        },
      })
    );

    harness.registerTool(
      ctx,
      harness.defineTool({
        name: 'mahjong_status',
        description: '查询日本麻将对局状态：比分、事件数、违规、兜底与回放地址。',
        parameters: { sessionId: { type: 'string', required: true, description: 'mahjong_start 返回的 sessionId' } },
        output: OUTPUT,
        async execute(args, exec) {
          return plain(await status(args, exec));
        },
      })
    );

    harness.registerTool(
      ctx,
      harness.defineTool({
        name: 'mahjong_cancel',
        description: '取消一局仍在运行的日本麻将；worker 会尽快停下当前决策。',
        parameters: { sessionId: { type: 'string', required: true, description: '要取消的 sessionId' } },
        output: OUTPUT,
        async execute(args, exec) {
          return plain(await cancel(args, exec));
        },
      })
    );

    harness.registerTool(
      ctx,
      harness.defineTool({
        name: 'mahjong_export',
        description: '导出一局的 MJAI 事件与统计；不包含 prompt 或密钥。',
        parameters: { sessionId: { type: 'string', required: true, description: '要导出的 sessionId' } },
        output: OUTPUT,
        async execute(args, exec) {
          return plain(await exportSession(args, exec));
        },
      })
    );

    // Client half bridge: the browser card polls through `host.call(...)`.
    if (harness && typeof harness.handle === 'function') {
      harness.handle('mahjong.status', async (args) => plain(await status(args, lastExec)));
      harness.handle('mahjong.export', async (args) => plain(await exportSession(args, lastExec)));
      harness.handle('mahjong.cancel', async (args) => plain(await cancel(args, lastExec)));
    }

    ctx.effect(function () {
      return function () {
        disposed = true;
        const dyingWorker = worker;
        const dyingViewer = viewer;
        worker = undefined;
        viewer = undefined;
        viewerReady = false;
        for (const [key, session] of sessions) {
          if (key.indexOf('request:') === 0) {
            try {
              session.reject(new Error('mahjong plugin disposed'));
            } catch (_) {}
          }
        }
        sessions.clear();
        for (const handle of [dyingWorker, dyingViewer]) {
          if (!handle) continue;
          try {
            handle.terminate();
          } catch (_) {}
        }
      };
    }, 'mahjong-worker');

    console.log(
      '[mahjong] viewer=http://' + VIEWER_HOST + ':' + VIEWER_PORT + ' workspace=' + (CONFIGURED_WORKSPACE || '(auto-probe)')
    );
  },
};
