#!/usr/bin/env node
/**
 * Emit the exact `cordis_define` payload for the mahjong card.
 *
 * The host half is a ~16 KB file and the client half ~15 KB, so hand-copying
 * them into a tool call drifts. This prints the whole argument as one JSON
 * document that can be pasted (or piped) into `cordis_define`:
 *
 *   node dsh-plugin/print-register.mjs                 # JSON to stdout
 *   node dsh-plugin/print-register.mjs --out /tmp/mj.json
 *   node dsh-plugin/print-register.mjs --summary       # sizes + sanity checks only
 *
 * Both halves are validated for the sandbox contract before being emitted:
 * the host half must compile as an async function body that returns a cordis
 * plugin, and it must not reference the globals the sandbox traps.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : '';

function fail(message) {
  console.error('print-register: ' + message);
  process.exit(1);
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const hostSource = fs.readFileSync(path.join(here, 'host.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(here, 'client.js'), 'utf8');

// ---- host half: sandbox contract -------------------------------------
const trapped = {
  require: /\brequire\s*\(/,
  'process.': /\bprocess\./,
  'setTimeout(': /(?<!ctx\.)\bsetTimeout\s*\(/,
  'setInterval(': /(?<!ctx\.)\bsetInterval\s*\(/,
  'fetch(': /(?<!ctx\.)\bfetch\s*\(/,
};
const hostCode = stripComments(hostSource);
for (const [name, pattern] of Object.entries(trapped)) {
  if (pattern.test(hostCode)) fail('host.js references ' + name + ', which the dynamic-package sandbox traps');
}

const sandboxHarness = {
  defineTool: (options) => options,
  registerTool: () => () => {},
  handle: () => {},
};
const sandbox = { harness: sandboxHarness, console, TextEncoder, TextDecoder };
vm.createContext(sandbox);
let hostPlugin;
try {
  hostPlugin = await vm.runInContext('(async () => {\n' + hostSource + '\n})()', sandbox, { filename: 'cordis-dyn-host.js' });
} catch (error) {
  fail('host.js is not a valid async function body: ' + error.message);
}
if (!hostPlugin || typeof hostPlugin.apply !== 'function') fail('host.js did not return a cordis plugin with apply()');
if (!Array.isArray(hostPlugin.inject) || !hostPlugin.inject.includes('tools')) {
  fail('host.js must declare tools in inject (cordis refuses ctx.tools otherwise)');
}

// ---- client half: async function body ---------------------------------
let clientPlugin;
try {
  clientPlugin = new Function('console', clientSource)(console);
} catch (error) {
  fail('client.js is not a valid function body: ' + error.message);
}
if (!clientPlugin || typeof clientPlugin.apply !== 'function') fail('client.js did not return a cordis plugin with apply()');

const payload = {
  kind: 'new',
  idPrefix: 'mjai',
  name: 'dsh-mahjong-runtime-live-card',
  code: { host: hostSource, client: clientSource },
};

const bytes = (value) => String(Buffer.byteLength(value, 'utf8'));
if (summaryOnly) {
  console.log('host.js   : ' + bytes(hostSource) + ' bytes, inject=' + JSON.stringify(hostPlugin.inject));
  console.log('client.js : ' + bytes(clientSource) + ' bytes, inject=' + JSON.stringify(clientPlugin.inject));
  console.log('payload   : ' + bytes(JSON.stringify(payload)) + ' bytes');
  console.log('');
  console.log('下一步: cordis_define(kind="new", idPrefix="mjai", name=…, code.host=host.js, code.client=client.js)');
  console.log('然后:   cordis_run pluginId=<返回的 pluginId> config={"workspace":"' + path.resolve(here, '..') + '"}');
  process.exit(0);
}

const json = JSON.stringify(payload, null, 2);
if (outPath) {
  fs.writeFileSync(outPath, json, 'utf8');
  console.log('wrote ' + outPath + ' (' + bytes(json) + ' bytes)');
} else {
  process.stdout.write(json + '\n');
}
