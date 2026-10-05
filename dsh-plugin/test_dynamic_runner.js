#!/usr/bin/env node
'use strict';

/**
 * DSH dynamic-plugin end-to-end test — the REAL Cordis runner path.
 *
 * `test_host_contract.js` supplies its own contract-faithful sandbox replica.
 * This file instead drives `@deepseek-ai/dsh-cordis-host-runner`'s
 * `DynamicCordisRunnerService`, which is the exact service behind the
 * `cordis_define` / `cordis_run` tools:
 *
 *   runner.define(...)      real `precheckCode`, real plugin/package registry, real ids
 *   runner.run(agent, ...)  real `startHostHalf` → real `createSandbox` +
 *                           `evaluateHostCode` + `sandboxContext`/`guardedPlugin`
 *                           → real `ToolRuntime.register`
 *   runner.stop(agent, ...) real retraction, then disposal assertions
 *
 * Two things only this test can prove:
 *   1. the host half loads and registers its tools under the real sandbox and the
 *      real declared-inject guard — a missing `inject: ['tools']` or a tool
 *      without the `harness.defineTool` marker fails here, not in a replica;
 *   2. `DynamicCordisRunnerService.run()` mounts the host half with
 *      `ctx.plugin(guardedPlugin(plugin))` and **no config**, so the checkout path
 *      must come from `exec.agent.session.header.cwd` (or the tool's explicit
 *      `workspace` argument). This test uses a realistic Agent and no config.
 *
 * Run: node dsh-plugin/test_dynamic_runner.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  PLUGIN_DIR,
  REPO,
  loadEsm,
  createSubprocessService,
  createCredentialsService,
  createSystemPromptService,
  freePort,
  httpGet,
  portRefuses,
  pidAlive,
  sleep,
  createReporter,
} = require('./test_support.cjs');

const PYTHON = process.env.DSH_MAHJONG_PYTHON || 'python3';
const MAHJONG_TOOLS = ['mahjong_start', 'mahjong_status', 'mahjong_cancel', 'mahjong_export'];
const reporter = createReporter('DSH 动态插件真实运行器测试 — cordis_define / cordis_run 同款路径');

/** The subset of `Agent` the runner touches, plus the durable header that carries the cwd. */
function createAgentStub(sessionId, cwd) {
  return {
    id: sessionId,
    status: 'running',
    options: {},
    inbox: { enqueue: () => {} },
    session: { header: { id: sessionId, cwd } },
    cancel() {},
    whenIdle: async () => {},
    async runMaintenance(task) {
      return task(new AbortController().signal);
    },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  };
}

async function main() {
  reporter.header([' Python: ' + PYTHON, ' Node: ' + process.version]);

  const cordisMod = await loadEsm('@deepseek-ai/cordis');
  const toolsMod = await loadEsm('@deepseek-ai/dsh-tools');
  const timerMod = await loadEsm('@deepseek-ai/cordis-plugin-timer');
  const runnerMod = await loadEsm('@deepseek-ai/dsh-cordis-host-runner');

  if (!cordisMod || !toolsMod || !timerMod || !runnerMod) {
    reporter.skip(
      'real DSH runner available',
      'cordis=' +
        !!cordisMod +
        ' dsh-tools=' +
        !!toolsMod +
        ' timer=' +
        !!timerMod +
        ' cordis-host-runner=' +
        !!runnerMod +
        ' (set DSH_MAHJONG_DSH_ROOT)'
    );
    reporter.summary();
    return reporter.fail > 0 ? 1 : 0;
  }

  const { Context } = cordisMod;
  const Runner = runnerMod.default ?? runnerMod.DynamicCordisRunnerService;
  console.log('运行时: 真实 cordis + 真实 ToolRuntime + 真实 DynamicCordisRunnerService');
  console.log('');

  const hostSource = fs.readFileSync(path.join(PLUGIN_DIR, 'host.js'), 'utf8');
  const subprocess = createSubprocessService();
  const ctx = new Context();
  ctx.provide('systemPrompt', createSystemPromptService());
  ctx.provide('credentials', createCredentialsService(process.env.LLM_API_KEY || ''));
  ctx.provide('subprocess', subprocess);
  await ctx.plugin(toolsMod.default);
  await ctx.plugin(timerMod.default ?? timerMod);
  await ctx.plugin(Runner, { vmTimeoutMs: 5000, clientInspectTimeoutMs: 10000 });
  await sleep(0);

  const tools = ctx.get('tools');
  const runner = ctx.get('dynamicCordisRunner');
  const SESSION_ID = 'session-dynamic-runner-test';
  const agent = createAgentStub(SESSION_ID, REPO);
  const viewerPort = await freePort();

  let callSeq = 0;
  const exec = (name) => ({
    callId: 'call-' + ++callSeq,
    name: name,
    arguments: {},
    signal: new AbortController().signal,
    agent,
  });

  // ---------------------------------------------------------------- [1]
  console.log('[1] cordis_define 同款：runner.define()');

  let defined;
  await reporter.check('define 通过真实 precheckCode 并铸出 plugin / package id', () => {
    defined = runner.define({
      sessionId: SESSION_ID,
      name: 'dsh-mahjong-runtime-live-card',
      purpose: '对话内日本麻将运行时：四个工具 + 紧凑卡片 + MJAI 导出',
      plugin: { kind: 'new', idPrefix: 'mjai' },
      code: { host: hostSource },
    });
    assert.match(defined.pluginId, /^mjai-\d+$/, 'pluginId should carry the minted prefix');
    assert.ok(defined.packageId, 'packageId missing');
    assert.strictEqual(defined.hasHostHalf, true);
    assert.strictEqual(defined.hasClientHalf, false);
    return defined.pluginId + ' / ' + defined.packageId;
  });

  await reporter.check('未闭合的 code.host 在 define 阶段即被拒绝', () => {
    assert.throws(
      () =>
        runner.define({
          sessionId: SESSION_ID,
          name: 'bad',
          purpose: 'bad',
          plugin: { kind: 'new', idPrefix: 'badx' },
          code: { host: 'return { apply(ctx) { ' },
        }),
      /failed to parse/
    );
    return 'precheckCode 拦截了语法错误';
  });

  // ---------------------------------------------------------------- [2]
  console.log('');
  console.log('[2] cordis_run 同款：runner.run()');

  let started;
  await reporter.check('run 直接挂载 host 半边（无 client 半边 → 无需批准）', async () => {
    started = await runner.run(agent, defined.pluginId, defined.packageId, 'run');
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.deepStrictEqual(started.waitingFor, [], 'every injected service should already exist');
    return 'pluginRunId=' + started.pluginRunId;
  });

  await reporter.check('真实沙箱挂载后 ToolRuntime 里出现四个工具', () => {
    const names = tools.schemas().map((schema) => schema.name);
    for (const expected of MAHJONG_TOOLS) assert.ok(names.includes(expected), 'missing ' + expected);
    return names.filter((name) => name.startsWith('mahjong_')).join(', ');
  });

  await reporter.check('工具可执行体可从真实注册表取回', () => {
    for (const name of MAHJONG_TOOLS) {
      const definition = tools.get(name);
      assert.ok(definition && typeof definition.execute === 'function', name + ' has no execute');
      assert.strictEqual(definition.parameters.type, 'object', name + ' parameters root');
    }
    return '四个工具的 execute + JSON Schema 均来自 ToolRuntime';
  });

  await reporter.check('运行器 inventory 记录该插件在运行（结构化字段）', () => {
    // inventory() is plain data; snapshot() carries live fibers, which must not be serialized.
    const rows = runner.inventory();
    const row = rows.find((entry) => entry.pluginId === defined.pluginId);
    assert.ok(row, 'inventory missing the plugin');
    assert.strictEqual(row.agentId, SESSION_ID);
    assert.ok(row.packages.some((pkg) => pkg.packageId === defined.packageId && pkg.hasHostHalf), 'package row missing');
    assert.ok(row.activeRun && row.activeRun.packageId === defined.packageId, 'plugin is not marked running');
    assert.strictEqual(row.currentPackageId, defined.packageId, 'currentPackageId should point at the run package');
    return row.pluginId + ' activeRun=' + row.activeRun.pluginRunId + ' current=' + row.currentPackageId;
  });

  await reporter.check('run 对未知 pluginId 返回 plugin-missing', async () => {
    const refused = await runner.run(agent, 'mjai-99999', 'pkg-99999', 'run');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'plugin-missing');
    return 'reason=' + refused.reason;
  });

  // ---------------------------------------------------------------- [3]
  console.log('');
  console.log('[3] 无插件 config：workspace 只能来自 exec.agent.session.header.cwd');

  let result;
  await reporter.check('mahjong_start(mock, seed=7) 在零 config 下正常开局', async () => {
    const definition = tools.get('mahjong_start');
    result = await definition.execute({ seed: 7, mock: true, budget: 0, viewerPort }, exec('mahjong_start'));
    assert.match(result.sessionId, /^mj-call-\d+$/, 'sessionId derives from the tool-call id');
    assert.strictEqual(result.scores.length, 4);
    assert.strictEqual(
      result.scores.reduce((a, b) => a + b, 0),
      100000,
      'scores should sum to 100000'
    );
    return result.sessionId + ' status=' + result.status + ' scores=' + JSON.stringify(result.scores);
  });

  // ---------------------------------------------------------------- [4]
  console.log('');
  console.log('[4] 展开牌桌 → iframe 回放服务');

  let state;
  await reporter.check('轮询拿到 viewerUrl 且事件持续增长', async () => {
    const definition = tools.get('mahjong_status');
    const deadline = Date.now() + 30000;
    let last = null;
    while (Date.now() < deadline) {
      last = await definition.execute({ sessionId: result.sessionId }, exec('mahjong_status'));
      if (last.viewerUrl && Number(last.eventCount) > 0) break;
      if (last.status === 'ended') break;
      await sleep(400);
    }
    state = last;
    assert.ok(state.viewerUrl, 'viewerUrl never appeared');
    assert.match(state.viewerUrl, new RegExp('^http://127\\.0\\.0\\.1:' + viewerPort + '/view/'));
    return state.viewerUrl + ' eventCount=' + state.eventCount;
  });

  await reporter.check('viewerUrl 返回可 iframe 的 HTML 并注入事件', async () => {
    const response = await httpGet(state.viewerUrl);
    assert.strictEqual(response.status, 200, 'viewer status');
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.ok(response.body.includes('__INJECTED_EVENTS__'), 'injected-events script missing');
    assert.ok(response.body.includes(result.sessionId), 'session id not embedded');
    return response.body.length + ' bytes';
  });

  await reporter.check('/api/events/<sessionId> 返回事件数组', async () => {
    const response = await httpGet('http://127.0.0.1:' + viewerPort + '/api/events/' + result.sessionId);
    assert.strictEqual(response.status, 200, 'events status');
    const events = JSON.parse(response.body);
    assert.ok(Array.isArray(events) && events.length > 0, 'expected events');
    return events.length + ' events';
  });

  // ---------------------------------------------------------------- [5]
  console.log('');
  console.log('[5] 取消与导出');

  await reporter.check('mahjong_cancel 在 5s 内返回', async () => {
    const definition = tools.get('mahjong_cancel');
    const before = Date.now();
    const cancelled = await definition.execute({ sessionId: result.sessionId }, exec('mahjong_cancel'));
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 5000, 'cancel took ' + elapsed + 'ms');
    return elapsed + 'ms, status=' + cancelled.status;
  });

  await reporter.check('mahjong_export 返回事件且不含密钥', async () => {
    const definition = tools.get('mahjong_export');
    const exported = await definition.execute({ sessionId: result.sessionId }, exec('mahjong_export'));
    assert.ok(Array.isArray(exported.events) && exported.events.length > 0, 'expected events');
    const serialized = JSON.stringify(exported);
    for (const needle of ['apiKey', 'api_key', 'prompt']) {
      assert.ok(!serialized.includes(needle), 'leaked ' + needle);
    }
    return exported.events.length + ' events';
  });

  // ---------------------------------------------------------------- [6]
  console.log('');
  console.log('[6] cordis_stop 同款：runner.stop() 卸载清理');

  const pids = subprocess.spawned.map((record) => record.pid);
  const roles = subprocess.spawned.map((record) =>
    record.spec.argv.join(' ').includes('serve_logs') ? 'viewer' : 'worker'
  );
  await reporter.check('运行期间确实拉起了 worker 与 viewer', () => {
    assert.ok(roles.includes('worker'), 'no worker spawned');
    assert.ok(roles.includes('viewer'), 'no viewer spawned');
    return pids.length + ' 个子进程: ' + pids.join(', ');
  });

  await reporter.check('runner.stop() 成功并注销四个工具', async () => {
    const stopped = await runner.stop(agent, defined.pluginId);
    assert.strictEqual(stopped.ok, true, JSON.stringify(stopped));
    await sleep(300);
    const remaining = tools
      .schemas()
      .map((schema) => schema.name)
      .filter((name) => name.startsWith('mahjong_'));
    assert.deepStrictEqual(remaining, [], 'tools survived the stop: ' + remaining.join(', '));
    return '四个工具已随插件 fiber 一并注销';
  });

  await reporter.check('worker / viewer 子进程均已退出', async () => {
    const deadline = Date.now() + 8000;
    let alive = pids.filter((pid) => pidAlive(pid));
    while (alive.length > 0 && Date.now() < deadline) {
      await sleep(250);
      alive = pids.filter((pid) => pidAlive(pid));
    }
    assert.deepStrictEqual(alive, [], 'still alive: ' + JSON.stringify(alive));
    return pids.length + ' 个子进程全部回收';
  });

  await reporter.check('回放端口已释放', async () => {
    const deadline = Date.now() + 8000;
    let refused = await portRefuses(viewerPort);
    while (!refused && Date.now() < deadline) {
      await sleep(250);
      refused = await portRefuses(viewerPort);
    }
    assert.ok(refused, 'port ' + viewerPort + ' still accepting connections');
    return '127.0.0.1:' + viewerPort + ' 拒绝连接';
  });

  reporter.summary();
  return reporter.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('动态运行器测试异常: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
