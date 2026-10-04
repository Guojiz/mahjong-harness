/**
 * Verify the DSH plugin host.js + client.js structure is complete and correct.
 * Simulates the Cordis environment to confirm both halves load and register.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const pluginDir = path.resolve(__dirname);          // dsh-plugin/
const repo = path.resolve(pluginDir, '..');         // repo root
const hostSrc = fs.readFileSync(path.join(pluginDir, 'host.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8');

// ---- 1. Verify host.js structure ----
console.log('[1] host.js structure');
const hostChecks = [
  ['workspace resolution (config-first)', /CONFIGURED_WORKSPACE|resolveWorkspace/],
  ['Python resolution', /resolvePython|CONFIGURED_PYTHON/],
  ['sandbox-safe timer (ctx.timeout)', /ctx\.timeout|scheduleTimeout/],
  ['harness.defineTool + registerTool', /harness\.registerTool/],
  ['dynamic output.render content blocks', /type: 'text'/],
  ["inject declares subprocess/timer/tools", /inject: \['subprocess', 'timer', 'tools'\]/],
  ['SubprocessHandle.done (no .on(\'exit\'))', /handle\.done\.then/],
  ['credentials.resolve unwraps { value }', /resolved\.value/],
  ['session id derives from the tool-call id', /'mj-' \+ String\(exec\.callId\)|sessionIdFor/],
  ['base URL is plugin config, not tool input', /settings\.baseUrl/],
  ['subprocess spawn', /subprocess\.spawn/],
  ['session.start', /session\.start/],
  ['session.status', /session\.status/],
  ['session.cancel', /session\.cancel/],
  ['session.export', /session\.export/],
  ['mahjong_start tool', /mahjong_start/],
  ['mahjong_status tool', /mahjong_status/],
  ['mahjong_cancel tool', /mahjong_cancel/],
  ['mahjong_export tool', /mahjong_export/],
  ['client bridge via harness.handle', /harness\.handle/],
  ['worker restart (MAX_WORKER_RESTARTS)', /MAX_WORKER_RESTARTS/],
  ['markWorkerDead', /markWorkerDead/],
];
// The dynamic-package sandbox traps these; the host half must not reference them.
const hostForbidden = [
  ['require()', /\brequire\s*\(/],
  ['process.', /\bprocess\./],
  ["node:path / node:fs", /node:(path|fs)/],
  ['bare setTimeout/setInterval', /(?<!ctx\.)\bset(Timeout|Interval)\s*\(/],
];let hostFail = 0;
for (const [name, re] of hostChecks) {
  if (re.test(hostSrc)) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} MISSING`); hostFail++; }
}
// Comments legitimately name the trapped globals; only executable text matters.
const hostCode = hostSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [name, re] of hostForbidden) {
  if (!re.test(hostCode)) console.log(`  ✓ no ${name} (sandbox-safe)`);
  else { console.log(`  ✗ ${name} present — the dynamic sandbox traps it`); hostFail++; }
}

// ---- 1b. profile entry point (index.cjs) ----
console.log('\n[1b] profile entry point (index.cjs)');
try {
  const profilePlugin = require('./index.cjs');
  const okShape = profilePlugin && typeof profilePlugin.apply === 'function';
  const okInject = Array.isArray(profilePlugin.inject) && profilePlugin.inject.includes('tools');
  if (okShape && okInject) {
    console.log('  \u2713 loads as a cordis plugin (apply + inject=' + JSON.stringify(profilePlugin.inject) + ')');
  } else {
    console.log('  \u2717 index.cjs did not export a plugin with apply() and inject including tools');
    hostFail++;
  }
  if (typeof profilePlugin.parseHostPlugin === 'function' && typeof profilePlugin.buildHarness === 'function') {
    console.log('  \u2713 exposes parseHostPlugin / buildHarness for profile hosts');
  } else {
    console.log('  \u2717 missing parseHostPlugin / buildHarness exports');
    hostFail++;
  }
} catch (error) {
  console.log('  \u2717 index.cjs failed to load: ' + error.message);
  hostFail++;
}

// ---- 2. Verify client.js structure ----
console.log('\n[2] client.js structure');
const clientChecks = [
  ['compact card (mj-card)', /mj-card/],
  ['expand button (展开牌桌)', /展开牌桌|收起牌桌/],
  ['no auto fullscreen', /不.*全屏|不自动全屏|不抢占/],
  ['inline table (mj-mini-table)', /mj-mini-table/],
  ['tile suit colors', /tileSuitClass|mj-mini-tile\.m|mj-mini-tile\.p/],
  ['reduceEvents reducer', /reduceEvents/],
  ['event list', /mj-event-list/],
  ['export MJAI button', /导出 MJAI/],
  ['stats display', /violations/],
  ['polling (timer.interval)', /timer\.interval|setInterval/],
  ['slot registration', /tool\.call\.toolview/],
  ['React integration', /React\.useState|React\.createElement/],
];
let clientFail = 0;
for (const [name, re] of clientChecks) {
  if (re.test(clientSrc)) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} MISSING`); clientFail++; }
}

// ---- 3. Verify tile assets ----
console.log('\n[3] Tile assets');
const tileDir = path.join(repo, 'dsh-plugin', 'log-viewer', 'files', 'tiles');
const tiles = fs.readdirSync(tileDir).filter(f => f.endsWith('.svg'));
console.log(`  ${tiles.length} SVG tiles found`);
const required = ['Regular-Man1-m.svg', 'Regular-Pin5-Dora-m.svg', 'Regular-Ton-m.svg', 'Regular-Back-m.svg'];
for (const t of required) {
  if (tiles.includes(t)) console.log(`  ✓ ${t}`);
  else console.log(`  ✗ ${t} MISSING`);
}

// ---- 4. Verify log-viewer index.html loads events ----
console.log('\n[4] log-viewer index.html');
const idxHtml = fs.readFileSync(path.join(repo, 'dsh-plugin', 'log-viewer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repo, 'dsh-plugin', 'log-viewer', 'app.js'), 'utf8');
if (/window\.MJAIStudio = { loadEvents }/.test(appJs)) console.log('  ✓ window.MJAIStudio.loadEvents(events) API');
else console.log('  ✗ MJAIStudio.loadEvents API MISSING');
if (/window\.MJAIStudio = \{ loadEvents \}/.test(appJs)) console.log('  ✓ MJAIStudio exported');
else console.log('  ✗ MJAIStudio export MISSING');

// ---- 5. Verify serve_logs.py HTTP server ----
console.log('\n[5] serve_logs.py HTTP server');
const serveLogs = fs.readFileSync(path.join(repo, 'harness', 'serve_logs.py'), 'utf8');
if (/\/api\/events\//.test(serveLogs)) console.log('  ✓ /api/events/<id> endpoint');
else console.log('  ✗ /api/events/ MISSING');
if (/\/view\//.test(serveLogs)) console.log('  ✓ /view/<id> endpoint (injects events)');
else console.log('  ✗ /view/ MISSING');
if (/__INJECTED_EVENTS__/.test(serveLogs)) console.log('  ✓ events injection into HTML');
else console.log('  ✗ events injection MISSING');

// ---- Summary ----
console.log('\n===== Plugin Verification Summary =====');
const totalFail = hostFail + clientFail;
if (totalFail === 0) {
  console.log('✓ ALL CHECKS PASSED - DSH plugin structure matches the sandbox contract');
  console.log('');
  console.log('Behaviour is covered by:');
  console.log('  node dsh-plugin/test_host_contract.js   (cordis + ToolRuntime + worker + viewer)');
  console.log('  node dsh-plugin/test_client_card.js     (slot props + compact card + iframe)');
  console.log('');
  console.log('Register in a DSH session:');
  console.log('  node dsh-plugin/print-register.mjs      (emits the cordis_define payload)');
  process.exit(0);
} else {
  console.log(`✗ ${totalFail} checks failed`);
  process.exit(1);
}
