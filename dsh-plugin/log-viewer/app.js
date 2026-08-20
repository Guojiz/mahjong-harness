const WINDS = ['東', '南', '西', '北'];
const TILE_NAMES = ['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s','3s','4s','5s','6s','7s','8s','9s','E','S','W','N','P','F','C'];
const IMAGE_DIR = 'files/tiles/';
const TILE_LABELS = { E: '東', S: '南', W: '西', N: '北', P: '白', F: '發', C: '中' };
const SEAT_WINDS = ['東', '南', '西', '北'];
const state = {
  events: [],
  kyokus: [],
  snapshots: [],
  names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
  current: 0,
  kyoku: 0,
  viewpoint: 0,
  playing: false,
  timer: null,
  speed: 700,
  fileName: '内置演示牌谱',
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
const tileBase = (pai) => pai && pai.endsWith('r') ? pai.slice(0, -1) : pai;
const tileSort = (a, b) => {
  const idx = (tile) => { const base = tileBase(tile); const n = TILE_NAMES.indexOf(base); return n < 0 ? 99 : n; };
  return idx(a) - idx(b) || (a.endsWith('r') ? 1 : -1);
};
const tileName = (pai) => TILE_LABELS[pai] || pai || '—';
const tileImage = (pai) => {
  if (!pai) return `${IMAGE_DIR}Regular-Blank-m.svg`;
  if (pai === '?') return `${IMAGE_DIR}Regular-Back-m.svg`;
  const red = pai.endsWith('r');
  const base = tileBase(pai);
  if (/^[1-9][mps]$/.test(base)) {
    const suit = { m: 'Man', p: 'Pin', s: 'Sou' }[base[1]];
    return `${IMAGE_DIR}Regular-${suit}${base[0]}${red ? '-Dora' : ''}-m.svg`;
  }
  const honor = { E: 'Ton', S: 'Nan', W: 'Shaa', N: 'Pei', P: 'Haku', F: 'Hatsu', C: 'Chun' }[base];
  return `${IMAGE_DIR}Regular-${honor}-m.svg`;
};
const img = (pai, cls = 'tile-img') => `<img class="${cls}" src="${tileImage(pai, 1)}" alt="${esc(tileName(pai))}" title="${esc(tileName(pai))}">`;
const orientedTile = (pai, horizontal = false, extraClass = '') => `<span class="tile-slot${horizontal ? ' horizontal' : ''}${extraClass ? ` ${extraClass}` : ''}">${img(pai)}</span>`;

function blankBoard() {
  return { players: [0,1,2,3].map(() => ({ hand: [], discards: [], melds: [], score: 25000, reach: false, reachIndex: null, tsumo: null })), dora: [], round: { wind: 'E', number: 1, honba: 0, kyotaku: 0 }, last: null };
}
function cloneBoard(board) {
  return JSON.parse(JSON.stringify(board));
}
function removeTile(hand, pai) {
  let index = hand.lastIndexOf(pai);
  if (index < 0) index = hand.lastIndexOf(tileBase(pai));
  if (index < 0) index = hand.indexOf('?');
  if (index >= 0) hand.splice(index, 1);
}
function sortHand(player) { player.hand = player.hand.filter(Boolean).sort(tileSort); }
function applyEvent(board, event) {
  const next = cloneBoard(board);
  next.last = event;
  const actor = Number.isInteger(event.actor) ? next.players[event.actor] : null;
  const target = Number.isInteger(event.target) ? next.players[event.target] : null;
  switch (event.type) {
    case 'start_kyoku':
      next.round = { wind: event.bakaze, number: event.kyoku, honba: event.honba || 0, kyotaku: event.kyotaku || 0 };
      next.dora = event.dora_marker ? [event.dora_marker] : [];
      next.players = (event.tehais || [[],[],[],[]]).map((hand, i) => ({ hand: [...hand], discards: [], melds: [], score: (event.scores || [25000,25000,25000,25000])[i], reach: false, reachIndex: null, tsumo: null }));
      next.players.forEach(sortHand);
      break;
    case 'tsumo':
      if (actor) actor.hand.push(event.pai), actor.tsumo = event.pai;
      break;
    case 'dahai':
      if (actor) { removeTile(actor.hand, event.pai); actor.tsumo = null; actor.discards.push({ pai: event.pai, tsumogiri: !!event.tsumogiri, reach: !!actor.reach }); sortHand(actor); }
      break;
    case 'reach': if (actor) actor.reachIndex = actor.discards.length; break;
    case 'reach_accepted': if (actor) actor.reach = true; break;
    case 'chi':
    case 'pon':
    case 'daiminkan':
      if (target) target.discards.pop();
      if (actor) { (event.consumed || []).forEach((pai) => removeTile(actor.hand, pai)); actor.melds.push({ type: event.type, taken: event.pai, consumed: event.consumed || [], target: event.target }); actor.tsumo = null; sortHand(actor); }
      break;
    case 'ankan':
      if (actor) { (event.consumed || []).forEach((pai) => removeTile(actor.hand, pai)); actor.melds.push({ type: event.type, consumed: event.consumed || [] }); actor.tsumo = null; sortHand(actor); }
      break;
    case 'kakan':
      if (actor) { removeTile(actor.hand, event.pai); const old = actor.melds.find((meld) => meld.type === 'pon' && tileBase(meld.taken) === tileBase(event.pai)); if (old) old.type = 'kakan'; actor.tsumo = null; sortHand(actor); }
      break;
    case 'dora': if (event.dora_marker) next.dora.push(event.dora_marker); break;
    default: break;
  }
  if (Array.isArray(event.scores)) event.scores.forEach((score, i) => { next.players[i].score = score; });
  return next;
}
function makeSnapshots(events) {
  const result = [blankBoard()];
  let board = result[0];
  events.forEach((event) => { board = applyEvent(board, event); result.push(board); });
  return result;
}
function buildKyokus(events) {
  const groups = [];
  let current = null;
  events.forEach((event, index) => {
    if (event.type === 'start_kyoku') {
      current = { start: index, end: index, event: event };
      groups.push(current);
    }
    if (current) current.end = index;
  });
  return groups;
}

function compactAction(event) {
  if (!event) return '—';
  const labels = { tsumo: '摸牌', dahai: '打牌', chi: '吃', pon: '碰', daiminkan: '大明杠', ankan: '暗杠', kakan: '加杠', reach: '立直', reach_accepted: '立直成立', hora: '和牌', ryukyoku: '流局', start_kyoku: '局开始', end_kyoku: '局结束', start_game: '牌局开始', end_game: '牌局结束' };
  return labels[event.type] || event.type || '—';
}
function actionDetail(event) {
  if (!event) return '选择时间线上的事件查看详细信息。';
  if (event.type === 'dahai') return `${event.tsumogiri ? '摸切' : '手切'} ${tileName(event.pai)}`;
  if (event.type === 'tsumo') return `摸到 ${tileName(event.pai)}`;
  if (event.type === 'hora') return `${event.actor === event.target ? '自摸和牌' : '荣和'} · ${event.deltas ? event.deltas.map((n) => n > 0 ? `+${n}` : n).join(' / ') : ''}`;
  if (event.type === 'start_kyoku') return `${WINDS.indexOf(event.bakaze) >= 0 ? WINDS[WINDS.indexOf(event.bakaze)] : event.bakaze}${event.kyoku}局 · ${event.honba || 0}本场`;
  if (event.type === 'reach') return '玩家声明立直，等待打出宣言牌。';
  if (event.type === 'pon' || event.type === 'chi' || event.type.includes('kan')) return `${compactAction(event)} ${tileName(event.pai)} · ${event.consumed ? event.consumed.map(tileName).join(' ') : ''}`;
  return compactAction(event);
}
function renderMeld(meld, seat) {
  if (meld.type === 'ankan') {
    return `<span class="meld-group concealed">${(meld.consumed || []).map((pai, index) => orientedTile(index === 0 || index === 3 ? '?' : pai)).join('')}</span>`;
  }
  const direction = (4 + (meld.target ?? seat) - seat) % 4;
  const tiles = [...(meld.consumed || [])];
  const horizontalIndex = direction === 1 ? tiles.length : direction === 2 ? Math.floor(tiles.length / 2) : 0;
  tiles.splice(horizontalIndex, 0, meld.taken);
  return `<span class="meld-group source-${direction}">${tiles.map((pai, index) => orientedTile(pai, index === horizontalIndex, index === horizontalIndex ? 'called' : '')).join('')}</span>`;
}
function renderSeatLayer(player, seat, board) {
  const displaySeat = (seat - state.viewpoint + 4) % 4;
  const hand = player.hand || [];
  const tsumo = player.tsumo;
  const concealed = tsumo && hand.length % 3 === 2 ? hand.slice(0, -1) : hand;
  const handHtml = concealed.map((pai) => orientedTile(pai)).join('') + (tsumo && hand.length % 3 === 2 ? orientedTile(tsumo, false, 'tsumo') : '');
  const discards = player.discards || [];
  const river = [0, 1, 2].map((row) => `<div class="river-row">${discards.slice(row * 6, row * 6 + 6).map((item, offset) => orientedTile(item.pai, player.reachIndex === row * 6 + offset, player.reachIndex === row * 6 + offset ? 'reach-discard' : '')).join('')}</div>`).join('');
  const melds = (player.melds || []).map((meld) => renderMeld(meld, seat)).join('');
  const active = board.last && board.last.actor === seat ? ' active' : '';
  return `<div class="seat-layer seat-${displaySeat}${active}"><div class="river">${river}</div><div class="hand-row">${handHtml || orientedTile('?')}</div><div class="meld-row">${melds}</div></div>`;
}
function renderSeatHud(player, seat) {
  const displaySeat = (seat - state.viewpoint + 4) % 4;
  const name = state.names[seat] || `玩家 ${seat + 1}`;
  return `<div class="seat-hud hud-${displaySeat}"><span class="seat-wind">${SEAT_WINDS[seat]}</span><strong>${esc(name)}</strong><em>${(player.score ?? 0).toLocaleString()}</em>${player.reach ? '<span class="reach-badge">立直</span>' : ''}</div>`;
}
function renderScoreboard(board) {
  $('scoreboard').innerHTML = board.players.map((player, seat) => `<div class="score-row${seat === state.viewpoint ? ' active' : ''}"><span class="score-rank">${seat + 1}</span><span class="score-name">${esc(state.names[seat] || `玩家 ${seat + 1}`)}</span><span class="score-value">${(player.score ?? 0).toLocaleString()}</span></div>`).join('');
}
function renderKyokuList() {
  $('kyoku-count').textContent = `${state.kyokus.length} 局`;
  $('kyoku-list').innerHTML = state.kyokus.map((kyoku, index) => `<button type="button" class="kyoku-item${index === state.kyoku ? ' active' : ''}" data-kyoku="${index}"><span>${WINDS.indexOf(kyoku.event.bakaze) >= 0 ? WINDS[WINDS.indexOf(kyoku.event.bakaze)] : kyoku.event.bakaze}${kyoku.event.kyoku}局 · ${kyoku.event.honba || 0}本场</span><span>${kyoku.end - kyoku.start + 1} ev</span></button>`).join('');
  document.querySelectorAll('[data-kyoku]').forEach((button) => button.addEventListener('click', () => { state.kyoku = Number(button.dataset.kyoku); state.current = state.kyokus[state.kyoku].start; render(); }));
}
function render() {
  if (!state.events.length) return;
  const event = state.events[state.current];
  const board = state.snapshots[state.current + 1] || state.snapshots[0];
  const round = board.round || {};
  $('players').innerHTML = `<div class="seat-layers">${board.players.map((player, seat) => renderSeatLayer(player, seat, board)).join('')}</div><div class="seat-huds">${board.players.map((player, seat) => renderSeatHud(player, seat)).join('')}</div>`;
  $('dora-tiles').innerHTML = (board.dora || []).map((pai) => img(pai, 'tile-img')).join('');
  renderScoreboard(board);
  $('round-wind').textContent = WINDS.indexOf(round.wind) >= 0 ? WINDS[WINDS.indexOf(round.wind)] : (round.wind || '東');
  $('round-number').textContent = round.number || 1;
  $('honba-label').textContent = `${round.honba || 0} 本场`;
  $('tiles-left').textContent = Math.max(0, 70 - board.players.reduce((sum, player) => sum + player.discards.length, 0));
  $('timeline').value = state.current;
  $('event-label').textContent = `事件 ${state.current + 1} / ${state.events.length}`;
  $('event-type').textContent = event.type || 'unknown';
  $('event-title').textContent = compactAction(event);
  $('event-detail').textContent = actionDetail(event);
  $('trace-actor').textContent = Number.isInteger(event.actor) ? (state.names[event.actor] || `玩家 ${event.actor + 1}`) : '引擎';
  $('trace-action').textContent = compactAction(event);
  $('trace-tile').textContent = event.pai ? tileName(event.pai) : '—';
  $('trace-status').textContent = event.meta?.fallback ? '兜底执行' : event.meta?.invalid ? '规则拦截' : '规则引擎通过';
  $('trace-status').className = event.meta?.fallback || event.meta?.invalid ? 'danger-text' : 'success-text';
  $('decision-badge').textContent = event.meta?.fallback ? 'FALLBACK' : event.meta?.invalid ? 'BLOCKED' : Number.isInteger(event.actor) ? 'ENGINE' : 'SYSTEM';
  $('raw-event').textContent = JSON.stringify(event, null, 2);
  document.querySelectorAll('[data-kyoku]').forEach((button) => button.classList.toggle('active', Number(button.dataset.kyoku) === state.kyoku));
}
function loadEvents(events, fileName = '牌谱') {
  const clean = events.filter(Boolean);
  if (!clean.length) throw new Error('牌谱为空');
  state.events = clean;
  state.snapshots = makeSnapshots(clean);
  state.kyokus = buildKyokus(clean);
  state.current = Math.max(0, clean.findIndex((event) => event.type === 'start_kyoku'));
  state.kyoku = 0;
  state.fileName = fileName;
  const start = clean.find((event) => event.type === 'start_game');
  if (start?.names) state.names = start.names;
  $('match-meta').textContent = `${fileName} · ${clean.length} 个事件`;
  $('timeline').max = Math.max(0, clean.length - 1);
  $('log-status').textContent = '已载入';
  renderKyokuList();
  render();
}
async function parseFile(file) {
  let text;
  const buffer = await file.arrayBuffer();
  if (file.name.endsWith('.gz') || file.type === 'application/gzip') {
    if (!('DecompressionStream' in window)) throw new Error('当前浏览器不支持 gzip 解压，请使用 Chrome / Edge 113+。');
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(buffer);
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
function demoEvents() {
  const hands = [
    ['2m','3m','4m','4m','5m','6m','7p','8p','9p','2s','3s','4s','E'],
    ['1m','1m','2m','3m','7m','8m','9m','4p','5p','6p','7s','8s','P'],
    ['2p','3p','4p','5p','6p','7p','2s','2s','5s','6s','7s','N','N'],
    ['1m','9m','1p','9p','1s','9s','E','S','W','F','C','5mr','6s'],
  ];
  const events = [{ type: 'start_game', names: ['深度玩家', 'Mortal', '规则陪练', '研究员'], seed: [7, 0] }, { type: 'start_kyoku', bakaze: 'E', dora_marker: '6p', kyoku: 1, honba: 0, kyotaku: 0, oya: 0, scores: [25000,25000,25000,25000], tehais: hands }];
  const draws = ['5m','1p','7s','9s','8m','4p','5s','C','2m','3p','8s','F','6m','7p','4s','S','9m','1s','5p','W'];
  for (let i = 0; i < 20; i++) { const actor = i % 4; const pai = draws[i]; const discard = hands[actor][i % hands[actor].length]; events.push({ type: 'tsumo', actor, pai }); events.push({ type: 'dahai', actor, pai: i === 5 ? '7p' : discard, tsumogiri: i % 4 === 0, meta: i === 5 ? { q_values: [0.72, 0.21, -0.1], is_greedy: true } : undefined }); if (i === 7) events.push({ type: 'pon', actor: 1, target: 0, pai: 'E', consumed: ['E','E'], meta: { is_greedy: true } }); if (i === 12) events.push({ type: 'reach', actor: 2, meta: { is_greedy: true } }, { type: 'dahai', actor: 2, pai: 'N', tsumogiri: false }, { type: 'reach_accepted', actor: 2 }); }
  events.push({ type: 'hora', actor: 2, target: 0, deltas: [-8000,0,8000,0], ura_markers: ['4m'] }, { type: 'end_kyoku' }, { type: 'end_game' });
  return events;
}
function setPlaying(playing) { state.playing = playing; $('play-button').textContent = playing ? '暂停' : '播放'; if (playing) { clearTimeout(state.timer); state.timer = setTimeout(() => { if (state.current >= state.events.length - 1) return setPlaying(false); state.current += 1; const kyoku = state.kyokus.findIndex((item) => state.current >= item.start && state.current <= item.end); if (kyoku >= 0) state.kyoku = kyoku; render(); setPlaying(true); }, state.speed); } else clearTimeout(state.timer); }

$('file-input').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; try { loadEvents(await parseFile(file), file.name); } catch (error) { $('log-status').textContent = '读取失败'; $('match-meta').textContent = error.message; } });
$('demo-button').addEventListener('click', () => loadEvents(demoEvents(), '内置演示牌谱'));
$('drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
$('drop-zone').addEventListener('drop', async (event) => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); const file = event.dataTransfer.files[0]; if (!file) return; try { loadEvents(await parseFile(file), file.name); } catch (error) { $('match-meta').textContent = error.message; } });
$('timeline').addEventListener('input', (event) => { state.current = Number(event.target.value); const kyoku = state.kyokus.findIndex((item) => state.current >= item.start && state.current <= item.end); if (kyoku >= 0) state.kyoku = kyoku; render(); });
$('first-button').addEventListener('click', () => { state.current = 0; state.kyoku = 0; render(); });
$('last-button').addEventListener('click', () => { state.current = state.events.length - 1; state.kyoku = Math.max(0, state.kyokus.length - 1); render(); });
$('prev-button').addEventListener('click', () => { state.current = Math.max(0, state.current - 1); render(); });
$('next-button').addEventListener('click', () => { state.current = Math.min(state.events.length - 1, state.current + 1); render(); });
$('play-button').addEventListener('click', () => setPlaying(!state.playing));
$('speed-select').addEventListener('change', (event) => { state.speed = Number(event.target.value); if (state.playing) { setPlaying(false); setPlaying(true); } });
$('viewpoint-button').addEventListener('click', () => { state.viewpoint = (state.viewpoint + 1) % 4; $('viewpoint-button').textContent = `视角：${state.names[state.viewpoint] || '自家'}`; render(); });
$('fullscreen-button').addEventListener('click', () => document.documentElement.requestFullscreen?.());
$('theme-button').addEventListener('click', () => document.body.classList.toggle('light-mode'));
window.MJAIStudio = { loadEvents };
loadEvents(demoEvents());
