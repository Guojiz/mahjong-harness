'use strict';

/**
 * Profile-installable wrapper for the mahjong-harness DSH plugin.
 *
 * `host.js` is authored as the BODY of an async function because that is what
 * `cordis_define` → `code.host` evaluates inside the dynamic-package sandbox.
 * Keying the code off that one form keeps a single source of truth, so this
 * wrapper compiles the same file for a cordis Loader row:
 *
 *   node_modules/mahjong-harness-dsh-plugin/  ← this package
 *   profile cordis.patch.yml                  ← - insert: [{ id, name }]
 *
 * Install:
 *   dsh plugin --profile <name> add <path-to-dsh-plugin>
 *
 * Unlike the dynamic sandbox, a profile plugin runs with the full Node API and
 * has no Client RPC bridge, so `harness.handle` registrations are recorded and
 * exposed on `plugin.handlers` for hosts that want to call them directly.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * The real tool DSL. `host.js` declares parameters in the DSL form and relies on
 * `defineTool` to project them into JSON Schema, so a pass-through would register
 * a malformed tool; a missing dependency is therefore a load error, not a silent
 * degradation.
 */
function resolveDefineTool() {
  try {
    const tools = require('@deepseek-ai/dsh-tools');
    if (tools && typeof tools.defineTool === 'function') return tools.defineTool;
  } catch (_) {}
  return null;
}

function buildHarness(handlers) {
  const defineTool = resolveDefineTool();
  return {
    defineTool(options) {
      if (!defineTool) {
        throw new Error(
          'mahjong-harness: @deepseek-ai/dsh-tools is required to install this plugin as a profile package ' +
            '(the dynamic cordis_define path gets the DSL from the sandbox harness instead)'
        );
      }
      return defineTool(options);
    },
    registerTool(ctx, tool) {
      if (ctx && ctx.tools && typeof ctx.tools.register === 'function') return ctx.tools.register(tool);
      if (typeof ctx.registerTool === 'function') return ctx.registerTool(tool);
      throw new Error('mahjong-harness: this cordis context exposes no tool registry (ctx.tools.register)');
    },
    handle(method, fn) {
      handlers.set(method, fn);
    },
  };
}

/** Compile `host.js` — a function body returning a cordis Plugin. */
function parseHostPlugin(source, harness) {
  const factory = new Function('harness', 'console', source + '\n//# sourceURL=mahjong-harness/host.js');
  const plugin = factory(harness, console);
  if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
    throw new Error('mahjong-harness: host.js did not return a cordis plugin object with apply()');
  }
  return plugin;
}

const sourcePath = path.join(__dirname, 'host.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const handlers = new Map();

const plugin = parseHostPlugin(source, buildHarness(handlers));

module.exports = plugin;
module.exports.default = plugin;
module.exports.plugin = plugin;
module.exports.handlers = handlers;
module.exports.sourcePath = sourcePath;
module.exports.parseHostPlugin = parseHostPlugin;
module.exports.buildHarness = buildHarness;
