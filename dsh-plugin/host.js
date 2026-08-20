const WORKSPACE = 'C:/Users/Administrator/WorkBuddy/2026-08-18-15-00-32/mahjong-harness';
const PYTHON = WORKSPACE + '/Mortal/.venv/Scripts/python.exe';
return {
  inject: ['subprocess'],
  apply(ctx) {
    const sessions = new Map();
    const credentials = ctx.get('credentials');
    const subprocess = ctx.subprocess;
    let buffer = '';
    let worker;
    function safeState(state) {
      if (!state || typeof state !== 'object') return { status: 'unknown' };
      return { sessionId: typeof state.sessionId === 'string' ? state.sessionId : '', status: typeof state.status === 'string' ? state.status : 'unknown', seed: Number(state.seed || 0), model: typeof state.model === 'string' ? state.model : '', scores: Array.isArray(state.scores) ? state.scores.slice(0, 4).map(Number) : [25000, 25000, 25000, 25000], lastEvent: state.lastEvent && typeof state.lastEvent === 'object' ? state.lastEvent : null, eventCount: Number(state.eventCount || 0), violations: Number(state.violations || 0), fallbacks: Number(state.fallbacks || 0), llmCalls: Number(state.llmCalls || 0), elapsedMs: Number(state.elapsedMs || 0), error: typeof state.error === 'string' ? state.error : null, events: Array.isArray(state.events) ? state.events.slice(-200) : undefined };
    }
    function onFrame(frame) {
      if (!frame || typeof frame !== 'object' || typeof frame.sessionId !== 'string') return;
      const session = sessions.get(frame.sessionId);
      if (!session) return;
      if (frame.event === 'session') session.state = safeState(frame.data);
      if (frame.event === 'mjai') { const data = frame.data && typeof frame.data === 'object' ? frame.data : {}; session.events.push(data); session.state = Object.assign({}, session.state, { lastEvent: data, eventCount: session.events.length }); }
      if (frame.event === 'decision') session.state = Object.assign({}, session.state, { lastDecision: frame.data });
    }
    function ensureWorker() {
      if (worker) return worker;
      worker = subprocess.spawn({ argv: [PYTHON, '-m', 'harness.worker'], cwd: WORKSPACE, graceMs: 1500, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4000 } } });
      worker.stdout.on('data', (chunk) => { buffer += String(chunk); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) { if (!line.trim()) continue; try { const frame = JSON.parse(line); if (frame.id) { const pending = sessions.get('request:' + frame.id); if (pending) { pending.resolve(frame.result || { status: 'failed', error: frame.error && frame.error.message }); sessions.delete('request:' + frame.id); } } else onFrame(frame); } catch (error) { console.error('mahjong worker frame rejected', error); } } });
      worker.done.then((outcome) => { for (const session of sessions.values()) if (session && session.state && !['ended', 'failed', 'cancelled'].includes(session.state.status)) session.state = Object.assign({}, session.state, { status: 'failed', error: '麻将 worker 已退出' }); worker = undefined; console.error('mahjong worker exited', outcome.exitCode, outcome.signal); }).catch((error) => console.error('mahjong worker failed', error));
      return worker;
    }
    function send(method, params) { const child = ensureWorker(); const id = 'req-' + Date.now() + '-' + Math.floor(Math.random() * 100000); return new Promise((resolve, reject) => { sessions.set('request:' + id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }); }
    async function apiKey() { if (!credentials) return ''; try { const resolved = await credentials.resolve({ namespace: 'mahjong', name: 'LLM_API_KEY' }); return resolved && typeof resolved.value === 'string' ? resolved.value : ''; } catch (_) { return ''; } }
    async function start(args, exec) { const sessionId = 'mj-' + String(exec.callId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-'); const key = await apiKey(); const session = { state: { sessionId, status: 'starting', seed: Number(args.seed || 7), scores: [25000, 25000, 25000, 25000], eventCount: 0 }, events: [] }; sessions.set(sessionId, session); const result = await send('session.start', { sessionId, seed: Number(args.seed || 7), model: typeof args.model === 'string' && args.model ? args.model : 'deepseek-ai/DeepSeek-V4-Flash', baseUrl: typeof args.baseUrl === 'string' && args.baseUrl ? args.baseUrl : 'https://api.siliconflow.cn/v1', budget: args.budget == null ? null : Number(args.budget), mock: Boolean(args.mock) || !key, apiKey: key, logDir: WORKSPACE + '/logs/dsh' }); session.state = safeState(result); if (exec.signal && exec.signal.addEventListener) exec.signal.addEventListener('abort', () => { send('session.cancel', { sessionId }).catch(() => {}); }, { once: true }); return safeState(session.state); }
    async function status(args) { const session = sessions.get(args.sessionId); if (session) return safeState(Object.assign({}, session.state, { events: session.events.slice(-200) })); return safeState(await send('session.status', { sessionId: args.sessionId })); }
    async function exportSession(args) { const session = sessions.get(args.sessionId); if (session) return safeState(Object.assign({}, session.state, { events: session.events.slice(-5000) })); return safeState(await send('session.export', { sessionId: args.sessionId })); }
    function tool(name, description, parameters, execute) { return harness.defineTool({ name, description, parameters, output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; }, presentationMeta(_args, value) { return value; } }, execute }); }
    harness.registerTool(ctx, tool('mahjong_start', '开始一局固定 seed 的日本麻将并返回对话卡片状态。', { type: 'object', properties: { seed: { type: 'integer', description: '确定性牌局 seed，默认 7' }, model: { type: 'string', description: '模型名，默认 DeepSeek-V4-Flash' }, baseUrl: { type: 'string', description: 'OpenAI-compatible API base URL' }, budget: { type: 'integer', description: '真实模型调用预算，默认不限制' }, mock: { type: 'boolean', description: '使用确定性 mock，不调用远程 API' } }, required: [] }, start));
    harness.registerTool(ctx, tool('mahjong_status', '查询一局日本麻将的当前状态和最近事件。', { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }, status));
    harness.registerTool(ctx, tool('mahjong_cancel', '取消一局仍在运行的日本麻将。', { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }, async (args) => safeState(await send('session.cancel', { sessionId: args.sessionId }))));
    harness.registerTool(ctx, tool('mahjong_export', '导出一局的 MJAI 事件和统计，不包含 prompt 或密钥。', { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }, exportSession));
    ctx.effect(() => () => { if (worker) worker.terminate(); worker = undefined; sessions.clear(); }, 'mahjong-worker');
    harness.handle('mahjong.status', async (args) => status(args));
    harness.handle('mahjong.export', async (args) => exportSession(args));
  }
};