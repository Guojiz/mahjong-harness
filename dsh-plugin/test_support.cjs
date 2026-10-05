'use strict';

/**
 * Shared helpers for the DSH plugin tests.
 *
 * Everything here is either (a) package resolution against the locally installed
 * DSH runtime, or (b) a service double that implements a *published* DSH
 * contract. The doubles exist because the real cordis context under test must be
 * given a subprocess service and a credential service, and because a test needs
 * to observe the exact child pids it later proves dead.
 *
 * `assertSubprocessContractParity()` in test_host_contract.js cross-checks the
 * subprocess double against the real `@deepseek-ai/dsh-subprocess-local` runtime
 * so the double cannot silently drift from the published `SubprocessHandle`.
 */

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const PLUGIN_DIR = __dirname;
const REPO = path.resolve(PLUGIN_DIR, '..');
const HOME = os.homedir();

/** Where a machine may keep the DSH runtime; override with DSH_MAHJONG_DSH_ROOT. */
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

/** Import an ESM package from the plugin dir or the installed DSH runtime. */
async function loadEsm(spec, fromFile) {
  const requireFrom = createRequire(fromFile || path.join(PLUGIN_DIR, 'index.cjs'));
  let resolved = '';
  try {
    resolved = requireFrom.resolve(spec);
  } catch (_) {
    resolved = resolveFromDshInstall(spec);
  }
  if (!resolved) return null;
  return import(pathToFileURL(resolved).href);
}

/**
 * `SubprocessHandle` per the published service contract, backed by node:child_process.
 * Collect-mode `stderr` is intentionally `undefined` and there is intentionally no
 * `.on()`; both match `@deepseek-ai/dsh-subprocess-local`.
 */
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

/** Minimal provider for the one service `ToolRuntime` injects. */
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

/** A port nothing is listening on, so the viewer can bind it. */
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
    const request = http.get(url, { timeout: 5000 }, (response) => {
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

/** Shared +/− reporter so every test file prints the same shape. */
function createReporter(label) {
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const api = {
    get pass() {
      return pass;
    },
    get fail() {
      return fail;
    },
    get skip() {
      return skipped;
    },
    header(lines) {
      console.log('============================================');
      console.log(' ' + label);
      console.log(' 时间: ' + new Date().toISOString());
      for (const line of lines || []) console.log(' ' + line);
      console.log('============================================');
      console.log('');
    },
    ok(name, detail) {
      pass += 1;
      console.log('  \u2713 ' + name + (detail ? ' \u2014 ' + detail : ''));
    },
    bad(name, error) {
      fail += 1;
      console.log('  \u2717 ' + name + ' \u2014 ' + (error && error.message ? error.message : String(error)));
    },
    skip(name, why) {
      skipped += 1;
      console.log('  \u25cb ' + name + (why ? ' \u2014 ' + why : ''));
    },
    async check(name, fn) {
      try {
        api.ok(name, await fn());
      } catch (error) {
        api.bad(name, error);
      }
    },
    summary() {
      console.log('');
      console.log('============================================');
      console.log(' 结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skipped + ' 跳过');
      console.log('============================================');
    },
  };
  return api;
}

module.exports = {
  PLUGIN_DIR,
  REPO,
  HOME,
  DSH_SEARCH_ROOTS,
  resolveFromDshInstall,
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
};
