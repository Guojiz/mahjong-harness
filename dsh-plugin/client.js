/**
 * DSH Cordis Client half — compact dialogue card + expand detail.
 * First paint stays in-chat (360–520px). Full table only after explicit "展开牌桌".
 */
return {
  inject: ['slots', 'timer', 'host'],
  apply(ctx) {
    const React = ctx.React || (typeof window !== 'undefined' && window.React);
    const h = React.createElement;
    const slots = ctx.slots;
    const timer = ctx.timer;
    const host = ctx.host;

    const CSS = `
.mj-card{max-width:520px;margin:8px 0;padding:12px 14px;border:1px solid rgba(114,224,192,.25);border-radius:12px;background:linear-gradient(160deg,#0f1a24,#132230);color:#edf4f8;font:13px/1.45 system-ui,"Microsoft YaHei",sans-serif}
.mj-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.mj-card-head strong{font-size:14px;letter-spacing:.04em}
.mj-state{padding:2px 8px;border-radius:999px;background:rgba(114,224,192,.12);color:#72e0c0;font-size:11px}
.mj-board{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;min-height:120px;padding:10px;border-radius:10px;background:#174c4b;border:1px solid rgba(255,255,255,.08)}
.mj-seats{display:grid;gap:6px}
.mj-seat{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#c7dbe6}
.mj-seat b{color:#e9bd76;font-variant-numeric:tabular-nums}
.mj-center{text-align:center;color:#9bbcb5;font-size:12px}
.mj-center strong{display:block;color:#edf4f8;margin-bottom:4px}
.mj-score{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:11px;color:#8fa4b5}
.mj-event{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
.mj-card-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}
.mj-actions{display:flex;gap:8px;flex-shrink:0}
.mj-button{padding:6px 12px;border-radius:8px;border:1px solid rgba(179,205,224,.25);background:transparent;color:#edf4f8;font-size:12px;cursor:pointer}
.mj-button.primary{background:#72e0c0;color:#0c1c22;border-color:transparent;font-weight:700}
.mj-button:hover{border-color:#72e0c0}
.mj-detail{margin-top:12px;padding:10px;border-radius:10px;background:#0a111a;border:1px solid rgba(179,205,224,.14);max-height:360px;overflow:auto}
.mj-detail-note{font-size:11px;color:#8fa4b5;margin-bottom:8px}
.mj-event-list{margin:0;padding:0;list-style:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.mj-event-list li{padding:4px 0;border-bottom:1px solid rgba(179,205,224,.08);color:#a4bdc5}
.mj-event-list li span{color:#72e0c0;margin-right:6px}
.mj-scroll-hint{margin-top:8px;font-size:11px;color:#8fa4b5}
.mj-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;border-radius:8px;border:1px solid rgba(179,205,224,.12);background:#0e3438}
.mj-table-placeholder{min-width:660px;min-height:200px;display:grid;place-items:center;color:#9bbcb5;font-size:12px;padding:16px}
@media (max-width:480px){.mj-card{max-width:100%}.mj-card-foot{flex-direction:column;align-items:stretch}.mj-actions{justify-content:flex-end}}
`;

    let disposeStyles;
    if (typeof document !== 'undefined') {
      const style = document.createElement('style');
      style.setAttribute('data-mj-card', '1');
      style.textContent = CSS;
      document.head.appendChild(style);
      disposeStyles = () => { try { style.remove(); } catch (_) {} };
    }

    function parseBlock(block) {
      if (!block) return {};
      if (typeof block === 'object') return block;
      try { return JSON.parse(block); } catch (_) { return {}; }
    }

    function derivedSessionId(callId) {
      return callId ? 'mj-' + String(callId) : '';
    }

    function eventText(ev) {
      if (!ev || typeof ev !== 'object') return '—';
      const t = ev.type || 'event';
      if (ev.pai) return t + ' ' + ev.pai + (Number.isInteger(ev.actor) ? ' @' + ev.actor : '');
      if (Number.isInteger(ev.actor)) return t + ' @' + ev.actor;
      return t;
    }

    function View(props) {
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [exported, setExported] = React.useState(null);
      const input = parseBlock(props.block);
      const sessionId = input.sessionId || derivedSessionId(props.callId);

      React.useEffect(() => {
        let alive = true;
        async function refresh() {
          try {
            const next = await host.call('mahjong.status', { sessionId: sessionId });
            if (alive) setState(next);
          } catch (_) {}
        }
        refresh();
        if (timer && timer.interval) return timer.interval(refresh, 1200);
        const id = setInterval(refresh, 1200);
        return () => { alive = false; clearInterval(id); };
      }, [sessionId]);

      const data = state || input || {};
      const scores = Array.isArray(data.scores) ? data.scores : [25000, 25000, 25000, 25000];
      const events = Array.isArray(data.events) ? data.events : [];
      const recent = events.slice(-40);

      async function exportLog() {
        try {
          setExported(await host.call('mahjong.export', { sessionId: sessionId }));
          setOpen(true);
        } catch (error) {
          setExported({ error: String(error) });
          setOpen(true);
        }
      }

      return h('div', { className: 'mj-card' },
        h('div', { className: 'mj-card-head' },
          h('strong', null, '日本麻将对局'),
          h('span', { className: 'mj-state' }, data.status || 'starting')
        ),
        h('div', { className: 'mj-board' },
          h('div', { className: 'mj-seats' },
            scores.map(function (score, i) {
              return h('div', { className: 'mj-seat', key: i },
                h('span', null, ['东家', '南家', '西家', '北家'][i]),
                h('b', null, Number(score).toLocaleString())
              );
            })
          ),
          h('div', { className: 'mj-center' },
            h('strong', null, data.seed ? 'Seed ' + data.seed : '等待'),
            h('div', null, '紧凑牌桌预览')
          ),
          h('div', null)
        ),
        h('div', { className: 'mj-score' },
          h('span', { className: 'mj-event' }, '最近动作：' + eventText(data.lastEvent)),
          h('span', null, '事件 ' + Number(data.eventCount || events.length || 0))
        ),
        h('div', { className: 'mj-card-foot' },
          h('span', { className: 'mj-event' },
            data.error || (data.status === 'ended'
              ? '对局完成，可查看完整牌谱'
              : data.status === 'failed'
                ? 'worker 异常，可重试开局'
                : '规则引擎与模型决策进行中')
          ),
          h('div', { className: 'mj-actions' },
            h('button', {
              className: 'mj-button primary',
              type: 'button',
              onClick: function () { setOpen(!open); },
            }, open ? '收起牌桌' : '展开牌桌'),
            (data.status === 'ended' || data.status === 'failed')
              ? h('button', { className: 'mj-button', type: 'button', onClick: exportLog }, '导出 MJAI')
              : null
          )
        ),
        open
          ? h('div', { className: 'mj-detail' },
              h('div', { className: 'mj-detail-note' },
                '详情层 · 完整 660px 牌桌请在本机打开 Mortal/log-viewer（支持横向滚动）。此处展示最近事件，不抢占对话历史。'
              ),
              h('div', { className: 'mj-table-scroll' },
                h('div', { className: 'mj-table-placeholder' },
                  '牌桌 660px 固定宽度 · 移动端请横滑 · 牌面 30×40 CC0 SVG'
                )
              ),
              h('p', { className: 'mj-scroll-hint' },
                '违规 ' + Number(data.violations || 0) +
                ' · 兜底 ' + Number(data.fallbacks || 0) +
                ' · LLM ' + Number(data.llmCalls || 0) +
                (data.model ? ' · ' + data.model : '')
              ),
              h('ul', { className: 'mj-event-list' },
                recent.length
                  ? recent.map(function (ev, i) {
                      return h('li', { key: i },
                        h('span', null, ev && ev.type ? ev.type : 'event'),
                        eventText(ev)
                      );
                    })
                  : h('li', null, '暂无事件')
              ),
              exported
                ? h('pre', { style: { fontSize: 10, whiteSpace: 'pre-wrap' } },
                    JSON.stringify({
                      sessionId: exported.sessionId || sessionId,
                      status: exported.status,
                      scores: exported.scores,
                      eventCount: exported.eventCount,
                      violations: exported.violations,
                      fallbacks: exported.fallbacks,
                    }, null, 2)
                  )
                : null
            )
          : null
      );
    }

    const inject = slots.inject('tool.call.toolview', function () {
      return slots.register(
        { name: 'tool.call.toolview', key: 'mahjong_start' },
        function (props) { return h(View, props); }
      );
    });

    ctx.effect(function () {
      return function () {
        if (disposeStyles) disposeStyles();
        if (inject) inject();
      };
    }, 'mahjong-card');
  },
};
