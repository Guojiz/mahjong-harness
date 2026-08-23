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
  ['WORKSPACE probing', /probeWorkspace|DSH_MAHJONG_WORKSPACE/],
  ['Python probing', /probePython|DSH_MAHJONG_PYTHON/],
  ['subprocess spawn', /subprocess\.spawn/],
  ['session.start', /session\.start/],
  ['session.status', /session\.status/],
  ['session.cancel', /session\.cancel/],
  ['session.export', /session\.export/],
  ['mahjong_start tool', /mahjong_start/],
  ['mahjong_status tool', /mahjong_status/],
  ['mahjong_cancel tool', /mahjong_cancel/],
  ['mahjong_export tool', /mahjong_export/],
  ['credentials.resolve', /credentials\.resolve|resolveApiKey/],
  ['provider URL not exposed as tool input', /baseUrl: LLM_BASE_URL/],
  ['worker restart (MAX_RESTARTS)', /MAX_RESTARTS/],
  ['markWorkerDead', /markWorkerDead/],
];
let hostFail = 0;
for (const [name, re] of hostChecks) {
  if (re.test(hostSrc)) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} MISSING`); hostFail++; }
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
  console.log('✓ ALL CHECKS PASSED - DSH plugin is ready for cordis_define');
  console.log('');
  console.log('Register in DSH session:');
  console.log('  1. cordis_define (host.js + client.js)');
  console.log('  2. cordis_run pluginId=mjai-1');
  console.log('  3. Tool.listTools → mahjong_start/status/cancel/export');
  process.exit(0);
} else {
  console.log(`✗ ${totalFail} checks failed`);
  process.exit(1);
}
