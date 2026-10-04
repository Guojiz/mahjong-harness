#!/usr/bin/env node
'use strict';

/**
 * DSH host-level integration test for `dsh-plugin/host.js`.
 *
 * What it proves (the four items that `HANDOFF_RESULTS.md` used to list as
 * "尚待 DSH 宿主验收"):
 *   1. the host half loads under the real dynamic-package sandbox contract and
 *      registers exactly four tools through `harness.defineTool` +
 *      `harness.registerTool` + the REAL `@deepseek-ai/dsh-tools` ToolRuntime;
 *   2. `mahjong_start` yields the compact-card payload (session id derived from
 *      the tool-call id, four scores, viewer url, no secret fields);
 *   3. the returned viewer url really serves the iframe-able HTML and the event API;
 *   4. `mahjong_cancel` stays responsive and disposal stops both child processes
 *      and releases the viewer port.
 *
 * How it stays honest:
 *   - `host.js` is compiled and executed the way DSH does it: as the BODY of an
 *     async function inside a vm context whose globals are exactly the sandbox's
 *     (`harness`, `console`, encoding primitives) plus throwing traps for
 *     `require` / `setTimeout` / `fetch`. A `require` anywhere in the file fails here.
 *   - the tool registry, the timer service and the cordis runtime are the real
 *     published packages when they are installed.
 *   - the `subprocess` service is a local double that implements the documented
 *     `SubprocessHandle` surface (see `assertSubprocessContractParity`, which
 *     cross-checks the double against the real `@deepseek-ai/dsh-subprocess-local`
 *     runtime on this machine when it is available). The double is used so the
 *     test can observe the exact child pids it must prove dead after disposal.
 *
 * Run: node dsh-plugin/test_host_contract.js
 *   SKIP_PARITY=1   skip the real-runtime contract parity cross-check
 */

const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const PLUGIN_DIR = __dirname;
const REPO = path.resolve(PLUGIN_DIR, '..');
const PYTHON = process.env.DSH_MAHJONG_PYTHON || 'python3';
const SANDBOX_FILENAME = 'cordis-dyn-test.js';

let PASS = 0;
let FAIL = 0;
let SKIP = 0;

function ok(name, detail) {
  PASS += 1;
  console.log('  \u2713 ' + name + (detail ? ' \u2014 ' + detail : ''));
}

function bad(name, error) {
  FAIL += 1;
  console.log('  \u2717 ' + name + ' \u2014 ' + (error && error.message ? error.message : String(error)));
}

function skip(name, why) {
  SKIP += 1;
  console.log('  \u25cb ' + name + (why ? ' \u2014 ' + why : ''));
}

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (error) {
    bad(name, error);
  }
}

/* ------------------------------------------------------------------ *
 * DSH runtime resolution
 * ------------------------------------------------------------------ */

const HOME = os.homedir();
const DSH_SEARCH_ROOTS = [
  process.env.DSH_MAHJONG_DSH_ROOT,
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  path.join(HOME, '.npm-global/lib/node_modules/@deepseek-ai/dsh'),
  path.join(HOME, '.dsh/profiles'),
].filter(Boolean);

function resolveFromDshInstall(name) {
  for (const root of DSH_SEARCH_ROOTS) {
    for (const candidate of [path.join(root, 'node_modules', name), path.join(root, name)]) {
      try {
        return require.resolve(candidate);
      } catch (_) {}
    }
  }
  return '';
}

async function loadEsm(spec, fromFile) {
  const requireFrom = createRequire(fromFile);
  let resolved = '';
  try {
    resolved = requireFrom.resolve(spec);
  } catch (_) {
    resolved = resolveFromDshInstall(spec);
  }
  if (!resolved) return null;
  return import(pathToFileURL(resolved).href);
}

/* ------------------------------------------------------------------ *
 * Sandbox replica (mirrors @deepseek-ai/dsh-cordis-host-runner)
 * ------------------------------------------------------------------ */

const TIMER_REDIRECT =
  'Node timers are unavailable. Use the cordis timer service instead: declare inject: ' +
  "['timer'] on your plugin and call ctx.timeout / ctx.interval.";
const NODE_API_REDIRECTS = {
  require: 'Node modules are unavailable. Use the cordis services on ctx instead.',
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  setImmediate: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch: 'Network access goes through the cordis web service.',
};

const DYNAMIC_TOOL = Symbol('cordis-host-runner.dynamic-tool');

function markDynamicTool(tool) {
  Object.defineProperty(tool, DYNAMIC_TOOL, { value: true });
  return tool;
}

function assertDynamicTool(tool) {
  if (!tool || typeof tool !== 'object' || tool[DYNAMIC_TOOL] !== true) {
    throw new Error('dynamic tool registration must use a tool returned by harness.defineTool(...)');
  }
}

/** Faithful port of `sandboxDefineTool`: normalize, validate, JSON-clone, mark. */
function makeSandboxDefineTool(defineTool) {
  return function sandboxDefineTool(options) {
    if (!options || typeof options !== 'object') throw new Error('harness.defineTool options must be an object');
    if (!options.output || typeof options.output !== 'object') {
      throw new Error('harness.defineTool output must declare { schema, render, presentationMeta? }');
    }
    if (typeof options.output.render !== 'function') {
      throw new Error('harness.defineTool output.render must be a function');
    }
    if (typeof options.execute !== 'function') throw new Error('harness.defineTool execute must be a function');
    const tool = defineTool({
      ...options,
      output: {
        schema: options.output.schema,
        render(args, value) {
          const rendered = options.output.render(args, value);
          if (!Array.isArray(rendered) || !rendered.every((b) => b && typeof b.type === 'string')) {
            throw new Error('output.render must return an ARRAY of content blocks');
          }
          return rendered;
        },
      },
    });
    return markDynamicTool(tool);
  };
}

function createSandbox(options) {
  const sandbox = {};
  for (const [name, message] of Object.entries(NODE_API_REDIRECTS)) {
    sandbox[name] = () => {
      throw new Error(name + ' is not available in the dynamic package sandbox \u2014 ' + message);
    };
  }
  sandbox.console = console;
  sandbox.btoa = (s) => Buffer.from(String(s), 'utf-8').toString('base64');
  sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('utf-8');
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.harness = {
    defineTool: options.defineTool,
    registerTool(ctx, tool) {
      assertDynamicTool(tool);
      if (typeof options.onRegister === 'function') options.onRegister(tool);
      return ctx.tools.register(tool);
    },
    handle: options.handle,
  };
  vm.createContext(sandbox);
  return sandbox;
}

/** Faithful port of `sandboxContext`: declared-service gate over a live ctx. */
function sandboxContext(ctx, declared) {
  const denyRead = (prop) => {
    throw new Error('sandbox ctx does not expose "' + prop + '" (not declared in inject)');
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'tools') return ctx.tools;
        if (prop === 'get') return (name) => ctx.get(name);
        if (typeof prop !== 'string') return undefined;
        if (CTX_VERBS.has(prop)) {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer');
          return (...args) => ctx[prop](...args);
        }
        if (!declared.has(prop)) return denyRead(prop);
        return ctx[prop];
      },
      set() {
        throw new Error('sandbox ctx is read-only');
      },
    }
  );
}

const CTX_VERBS = new Set(['effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce']);
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce']);

function guardedPlugin(plugin, declared) {
  return {
    ...plugin,
    apply(ctx, config) {
      return plugin.apply(sandboxContext(ctx, declared), config);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Service doubles implementing the published contracts
 * ------------------------------------------------------------------ */

/** `SubprocessHandle` per the published service contract, backed by node:child_process. */
function createSubprocessService() {
  const spawned = [];
  const live = new Set();
  return {
    spawned,
    live,
    spawn(spec) {
      const stdio = spec.stdio || {};
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: Object.assign({}, process.env, spec.env || {}),
        stdio: [
          stdio.stdin === 'pipe' ? 'pipe' : 'ignore',
          stdio.stdout === 'pipe' ? 'pipe' : 'ignore',
          stdio.stderr === 'pipe' ? 'pipe' : 'ignore',
        ],
      });
      let killed = false;
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      const collectMode = stdio.stderr && typeof stdio.stderr === 'object';
      const handle = {
        pid: child.pid,
        stdin: child.stdin || undefined,
        stdout: child.stdout || undefined,
        // Collect-mode outputs are read through `collected`, not a piped stream.
        stderr: collectMode ? undefined : child.stderr || undefined,
        collected: {},
        done,
        terminate() {
          if (killed) return;
          killed = true;
          try {
            child.kill('SIGTERM');
          } catch (_) {}
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch (_) {}
          }, spec.graceMs || 1500);
          if (timer.unref) timer.unref();
        },
        async waitForExit() {
          try {
            await done;
            return true;
          } catch (_) {
            return false;
          }
        },
      };
      const record = { spec, handle, pid: child.pid };
      spawned.push(record);
      live.add(record);
      done.then(
        () => live.delete(record),
        () => live.delete(record)
      );
      return handle;
    },
  };
}

/** `credentials.resolve` returns `{ value, source } | undefined`, never a bare string. */
function createCredentialsService(value) {
  return {
    async resolve() {
      return value ? { value, source: 'test' } : undefined;
    },
    async describe() {
      return { configured: !!value, source: value ? 'test' : undefined, writable: true };
    },
  };
}

function createSystemPromptService() {
  return {
    section: () => () => {},
    context: () => () => {},
    suppressRuntimeContext: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    async assemble() {
      return { sections: [] };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = require('node:http').get(url, { timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('timeout', () => request.destroy(new Error('http timeout')));
    request.on('error', reject);
  });
}

function portRefuses(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Contract parity cross-check against the real local runtime on this machine. */
async function assertSubprocessContractParity(python) {
  const mod = await loadEsm('@deepseek-ai/dsh-subprocess-local', path.join(PLUGIN_DIR, 'index.cjs'));
  if (!mod) throw new Error('@deepseek-ai/dsh-subprocess-local is not resolvable on this machine');
  const { Context } = (await loadEsm('@deepseek-ai/cordis', path.join(PLUGIN_DIR, 'index.cjs'))) || {};
  if (!Context) throw new Error('@deepseek-ai/cordis is not resolvable on this machine');
  const ctx = new Context();
  await ctx.plugin(mod.default ?? mod);
  await sleep(0);
  const service = ctx.get('subprocess');
  const handle = service.spawn({
    argv: [python, '-c', 'print("parity")'],
    cwd: REPO,
    graceMs: 500,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1000 } },
  });
  let out = '';
  handle.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  const outcome = await handle.done;
  handle.terminate();
  assert.strictEqual(out.trim(), 'parity', 'real runtime stdout');
  assert.strictEqual(outcome.exitCode, 0, 'real runtime exitCode');
  assert.strictEqual(typeof handle.on, 'undefined', 'SubprocessHandle has no EventEmitter .on()');
  assert.strictEqual(typeof handle.terminate, 'function', 'SubprocessHandle.terminate');
  assert.strictEqual(handle.stderr, undefined, 'collect-mode stderr is not a piped stream');
  return 'real runtime: no handle.on(), collect-mode stderr undefined, done -> { exitCode, signal }';
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  console.log('============================================');
  console.log(' DSH 宿主级集成测试 — dsh-plugin/host.js');
  console.log(' 时间: ' + new Date().toISOString());
  console.log(' Python: ' + PYTHON);
  console.log(' Node: ' + process.version);
  console.log('============================================');
  console.log('');

  const cordisMod = await loadEsm('@deepseek-ai/cordis', path.join(PLUGIN_DIR, 'index.cjs'));
  const toolsMod = await loadEsm('@deepseek-ai/dsh-tools', path.join(PLUGIN_DIR, 'index.cjs'));
  const timerMod = await loadEsm('@deepseek-ai/cordis-plugin-timer', path.join(PLUGIN_DIR, 'index.cjs'));

  if (!cordisMod || !toolsMod || !timerMod) {
    skip(
      'real DSH runtime available',
      'cordis=' + !!cordisMod + ' dsh-tools=' + !!toolsMod + ' timer=' + !!timerMod + ' (install the DSH package or set DSH_MAHJONG_DSH_ROOT)'
    );
    console.log('');
    console.log('结果: ' + PASS + ' 通过, ' + FAIL + ' 失败, ' + SKIP + ' 跳过');
    process.exit(FAIL > 0 ? 1 : 0);
  }

  const { Context } = cordisMod;
  const { defineTool } = toolsMod;
  const ToolRuntime = toolsMod.default;
  console.log('运行时: 真实 cordis + 真实 dsh-tools ToolRuntime + 真实 cordis-plugin-timer');
  console.log('');

  const pythonOk = await new Promise((resolve) => {
    const probe = spawn(PYTHON, ['-c', 'import sys; print(sys.version)'], { stdio: 'ignore' });
    probe.once('error', () => resolve(false));
    probe.once('close', (code) => resolve(code === 0));
  });
  if (!pythonOk) {
    skip('python available', PYTHON + ' not runnable');
    console.log('结果: ' + PASS + ' 通过, ' + FAIL + ' 失败, ' + SKIP + ' 跳过');
    process.exit(1);
  }

  if (process.env.SKIP_PARITY === '1') {
    skip('subprocess contract parity', 'SKIP_PARITY=1');
  } else {
    await check('subprocess contract parity vs real dsh-subprocess-local', () => assertSubprocessContractParity(PYTHON));
  }

  // ---- 1. Sandbox load -------------------------------------------------
  console.log('');
  console.log('[1] 动态包沙箱加载 host.js');

  const handlers = new Map();
  const registered = new Map();
  const subprocess = createSubprocessService();
  const sandbox = createSandbox({
    defineTool: makeSandboxDefineTool(defineTool),
    handle: (method, fn) => handlers.set(method, fn),
    onRegister: (tool) => registered.set(tool.name, tool),
  });

  const hostSource = fs.readFileSync(path.join(PLUGIN_DIR, 'host.js'), 'utf8');
  let plugin;
  await check('host.js 在沙箱里编译并返回 cordis plugin', async () => {
    const evaluate = vm.runInContext('(async () => {\n' + hostSource + '\n})()', sandbox, {
      filename: SANDBOX_FILENAME,
      timeout: 5000,
    });
    plugin = await evaluate;
    assert.ok(plugin && typeof plugin.apply === 'function', 'plugin.apply must be a function');
    return 'name=' + plugin.name + ' inject=' + JSON.stringify(plugin.inject);
  });

  await check('沙箱陷阱仍然生效（require / setTimeout / fetch 抛错）', () => {
    assert.throws(() => sandbox.require('node:fs'), /not available in the dynamic package sandbox/);
    assert.throws(() => sandbox.setTimeout(() => {}, 1), /Node timers are unavailable/);
    assert.throws(() => sandbox.fetch('http://x'), /cordis web service/);
    return 'host.js 没有触碰到被禁用的 Node API';
  });

  // ---- 2. Real cordis mount -------------------------------------------
  console.log('');
  console.log('[2] 真实 cordis 挂载与四工具注册');

  const ctx = new Context();
  ctx.provide('systemPrompt', createSystemPromptService());
  ctx.provide('credentials', createCredentialsService(process.env.LLM_API_KEY || ''));
  ctx.provide('subprocess', subprocess);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(timerMod.default ?? timerMod);
  await sleep(0);

  const port = await freePort();
  const declared = new Set(plugin.inject || []);
  const pluginFiber = ctx.plugin(guardedPlugin(plugin, declared), {
    workspace: REPO,
    python: PYTHON,
    viewerHost: '127.0.0.1',
    viewerPort: port,
  });
  await sleep(0);
  if (process.env.DEBUG_FIBER === '1') {
    console.log('DEBUG fiber state=' + pluginFiber.state + ' error=' + (pluginFiber._error && pluginFiber._error.stack || pluginFiber._error));
  }

  const tools = ctx.get('tools');
  const EXPECTED = ['mahjong_start', 'mahjong_status', 'mahjong_cancel', 'mahjong_export'];
  let callSeq = 0;
  const exec = () => ({ callId: 'call-' + ++callSeq, agent: { cwd: REPO } });

  await check('真实 ToolRuntime 中出现四个工具', () => {
    const names = tools.schemas().map((schema) => schema.name);
    for (const name of EXPECTED) assert.ok(names.includes(name), 'missing tool ' + name);
    assert.strictEqual(names.filter((n) => EXPECTED.includes(n)).length, 4, 'exactly four mahjong tools');
    return names.filter((n) => EXPECTED.includes(n)).join(', ');
  });

  await check('工具参数是合法的对象 JSON Schema', () => {
    for (const name of EXPECTED) {
      const parameters = registered.get(name).parameters;
      assert.strictEqual(parameters.type, 'object', name + ' root type');
      assert.ok(parameters.properties && typeof parameters.properties === 'object', name + ' properties');
    }
    const status = registered.get('mahjong_status').parameters;
    assert.deepStrictEqual(status.required, ['sessionId'], 'sessionId required');
    return 'mahjong_status.required=' + JSON.stringify(status.required);
  });

  await check('output.render 返回内容块数组', () => {
    for (const name of EXPECTED) {
      const definition = registered.get(name);
      assert.ok(definition, 'definition recorded for ' + name);
      const rendered = definition.output.render({}, { status: 'ok' });
      assert.ok(Array.isArray(rendered) && rendered.length > 0, name + ' render array');
      assert.strictEqual(typeof rendered[0].type, 'string', name + ' content block type');
    }
    return '四种工具均可渲染为 [{ type: "text", … }]';
  });

  await check('注册走的是 harness.defineTool 标记（裸工具会被拒绝）', () => {
    assert.throws(
      () =>
        sandbox.harness.registerTool(
          { tools: { register: () => () => {} } },
          { name: 'raw', description: 'd', parameters: {}, execute: async () => ({}) }
        ),
      /must use a tool returned by harness\.defineTool/
    );
    return '未经过 defineTool 的工具无法注册';
  });

  // ---- 3. mahjong_start ------------------------------------------------
  console.log('');
  console.log('[3] mahjong_start → 紧凑卡片载荷');

  const startExec = exec();
  let started;
  await check('mahjong_start(mock, seed=7) 返回紧凑卡片载荷', async () => {
    const definition = registered.get('mahjong_start');
    started = await definition.execute({ seed: 7, mock: true, budget: 0 }, startExec);
    assert.strictEqual(started.sessionId, 'mj-' + startExec.callId, 'sessionId derives from callId');
    assert.ok(Array.isArray(started.scores) && started.scores.length === 4, 'four scores');
    assert.strictEqual(
      started.scores.reduce((a, b) => a + b, 0),
      100000,
      'scores sum to 100000'
    );
    assert.strictEqual(Number(started.seed), 7, 'seed echoed');
    return 'sessionId=' + started.sessionId + ' status=' + started.status + ' scores=' + JSON.stringify(started.scores);
  });

  await check('载荷不含密钥 / prompt 字段', () => {
    const serialized = JSON.stringify(started);
    for (const needle of ['apiKey', 'api_key', 'prompt', 'SECRET']) {
      assert.ok(serialized.indexOf(needle) < 0, 'leaked ' + needle);
    }
    return '导出载荷未出现 apiKey / prompt';
  });

  // ---- 4. Viewer -------------------------------------------------------
  console.log('');
  console.log('[4] 展开牌桌 → iframe 回放服务');

  let state;
  await check('轮询后拿到 viewerUrl 且事件持续增长', async () => {
    const statusDefinition = registered.get('mahjong_status');
    const deadline = Date.now() + 30000;
    let last = null;
    while (Date.now() < deadline) {
      last = await statusDefinition.execute({ sessionId: started.sessionId }, exec());
      if (last.viewerUrl && Number(last.eventCount) > 0) break;
      if (last.status === 'ended') break;
      await sleep(400);
    }
    state = last;
    assert.ok(state.viewerUrl, 'viewerUrl must appear once the log server is up');
    assert.match(state.viewerUrl, new RegExp('^http://127\\.0\\.0\\.1:' + port + '/view/'));
    return state.viewerUrl + ' eventCount=' + state.eventCount + ' status=' + state.status;
  });

  await check('viewerUrl 返回可 iframe 的 HTML 并注入事件', async () => {
    const response = await httpGet(state.viewerUrl);
    assert.strictEqual(response.status, 200, 'viewer status');
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.ok(response.body.indexOf('__INJECTED_EVENTS__') >= 0, 'injected-events script present');
    assert.ok(response.body.indexOf(started.sessionId) >= 0, 'session id embedded');
    return response.body.length + ' bytes, __INJECTED_EVENTS__ + session id present';
  });

  await check('/api/events/<sessionId> 返回事件数组', async () => {
    const response = await httpGet('http://127.0.0.1:' + port + '/api/events/' + started.sessionId);
    assert.strictEqual(response.status, 200, 'events status');
    const events = JSON.parse(response.body);
    assert.ok(Array.isArray(events), 'events array');
    return events.length + ' events';
  });

  // ---- 5. Cancel latency ----------------------------------------------
  console.log('');
  console.log('[5] 取消时延与导出');

  await check('mahjong_cancel 在 5s 内返回', async () => {
    const definition = registered.get('mahjong_cancel');
    const before = Date.now();
    const cancelled = await definition.execute({ sessionId: started.sessionId }, exec());
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 5000, 'cancel took ' + elapsed + 'ms');
    assert.ok(['cancelling', 'ended', 'cancelled'].includes(cancelled.status), 'status=' + cancelled.status);
    return elapsed + 'ms, status=' + cancelled.status;
  });

  await check('mahjong_export 返回 MJAI 事件且不含密钥', async () => {
    const definition = registered.get('mahjong_export');
    const exported = await definition.execute({ sessionId: started.sessionId }, exec());
    assert.ok(Array.isArray(exported.events), 'events array');
    const serialized = JSON.stringify(exported);
    for (const needle of ['apiKey', 'api_key', 'prompt']) assert.ok(serialized.indexOf(needle) < 0, 'leaked ' + needle);
    return exported.events.length + ' events';
  });

  await check('客户端桥接 hander 已注册（host.call 通道）', async () => {
    assert.ok(handlers.has('mahjong.status'), 'mahjong.status handler');
    assert.ok(handlers.has('mahjong.export'), 'mahjong.export handler');
    const bridged = await handlers.get('mahjong.status')({ sessionId: started.sessionId });
    assert.strictEqual(bridged.sessionId, started.sessionId);
    return Array.from(handlers.keys()).join(', ');
  });

  // ---- 6. Disposal -----------------------------------------------------
  console.log('');
  console.log('[6] 卸载清理');

  const pids = subprocess.spawned.map((record) => record.pid);
  const roles = subprocess.spawned.map((record) => record.spec.argv.join(' ').includes('serve_logs') ? 'viewer' : 'worker');
  assert.ok(roles.includes('viewer'), 'viewer was spawned');
  assert.ok(roles.includes('worker'), 'worker was spawned');

  assert.strictEqual(typeof pluginFiber.dispose, 'function', 'cordis fiber exposes dispose()');
  await pluginFiber.dispose();
  await sleep(2500);

  await check('worker / viewer 子进程均已退出', () => {
    const alive = pids.filter((pid) => pidAlive(pid));
    assert.deepStrictEqual(alive, [], 'still alive: ' + JSON.stringify(alive));
    return pids.length + ' 个子进程全部回收';
  });

  await check('回放端口已释放', async () => {
    const refused = await portRefuses(port);
    assert.ok(refused, 'port ' + port + ' still accepting connections');
    return '127.0.0.1:' + port + ' 拒绝连接';
  });

  console.log('');
  console.log('============================================');
  console.log(' 结果: ' + PASS + ' 通过, ' + FAIL + ' 失败, ' + SKIP + ' 跳过');
  console.log('============================================');
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('集成测试异常: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
