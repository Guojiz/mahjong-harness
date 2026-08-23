/**
 * DSH Cordis Client half — compact dialogue card + expand detail with inline log-viewer.
 * First paint stays in-chat (360–520px). Full table only after explicit "展开牌桌".
 * Inline tile rendering uses simplified div tiles with proper suit colors;
 * standalone full log-viewer available at dsh-plugin/log-viewer/index.html.
 */
return {
  inject: ['slots', 'timer', 'host'],
  apply(ctx) {
    const React = ctx.React || (typeof window !== 'undefined' && window.React);
    const h = React.createElement;
    const slots = ctx.slots;
    const timer = ctx.timer;
    const host = ctx.host;

    // ---- CSS ----
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
.mj-detail{margin-top:12px;padding:10px;border-radius:10px;background:#0a111a;border:1px solid rgba(179,205,224,.14);max-height:420px;overflow:auto}
.mj-detail-note{font-size:11px;color:#8fa4b5;margin-bottom:8px}
.mj-event-list{margin:0;padding:0;list-style:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.mj-event-list li{padding:4px 0;border-bottom:1px solid rgba(179,205,224,.08);color:#a4bdc5}
.mj-event-list li span{color:#72e0c0;margin-right:6px}
.mj-scroll-hint{margin-top:8px;font-size:11px;color:#8fa4b5}
.mj-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;border-radius:8px;border:1px solid rgba(179,205,224,.12);background:#0e3438}
.mj-mini-table{min-width:460px;padding:8px;display:grid;grid-template-rows:auto auto auto auto auto;gap:4px;font-size:11px}
.mj-player-row{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;background:rgba(17,26,39,.6)}
.mj-player-row.active{background:rgba(114,224,192,.08);border-left:2px solid #72e0c0}
.mj-player-name{width:48px;flex-shrink:0;text-align:right;color:#c7dbe6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mj-player-score{width:56px;flex-shrink:0;text-align:right;color:#e9bd76;font-weight:700;font-variant-numeric:tabular-nums}
.mj-player-hand{flex:1;display:flex;gap:2px;flex-wrap:wrap;min-height:22px}
.mj-player-melds{flex-shrink:0;display:flex;gap:3px;color:#8fa4b5}
.mj-player-river{flex-shrink:0;display:flex;gap:1px;max-width:120px;flex-wrap:wrap;color:#6b8b95}
.mj-mini-tile{display:inline-flex;align-items:center;justify-content:center;width:20px;height:26px;border-radius:3px;font-size:10px;font-weight:700;border:1px solid rgba(179,205,224,.2);line-height:1}
.mj-mini-tile.m{background:#f5ebe6;color:#8b1a1a;border-color:#c4a882}
.mj-mini-tile.p{background:#e6eff5;color:#1a3a8b;border-color:#8ba8c4}
.mj-mini-tile.s{background:#e6f5ee;color:#1a6b3a;border-color:#7ec49b}
.mj-mini-tile.z{background:#f0f0f0;color:#1a1a1a;border-color:#999}
.mj-mini-tile.aka{box-shadow:0 0 3px #e04040;color:#c03030}
.mj-mini-tile.tsumogiri{opacity:.7}
.mj-detail .mj-event-list{max-height:180px;overflow:auto;margin-top:6px}
.mj-dora-row{display:flex;gap:4px;align-items:center;margin:4px 0;font-size:11px}
.mj-dora-label{color:#8fa4b5;margin-right:4px}
.mj-log-link{margin-top:6px;font-size:11px}
.mj-log-link a{color:#72e0c0;text-decoration:none}
.mj-log-link a:hover{text-decoration:underline}
.mj-full-viewer{width:660px;max-width:none;height:660px;border:0;background:#0e3438}
@media (max-width:480px){.mj-card{max-width:100%}.mj-card-foot{flex-direction:column;align-items:stretch}.mj-actions{justify-content:flex-end}.mj-mini-table{min-width:360px}}
`;

    let disposeStyles;
    if (typeof document !== 'undefined') {
      const style = document.createElement('style');
      style.setAttribute('data-mj-card', '1');
      style.textContent = CSS;
      document.head.appendChild(style);
      disposeStyles = () => { try { style.remove(); } catch (_) {} };
    }

    // ---- Log-viewer reducer (subset from app.js) ----
    const TILE_NAMES_34 = ['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s','3s','4s','5s','6s','7s','8s','9s','E','S','W','N','P','F','C'];
    const TILE_LABELS = { E:'東', S:'南', W:'西', N:'北', P:'白', F:'發', C:'中' };
    const SEAT_WINDS = ['東', '南', '西', '北'];

    function tileSuitClass(pai) {
      if (!pai || pai === '?') return 'z';
      const base = pai.endsWith('r') ? pai.slice(0, -1) : pai;
      if (/^[1-9]m/.test(base)) return pai.endsWith('r') ? 'm aka' : 'm';
      if (/^[1-9]p/.test(base)) return pai.endsWith('r') ? 'p aka' : 'p';
      if (/^[1-9]s/.test(base)) return pai.endsWith('r') ? 's aka' : 's';
      return 'z';
    }
    function tileDisplay(pai) {
      if (!pai || pai === '?') return '?';
      if (pai.endsWith('r')) return '赤' + pai[0];
      if (TILE_LABELS[pai]) return TILE_LABELS[pai];
      return pai;
    }

    function reduceEvents(events) {
      if (!Array.isArray(events) || !events.length) return null;
      // Build board state from events
      var players = [{hand:[],discards:[],melds:[],score:25000,reach:false},
                     {hand:[],discards:[],melds:[],score:25000,reach:false},
                     {hand:[],discards:[],melds:[],score:25000,reach:false},
                     {hand:[],discards:[],melds:[],score:25000,reach:false}];
      var dora = [];
      var round = { wind:'?', number:1, honba:0 };
      var lastEvent = null;
      var tileCount = 0;

      events.forEach(function(ev) {
        if (!ev || typeof ev !== 'object') return;
        lastEvent = ev;
        var actor = Number.isInteger(ev.actor) ? players[ev.actor] : null;
        var target = Number.isInteger(ev.target) ? players[ev.target] : null;
        switch (ev.type) {
          case 'start_kyoku':
            round = { wind: ev.bakaze || 'E', number: ev.kyoku || 1, honba: ev.honba || 0 };
            dora = ev.dora_marker ? [ev.dora_marker] : [];
            (ev.tehais || [[],[],[],[]]).forEach(function(h, i) {
              players[i].hand = h.slice();
              players[i].discards = [];
              players[i].melds = [];
              players[i].reach = false;
            });
            if (Array.isArray(ev.scores)) ev.scores.forEach(function(s, i) { players[i].score = s; });
            tileCount = 70;
            break;
          case 'tsumo':
            if (actor) { actor.hand.push(ev.pai); tileCount--; }
            break;
          case 'dahai':
            if (actor) {
              var idx = actor.hand.lastIndexOf(ev.pai);
              if (idx < 0) idx = actor.hand.lastIndexOf(ev.pai.replace(/r$/, ''));
              if (idx >= 0) actor.hand.splice(idx, 1);
              actor.discards.push({pai: ev.pai, tsumogiri: !!ev.tsumogiri, reach: !!actor.reach});
            }
            break;
          case 'reach':
            if (actor) actor.reach = true;
            break;
          case 'reach_accepted':
            if (actor) actor.reach = true;
            break;
          case 'chi':
          case 'pon':
          case 'daiminkan':
            if (target) target.discards.pop();
            if (actor) {
              (ev.consumed || []).forEach(function(p) { var i = actor.hand.lastIndexOf(p); if (i < 0) i = actor.hand.lastIndexOf(p.replace(/r$/, '')); if (i >= 0) actor.hand.splice(i, 1); });
              actor.melds.push({type: ev.type, taken: ev.pai, consumed: ev.consumed || [], target: ev.target});
            }
            break;
          case 'ankan':
            if (actor) {
              (ev.consumed || []).forEach(function(p) { var i = actor.hand.lastIndexOf(p); if (i < 0) i = actor.hand.lastIndexOf(p.replace(/r$/, '')); if (i >= 0) actor.hand.splice(i, 1); });
              actor.melds.push({type: ev.type, consumed: ev.consumed || []});
            }
            break;
          case 'kakan':
            if (actor) {
              var ki = actor.hand.lastIndexOf(ev.pai);
              if (ki < 0) ki = actor.hand.lastIndexOf(ev.pai.replace(/r$/, ''));
              if (ki >= 0) actor.hand.splice(ki, 1);
            }
            break;
          case 'dora':
            if (ev.dora_marker) dora.push(ev.dora_marker);
            break;
          default: break;
        }
        if (Array.isArray(ev.scores)) ev.scores.forEach(function(s, i) { players[i].score = s; });
      });
      return { players: players, dora: dora, round: round, lastEvent: lastEvent, tileCount: tileCount };
    }

    function renderMiniTile(pai, extraClass) {
      return h('span', {
        className: 'mj-mini-tile ' + tileSuitClass(pai) + (extraClass ? ' ' + extraClass : ''),
      }, tileDisplay(pai));
    }

    function MiniTable(props) {
      var board = props.board;
      if (!board) return h('div', { className: 'mj-table-placeholder' }, '暂无牌桌数据');
      var players = board.players;
      var dora = board.dora || [];
      var round = board.round || {};

      return h('div', { className: 'mj-mini-table' },
        // Dora row
        h('div', { className: 'mj-dora-row' },
          h('span', { className: 'mj-dora-label' }, '宝牌指示:'),
          dora.length ? dora.map(function(m, i) { return renderMiniTile(m, 'dora'); }) : h('span', null, '—')
        ),
        // Player rows (0=自家, 1=下家, 2=对家, 3=上家)
        players.map(function(player, seat) {
          var hand = (player.hand || []).slice().sort();
          var river = (player.discards || []).slice(-12);
          var melds = player.melds || [];
          var isActive = board.lastEvent && board.lastEvent.actor === seat;
          var wind = SEAT_WINDS[seat];

          return h('div', {
            className: 'mj-player-row' + (isActive ? ' active' : ''),
            key: seat
          },
            h('span', { className: 'mj-player-name' }, wind + ' ' + (['自家','下家','对家','上家'][seat])),
            h('span', { className: 'mj-player-score' }, Number(player.score).toLocaleString()),
            player.reach ? h('span', { style: {color:'#f28c8c',fontSize:'10px',marginRight:'4px'} }, '立直') : null,
            h('span', { className: 'mj-player-hand' },
              hand.map(function(pai, i) { return renderMiniTile(pai); })
            ),
            h('span', { className: 'mj-player-melds' },
              melds.map(function(m, mi) {
                var label = {chi:'吃',pon:'碰',daiminkan:'大明杠',ankan:'暗杠',kakan:'加杠'}[m.type] || m.type;
                return h('span', { key: mi, style: {fontSize:'9px',color:'#8fa4b5'} }, label + '(' + (m.consumed||[]).length + ')');
              })
            ),
            h('span', { className: 'mj-player-river' },
              river.map(function(d, di) {
                return renderMiniTile(d.pai, d.tsumogiri ? 'tsumogiri' : '');
              })
            )
          );
        }),
        h('div', { style: {fontSize:'10px',color:'#8fa4b5',textAlign:'right',marginTop:'2px'} },
          '余牌 ~' + Math.max(0, board.tileCount || 70) + ' · ' +
          (SEAT_WINDS.indexOf(round.wind) >= 0
            ? SEAT_WINDS[SEAT_WINDS.indexOf(round.wind)] + round.number + '局'
            : '?局') +
          (round.honba ? ' ' + round.honba + '本場' : '')
        )
      );
    }

    // ---- Helper functions ----
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
      var labels = { tsumo:'摸牌', dahai:'打牌', chi:'吃', pon:'碰', daiminkan:'大明杠', ankan:'暗杠', kakan:'加杠', reach:'立直', reach_accepted:'立直成立', hora:'和牌', ryukyoku:'流局', start_kyoku:'局開始', end_kyoku:'局結束', start_game:'牌局開始', end_game:'牌局結束' };
      var t = labels[ev.type] || ev.type || 'event';
      if (ev.pai) return t + ' ' + (TILE_LABELS[ev.pai] || ev.pai) + (Number.isInteger(ev.actor) ? ' @' + ev.actor : '');
      if (Number.isInteger(ev.actor)) return t + ' @' + ev.actor;
      return t;
    }

    // ---- Main View component ----
    function View(props) {
      var stateHook = React.useState(null);
      var stateVal = stateHook[0];
      var setState = stateHook[1];
      var openHook = React.useState(false);
      var openVal = openHook[0];
      var setOpen = openHook[1];
      var exportedHook = React.useState(null);
      var exportedVal = exportedHook[0];
      var setExported = exportedHook[1];
      var input = parseBlock(props.block);
      var sessionId = input.sessionId || derivedSessionId(props.callId);

      React.useEffect(function () {
        var alive = true;
        function refresh() {
          host.call('mahjong.status', { sessionId: sessionId }).then(function (next) {
            if (alive) setState(next);
          }).catch(function () {});
        }
        refresh();
        if (timer && timer.interval) {
          var stop = timer.interval(refresh, 1200);
          return function () { alive = false; if (typeof stop === 'function') stop(); };
        }
        var id = setInterval(refresh, 1200);
        return function () { alive = false; clearInterval(id); };
      }, [sessionId]);

      var data = stateVal || input || {};
      var scores = Array.isArray(data.scores) ? data.scores : [25000, 25000, 25000, 25000];
      var events = Array.isArray(data.events) ? data.events : [];
      var recent = events.slice(-40);
      var board = reduceEvents(events);

      function exportLog() {
        host.call('mahjong.export', { sessionId: sessionId }).then(function (r) {
          setExported(r);
          setOpen(true);
        }).catch(function (error) {
          setExported({ error: String(error) });
          setOpen(true);
        });
      }

      return h('div', { className: 'mj-card' },
        // Header
        h('div', { className: 'mj-card-head' },
          h('strong', null, '日本麻将对局'),
          h('span', { className: 'mj-state' }, data.status || 'starting')
        ),
        // Compact board
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
            h('div', null, events.length ? '事件 ' + events.length : '紧凑牌桌预览')
          ),
          h('div', null)
        ),
        // Score row
        h('div', { className: 'mj-score' },
          h('span', { className: 'mj-event' }, '最近：' + eventText(data.lastEvent)),
          h('span', null, '事件 ' + Number(data.eventCount || events.length || 0))
        ),
        // Foot
        h('div', { className: 'mj-card-foot' },
          h('span', { className: 'mj-event' },
            data.error || (data.status === 'ended'
              ? '对局完成，可查看完整牌谱'
              : data.status === 'failed'
                ? 'worker 异常，可重试开局'
                : data.status === 'cancelling'
                  ? '取消中...'
                  : '规则引擎与模型决策进行中')
          ),
          h('div', { className: 'mj-actions' },
            h('button', {
              className: 'mj-button primary',
              type: 'button',
              onClick: function () { setOpen(!openVal); },
            }, openVal ? '收起牌桌' : '展开牌桌'),
            (data.status === 'ended' || data.status === 'failed')
              ? h('button', { className: 'mj-button', type: 'button', onClick: exportLog }, '导出 MJAI')
              : null
          )
        ),
        // Detail panel (expanded)
        openVal
          ? h('div', { className: 'mj-detail' },
              h('div', { className: 'mj-detail-note' },
                '详情层 · 紧凑牌桌（牌面 30×40 CC0 SVG 完整版请用独立回放器）。不抢占对话历史。'
              ),
              // Full viewer when the supervised local server is available.
              h('div', { className: 'mj-table-scroll' },
                data.viewerUrl
                  ? h('iframe', {
                      className: 'mj-full-viewer',
                      src: data.viewerUrl,
                      title: '完整日本麻将牌谱',
                      sandbox: 'allow-scripts allow-same-origin',
                    })
                  : h(MiniTable, { board: board })
              ),
              // Stats
              h('p', { className: 'mj-scroll-hint' },
                '违规 ' + Number(data.violations || 0) +
                ' · 兜底 ' + Number(data.fallbacks || 0) +
                ' · LLM 调用 ' + Number(data.llmCalls || 0) +
                (data.model ? ' · ' + data.model : '') +
                (data.elapsedMs ? ' · 耗时 ' + (data.elapsedMs / 1000).toFixed(1) + 's' : '')
              ),
              // Event list
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
              !data.viewerUrl
                ? h('div', { className: 'mj-log-link' }, '完整回放服务未启动；当前显示紧凑牌桌。')
                : null,
              // Export preview
              exportedVal
                ? h('pre', { style: { fontSize: 10, whiteSpace: 'pre-wrap' } },
                    JSON.stringify({
                      sessionId: exportedVal.sessionId || sessionId,
                      status: exportedVal.status,
                      scores: exportedVal.scores,
                      eventCount: exportedVal.eventCount,
                      violations: exportedVal.violations,
                      fallbacks: exportedVal.fallbacks,
                    }, null, 2)
                  )
                : null
            )
          : null
      );
    }

    // ---- Slot registration ----
    var inject = slots.inject('tool.call.toolview', function () {
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
