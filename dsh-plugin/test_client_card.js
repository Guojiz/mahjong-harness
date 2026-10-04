#!/usr/bin/env node
'use strict';

/**
 * Slot-level test for `dsh-plugin/client.js` — the in-chat mahjong card.
 *
 * The card is registered into the `tool.call.toolview` slot keyed by
 * `mahjong_start`. That slot's owner props (published by the tool UI package)
 * are `{ callId, toolName, block, cwd, openFile, inspect }`, where `block` is
 * the live call node — `{ callId, name, argsRaw }` while running and
 * `{ kind: 'tool-result', call: { argsRaw } | null, isError, … }` once settled.
 * Raw arguments are a JSON **string**, never a parsed object.
 *
 * What this test proves:
 *   1. the client half registers exactly one `tool.call.toolview` entry keyed
 *      `mahjong_start`;
 *   2. the first paint is the compact card only — no `.mj-detail`, no `<iframe>`,
 *      nothing that would take over the conversation;
 *   3. the explicit "展开牌桌" state renders the detail panel and the fully
 *      qualified viewer `<iframe src=…>` — i.e. the replay is opt-in;
 *   4. the card reads the real slot prop shape (`argsRaw`, running vs settled
 *      node) and derives the mahjong session id from the tool-call id.
 *
 * Rendering uses the real React 18 + `react-dom/server` shipped with DSH, with
 * `useState` driven from a scripted queue so both the collapsed and the expanded
 * paint can be asserted without a browser.
 *
 * Run: node dsh-plugin/test_client_card.js
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const PLUGIN_DIR = __dirname;
const HOME = os.homedir();

let PASS = 0;
let FAIL = 0;

function ok(name, detail) {
  PASS += 1;
  console.log('  \u2713 ' + name + (detail ? ' \u2014 ' + detail : ''));
}
function bad(name, error) {
  FAIL += 1;
  console.log('  \u2717 ' + name + ' \u2014 ' + (error && error.message ? error.message : String(error)));
}
function check(name, fn) {
  try {
    ok(name, fn());
  } catch (error) {
    bad(name, error);
  }
}

const DSH_SEARCH_ROOTS = [
  process.env.DSH_MAHJONG_DSH_ROOT,
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  path.join(HOME, '.npm-global/lib/node_modules/@deepseek-ai/dsh'),
].filter(Boolean);

/** Resolve a package from the installed DSH runtime (or the local plugin package). */
function requireRuntime(name) {
  const anchors = [
    path.join(PLUGIN_DIR, 'index.cjs'),
    ...DSH_SEARCH_ROOTS.map((root) => path.join(root, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(name);
    } catch (_) {}
  }
  return null;
}

function main() {
  console.log('============================================');
  console.log(' DSH 客户端卡片测试 — dsh-plugin/client.js');
  console.log(' 时间: ' + new Date().toISOString());
  console.log('============================================');
  console.log('');

  const React = requireRuntime('react');
  const ReactDOMServer = requireRuntime('react-dom/server');
  if (!React || !ReactDOMServer) {
    console.log('  \u25cb SKIP: 找不到 DSH 自带 react / react-dom（设置 DSH_MAHJONG_DSH_ROOT）');
    console.log('');
    console.log('结果: ' + PASS + ' 通过, ' + FAIL + ' 失败');
    return FAIL > 0 ? 1 : 0;
  }
  console.log('运行时: 真实 React ' + React.version + ' + react-dom/server');
  console.log('');

  const source = require('node:fs').readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8');
  const factory = new Function('console', source);

  // ---- harness -------------------------------------------------------
  const registrations = [];
  const injected = [];

  function mountCard(stateQueue) {
    const ControlledReact = Object.assign({}, React, {
      useState(initial) {
        if (stateQueue.length) {
          const next = stateQueue.shift();
          return [next === undefined ? initial : next, () => {}];
        }
        return [initial, () => {}];
      },
    });
    const ctx = {
      React: ControlledReact,
      slots: {
        inject(name, factoryFn) {
          injected.push(name);
          factoryFn();
          return () => {};
        },
        register(options, component) {
          registrations.push({ options, component });
          return () => {};
        },
      },
      timer: { interval: () => () => {} },
      host: { call: async () => ({}) },
      effect(fn) {
        const disposer = typeof fn === 'function' ? fn() : undefined;
        return () => {
          if (typeof disposer === 'function') disposer();
        };
      },
    };
    const plugin = factory(console);
    plugin.apply(ctx);
    return registrations[registrations.length - 1];
  }

  const noop = () => {};
  const STATUS = {
    sessionId: 'mj-call-1',
    status: 'ended',
    seed: 7,
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    scores: [32000, 28000, 21000, 19000],
    lastEvent: { type: 'hora', actor: 0, pai: '5m' },
    eventCount: 12,
    violations: 0,
    fallbacks: 0,
    llmCalls: 0,
    elapsedMs: 12345,
    viewerUrl: 'http://127.0.0.1:8765/view/mj-call-1',
    events: [
      {
        type: 'start_kyoku',
        bakaze: 'E',
        kyoku: 1,
        honba: 0,
        dora_marker: '1m',
        tehais: [['1m', '2m', '3m'], ['4m'], ['5m'], ['6m']],
        scores: [25000, 25000, 25000, 25000],
      },
      { type: 'dahai', actor: 0, pai: '1m' },
    ],
  };

  const OWNER_PROPS = {
    callId: 'call-1',
    toolName: 'mahjong_start',
    cwd: '/repo/mahjong-harness',
    openFile: noop,
    inspect: noop,
  };

  function renderCard(stateQueue, props) {
    const registration = mountCard(stateQueue);
    return {
      html: ReactDOMServer.renderToStaticMarkup(React.createElement(registration.component, props)),
      registration,
    };
  }

  // ---- 1. registration ------------------------------------------------
  console.log('[1] slot 注册');
  check('注册到 tool.call.toolview，key 为 mahjong_start', () => {
    const registration = mountCard([null, false, null]);
    assert.ok(registration, 'no registration');
    assert.strictEqual(registration.options.name, 'tool.call.toolview');
    assert.strictEqual(registration.options.key, 'mahjong_start', 'key must match the host tool name');
    assert.strictEqual(typeof registration.component, 'function');
    assert.strictEqual(injected.length, 1, 'exactly one slot injection');
    return 'name=' + registration.options.name + ' key=' + registration.options.key;
  });

  // ---- 2. collapsed ---------------------------------------------------
  console.log('');
  console.log('[2] 首屏 = 紧凑卡片（不抢占对话）');
  const collapsed = renderCard([STATUS, false, null], {
    ...OWNER_PROPS,
    block: { callId: 'call-1', name: 'mahjong_start', argsRaw: '{"seed":7,"mock":true}' },
  });

  check('渲染出紧凑卡片与状态徽标', () => {
    assert.ok(collapsed.html.indexOf('mj-card') >= 0, 'mj-card missing');
    assert.ok(collapsed.html.indexOf('日本麻将对局') >= 0, 'title missing');
    assert.ok(collapsed.html.indexOf('mj-state') >= 0 && collapsed.html.indexOf('ended') >= 0, 'status pill missing');
    return collapsed.html.length + ' bytes';
  });

  check('显示四家分数与最近动作', () => {
    for (const score of ['32,000', '28,000', '21,000', '19,000']) {
      assert.ok(collapsed.html.indexOf(score) >= 0, 'missing score ' + score);
    }
    assert.ok(collapsed.html.indexOf('和牌') >= 0, 'last event text missing');
    return '四家分数 + 最近动作已渲染';
  });

  check('首屏不含详情层与 iframe', () => {
    assert.ok(collapsed.html.indexOf('mj-detail') < 0, 'detail panel rendered on first paint');
    assert.ok(collapsed.html.indexOf('<iframe') < 0, 'iframe rendered on first paint');
    assert.ok(collapsed.html.indexOf('展开牌桌') >= 0, 'expand affordance missing');
    return '没有 mj-detail / iframe，仅「展开牌桌」入口';
  });

  // ---- 3. expanded ----------------------------------------------------
  console.log('');
  console.log('[3] 展开牌桌 = iframe 回放（用户主动）');
  const expanded = renderCard([STATUS, true, null], {
    ...OWNER_PROPS,
    block: { callId: 'call-1', name: 'mahjong_start', argsRaw: '{"seed":7,"mock":true}' },
  });

  check('展开后出现详情层、事件列表与统计', () => {
    assert.ok(expanded.html.indexOf('mj-detail') >= 0, 'detail panel missing');
    assert.ok(expanded.html.indexOf('mj-event-list') >= 0, 'event list missing');
    assert.ok(expanded.html.indexOf('收起牌桌') >= 0, 'collapse label missing');
    assert.ok(expanded.html.indexOf('违规 0') >= 0, 'stats missing');
    return 'mj-detail + mj-event-list + 统计';
  });

  check('iframe 指向 viewerUrl 且带 sandbox 限制', () => {
    assert.ok(expanded.html.indexOf('<iframe') >= 0, 'iframe missing');
    assert.ok(expanded.html.indexOf('http://127.0.0.1:8765/view/mj-call-1') >= 0, 'viewerUrl missing from src');
    assert.ok(expanded.html.indexOf('allow-scripts allow-same-origin') >= 0, 'iframe sandbox missing');
    return 'src=viewerUrl, sandbox=allow-scripts allow-same-origin';
  });

  // ---- 4. slot prop contract -----------------------------------------
  console.log('');
  console.log('[4] 真实 slot props 契约（argsRaw / 运行中 vs 已结束）');

  check('从 block.argsRaw 读取工具入参（SSR 首帧 data 来自 args）', () => {
    const result = renderCard([null, false, null], {
      ...OWNER_PROPS,
      block: { callId: 'call-9', name: 'mahjong_start', argsRaw: '{"seed":42,"mock":true}' },
    });
    assert.ok(result.html.indexOf('Seed 42') >= 0, 'seed from argsRaw not rendered');
    return 'Seed 42 来自 argsRaw';
  });

  check('已结束节点（kind=tool-result）同样能读到 call.argsRaw', () => {
    const result = renderCard([null, false, null], {
      ...OWNER_PROPS,
      block: { kind: 'tool-result', callId: 'call-9', call: { name: 'mahjong_start', argsRaw: '{"seed":5}' }, isError: false },
    });
    assert.ok(result.html.indexOf('Seed 5') >= 0, 'settled-call args not rendered');
    return 'Seed 5 来自 block.call.argsRaw';
  });

  check('运行中的调用显示 running，不显示假状态', () => {
    const result = renderCard([null, false, null], {
      ...OWNER_PROPS,
      block: { callId: 'call-3', name: 'mahjong_start', argsRaw: '{}' },
    });
    assert.ok(result.html.indexOf('>running<') >= 0, 'running status pill missing');
    return '状态徽标 = running';
  });

  check('失败的调用显示 error', () => {
    const result = renderCard([null, false, null], {
      ...OWNER_PROPS,
      block: { kind: 'tool-result', callId: 'call-4', call: { argsRaw: '{}' }, isError: true },
    });
    assert.ok(result.html.indexOf('>error<') >= 0, 'error status pill missing');
    return '状态徽标 = error';
  });

  check('会话 id 由 tool-call id 推导（与 host 端 mj-<callId> 一致）', () => {
    assert.ok(/mj-' \+ String\(callId\)/.test(source), 'derivedSessionId must prefix mj- with the callId');
    return "client 与 host 均使用 'mj-' + callId";
  });

  console.log('');
  console.log('============================================');
  console.log(' 结果: ' + PASS + ' 通过, ' + FAIL + ' 失败');
  console.log('============================================');
  return FAIL > 0 ? 1 : 0;
}

process.exit(main());
