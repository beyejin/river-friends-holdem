export const HAND_NAMES = ['하이 카드', '원 페어', '투 페어', '트리플', '스트레이트', '플러시', '풀 하우스', '포 카드', '스트레이트 플러시'];
export const STARTING_CHIPS = 20000;
// Tables and ledger records created before the 20,000-chip start keep their 30,000-chip unit.
export const LEGACY_CHIPS = 30000;
export const HISTORY_LIMIT = 50;

export function weekKey(timestamp) {
  const date = new Date(timestamp + 9 * 60 * 60 * 1000);
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function shuffledDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const limit = Math.floor(2 ** 32 / (i + 1)) * (i + 1);
    let n;
    do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit);
    const j = n % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function evaluate(cards) {
  const ranks = cards.map(c => c % 13 + 2).sort((a, b) => b - a);
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const straight = values => {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    if (unique.includes(14)) unique.push(1);
    for (let i = 0; i <= unique.length - 5; i++) if (unique[i] - unique[i + 4] === 4) return unique[i];
    return 0;
  };
  const flush = [0, 1, 2, 3].map(s => cards.filter(c => Math.floor(c / 13) === s).map(c => c % 13 + 2).sort((a, b) => b - a)).find(v => v.length >= 5);
  let result;
  if (flush && straight(flush)) result = [8, straight(flush)];
  else if (groups[0][1] === 4) result = [7, groups[0][0], ...ranks.filter(r => r !== groups[0][0]).slice(0, 1)];
  else if (groups[0][1] >= 3 && groups[1]?.[1] >= 2) result = [6, groups[0][0], groups[1][0]];
  else if (flush) result = [5, ...flush.slice(0, 5)];
  else if (straight(ranks)) result = [4, straight(ranks)];
  else if (groups[0][1] === 3) result = [3, groups[0][0], ...ranks.filter(r => r !== groups[0][0]).slice(0, 2)];
  else if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a).slice(0, 2);
    result = [2, ...pairs, ...ranks.filter(r => !pairs.includes(r)).slice(0, 1)];
  } else if (groups[0][1] === 2) result = [1, groups[0][0], ...ranks.filter(r => r !== groups[0][0]).slice(0, 3)];
  else result = [0, ...ranks.slice(0, 5)];
  while (result.length < 6) result.push(0);
  return { score: result.reduce((v, r) => v * 15 + r, 0), name: result[0] === 8 && result[1] === 14 ? '로열 플러시' : HAND_NAMES[result[0]] };
}

export function createRoom(id, hostId, name) {
  return { id, name, hostId, chipUnit: STARTING_CHIPS, players: [], records: {}, ledger: [], stage: 'waiting', board: [], deck: [], dealer: -1, turn: -1, hand: 0, bet: 0, minRaise: 200, smallBlind: 100, bigBlind: 200, pot: 0, log: [], result: [], history: [], revision: 0, deadline: null };
}

export function migrateChipUnit(room) {
  room.ledger ||= [];
  if ([STARTING_CHIPS, LEGACY_CHIPS].includes(room.chipUnit)) return false;
  const scale = LEGACY_CHIPS / (room.chipUnit || 2000);
  const scaleValue = value => Number.isFinite(value) ? value * scale : value;
  for (const player of room.players) {
    for (const key of ['chips', 'bet', 'total', 'startChips']) if (player[key] !== undefined) player[key] = scaleValue(player[key]);
    player.lastAction = player.lastAction?.replace(/^(콜|레이즈|베팅) (\d+)$/, (_, action, amount) => `${action} ${scaleValue(Number(amount))}`);
  }
  for (const record of Object.values(room.records)) record.net = scaleValue(record.net);
  for (const key of ['bet', 'minRaise', 'smallBlind', 'bigBlind', 'pot']) if (room[key] !== undefined) room[key] = scaleValue(room[key]);
  for (const result of room.result) result.amount = scaleValue(result.amount);
  for (const hand of room.history) for (const result of hand.result) result.amount = scaleValue(result.amount);
  room.log = room.log.map(message => message
    .replace(/(블라인드 )(\d+)( \/ )(\d+)/, (_, prefix, small, divider, big) => `${prefix}${scaleValue(Number(small))}${divider}${scaleValue(Number(big))}`)
    .replace(/: (콜|레이즈) (\d+)$/, (_, action, amount) => `: ${action} ${scaleValue(Number(amount))}`)
    .replace(/\+(\d+)(?= \()/g, (_, amount) => `+${scaleValue(Number(amount))}`));
  room.chipUnit = LEGACY_CHIPS;
  room.revision++;
  return true;
}

export function addPlayer(room, id, name) {
  const existing = room.players.find(p => p.id === id);
  if (existing) { existing.name = name; room.records[id].name = name; return; }
  if (!['waiting', 'finished'].includes(room.stage)) throw new Error('진행 중인 핸드가 끝난 뒤 입장해 주세요.');
  if (room.players.length >= 9) throw new Error('테이블 정원이 가득 찼습니다.');
  if (!room.records[id] && Object.keys(room.records).length >= 100) throw new Error('이 방의 참가 기록이 가득 찼습니다. 새 방을 만들어 주세요.');
  room.records[id] ||= { id, name, hands: 0, wins: 0, net: 0 };
  room.records[id].name = name;
  room.players.push({ id, name, chips: room.chipUnit, cards: [], folded: false, active: false, bet: 0, total: 0, actedAt: null, ready: false, lastAction: '대기 중' });
  if (!room.players.some(p => p.id === room.hostId)) room.hostId = id;
  log(room, `${name} 님이 입장했습니다.`);
}

function log(room, message) { room.log.unshift(message); room.log = room.log.slice(0, 35); }
function next(room, from, predicate) {
  for (let d = 1; d <= room.players.length; d++) {
    const i = (from + d + room.players.length) % room.players.length;
    if (predicate(room.players[i])) return i;
  }
  return -1;
}
const playing = p => p.active && !p.folded;
const canAct = p => playing(p) && p.chips > 0;
function pay(room, p, amount) {
  const value = Math.min(amount, p.chips);
  p.chips -= value; p.bet += value; p.total += value; room.pot += value;
}
function setTurn(room, i) { room.turn = i; room.deadline = i < 0 ? null : Date.now() + 45000; }

export function startHand(room, id, deck = shuffledDeck()) {
  if (id !== room.hostId) throw new Error('방장만 핸드를 시작할 수 있습니다.');
  if (!['waiting', 'finished'].includes(room.stage)) throw new Error('이미 핸드가 진행 중입니다.');
  const participants = room.players.filter(p => p.ready && p.chips > 0);
  if (participants.length < 2) throw new Error('최소 2명이 준비해야 합니다.');
  room.deck = [...deck]; room.board = []; room.result = []; room.pot = 0; room.hand++;
  room.stage = 'preflop'; room.bet = room.bigBlind; room.minRaise = room.bigBlind;
  for (const p of room.players) {
    p.active = participants.includes(p); p.folded = !p.active; p.cards = [];
    p.bet = 0; p.total = 0; p.actedAt = null; p.startChips = p.chips; p.lastAction = p.active ? '' : '쉬는 중';
    if (p.active) { p.cards = [room.deck.pop(), room.deck.pop()]; }
  }
  for (const p of room.players) delete p.queued;
  room.dealer = next(room, room.dealer, p => p.active);
  room.sb = participants.length === 2 ? room.dealer : next(room, room.dealer, p => p.active);
  room.bb = next(room, room.sb, p => p.active);
  pay(room, room.players[room.sb], room.smallBlind);
  pay(room, room.players[room.bb], room.bigBlind);
  room.actions = [
    { stage: 'preflop', name: room.players[room.sb].name, text: `스몰 블라인드 ${room.players[room.sb].bet}` },
    { stage: 'preflop', name: room.players[room.bb].name, text: `빅 블라인드 ${room.players[room.bb].bet}` },
  ];
  log(room, `핸드 #${room.hand} 시작. 블라인드 ${room.smallBlind} / ${room.bigBlind}`);
  progress(room, room.bb);
}

export function legalActions(room, id) {
  const p = room.players[room.turn];
  if (!p || p.id !== id || !canAct(p)) return null;
  const toCall = Math.max(0, room.bet - p.bet);
  const reopened = p.actedAt === null || room.bet - p.actedAt >= room.minRaise;
  const opponents = room.players.filter(q => q.id !== id && canAct(q));
  return { toCall: Math.min(toCall, p.chips), canCheck: toCall === 0,
    canRaise: reopened && opponents.length > 0 && p.chips > toCall,
    min: Math.min(room.bet + room.minRaise, p.bet + p.chips), max: p.bet + p.chips };
}

export function act(room, id, action, amount) {
  const p = room.players[room.turn];
  if (!p || p.id !== id || !canAct(p)) throw new Error('지금은 내 차례가 아닙니다.');
  const legal = legalActions(room, id);
  if (action === 'fold') { p.folded = true; p.lastAction = '폴드'; }
  else if (action === 'check') {
    if (!legal.canCheck) throw new Error('콜 또는 폴드를 선택해 주세요.');
    p.lastAction = '체크';
  } else if (action === 'call') {
    if (legal.canCheck) throw new Error('체크할 수 있습니다.');
    pay(room, p, legal.toCall); p.lastAction = p.chips === 0 ? '올인' : `콜 ${legal.toCall}`;
  } else if (action === 'raise') {
    if (!legal.canRaise || !Number.isSafeInteger(amount) || amount < legal.min || amount > legal.max) throw new Error('가능한 레이즈 범위를 확인해 주세요.');
    const raiseSize = amount - room.bet;
    pay(room, p, amount - p.bet);
    room.bet = amount;
    if (raiseSize >= room.minRaise) room.minRaise = raiseSize;
    p.lastAction = p.chips === 0 ? '올인' : `레이즈 ${amount}`;
  } else throw new Error('알 수 없는 행동입니다.');
  p.actedAt = room.bet;
  delete p.queued;
  room.actions?.push({ stage: room.stage, name: p.name, text: p.lastAction });
  log(room, `${p.name}: ${p.lastAction}`);
  progress(room, room.turn);
}

export const QUEUE_TYPES = ['fold', 'checkFold', 'check', 'call'];

// A private pre-selected action. It runs when the turn arrives and expires with the betting round.
export function setQueued(room, id, queued) {
  const p = room.players.find(q => q.id === id);
  if (!p || !canAct(p) || ['waiting', 'finished'].includes(room.stage)) throw new Error('진행 중인 핸드에 참여할 때만 미리 선택할 수 있습니다.');
  if (room.players[room.turn] === p) throw new Error('지금 내 차례예요. 바로 행동해 주세요.');
  if (queued === null) { delete p.queued; return; }
  if (!QUEUE_TYPES.includes(queued?.type)) throw new Error('미리 선택할 행동을 확인해 주세요.');
  const toCall = Math.min(Math.max(0, room.bet - p.bet), p.chips);
  if (queued.type === 'check' && toCall > 0) throw new Error('맞춰야 할 베팅이 있어 체크를 미리 선택할 수 없습니다.');
  if (queued.type === 'call' && toCall === 0) throw new Error('맞출 베팅이 없어요. 체크를 선택해 주세요.');
  p.queued = { type: queued.type, stage: room.stage, ...(queued.type === 'call' ? { cap: toCall } : {}) };
}

function queuedAction(room, p) {
  const legal = legalActions(room, p.id);
  const { type, cap } = p.queued;
  if (type === 'fold') return 'fold';
  if (type === 'checkFold') return legal.canCheck ? 'check' : 'fold';
  if (type === 'check') return legal.canCheck ? 'check' : null;
  return !legal.canCheck && legal.toCall <= cap ? 'call' : null;
}

function progress(room, from) {
  const live = room.players.filter(playing);
  if (live.length === 1) { settle(room, false); return; }
  const actors = room.players.filter(canAct);
  if (actors.length === 1) room.bet = Math.max(...live.map(p => p.bet));
  const needsAction = p => canAct(p) && (p.bet < room.bet || (p.actedAt === null && actors.length > 1));
  const turn = next(room, from, needsAction);
  if (turn !== -1) {
    setTurn(room, turn);
    const p = room.players[turn];
    if (p.queued) {
      const action = queuedAction(room, p);
      delete p.queued;
      if (action) act(room, p.id, action);
    }
    return;
  }
  if (room.stage === 'river') { settle(room, true); return; }
  const nextStage = { preflop: 'flop', flop: 'turn', turn: 'river' }[room.stage];
  room.stage = nextStage;
  room.deck.pop(); // Burn one card before each board reveal.
  for (let i = 0; i < (nextStage === 'flop' ? 3 : 1); i++) room.board.push(room.deck.pop());
  room.bet = 0; room.minRaise = room.bigBlind;
  for (const p of room.players) { p.bet = 0; p.actedAt = null; delete p.queued; if (canAct(p)) p.lastAction = ''; }
  log(room, `${{ flop: '플롭', turn: '턴', river: '리버' }[nextStage]} 공개`);
  progress(room, room.dealer);
}

export function settle(room, showdown) {
  const live = room.players.filter(playing);
  const awards = new Map(), refunds = new Map();
  const ranks = new Map(live.map(p => [p.id, showdown ? evaluate([...p.cards, ...room.board]) : { score: 0, name: '모두 폴드' }]));
  const levels = [...new Set(room.players.map(p => p.total).filter(Boolean))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = room.players.filter(p => p.total >= level);
    const amount = (level - previous) * contributors.length; previous = level;
    // An unmatched top contribution is returned, even if its owner folded.
    if (contributors.length === 1) { contributors[0].chips += amount; refunds.set(contributors[0].id, (refunds.get(contributors[0].id) || 0) + amount); continue; }
    const eligible = live.filter(p => p.total >= level);
    if (!eligible.length) throw new Error('팟 정산 상태가 올바르지 않습니다.');
    const best = Math.max(...eligible.map(p => ranks.get(p.id).score));
    const winners = eligible.filter(p => ranks.get(p.id).score === best);
    winners.sort((a, b) => ((room.players.indexOf(a) - room.dealer - 1 + room.players.length) % room.players.length) - ((room.players.indexOf(b) - room.dealer - 1 + room.players.length) % room.players.length));
    winners.forEach((p, i) => {
      const share = Math.floor(amount / winners.length) + (i < amount % winners.length ? 1 : 0);
      p.chips += share; awards.set(p.id, (awards.get(p.id) || 0) + share);
    });
  }
  room.result = [...awards].map(([id, amount]) => ({ id, name: room.players.find(p => p.id === id).name, amount, handName: ranks.get(id).name }));
  for (const p of room.players.filter(p => p.active)) {
    room.records[p.id].hands++;
    room.records[p.id].net += p.chips - p.startChips;
    if (awards.has(p.id)) room.records[p.id].wins++;
    p.ready = false;
  }
  room.showdown = showdown;
  room.history.unshift({ hand: room.hand, result: room.result, board: [...room.board], at: Date.now(), actions: room.actions || [],
    players: room.players.filter(p => p.active).map(p => ({ id: p.id, name: p.name, start: p.startChips, contributed: p.total, refund: refunds.get(p.id) || 0,
      end: p.chips, won: awards.get(p.id) || 0, folded: p.folded, cards: [...p.cards], revealed: showdown && playing(p) })) });
  room.history = room.history.slice(0, HISTORY_LIMIT);
  room.actions = [];
  for (const p of room.players) delete p.queued;
  room.stage = 'finished'; room.pot = 0; setTurn(room, -1);
  log(room, room.result.map(r => `${r.name} +${r.amount} (${r.handName})`).join(' / '));
}

export function publicRoom(room, id, online = []) {
  const currentWeek = weekKey(Date.now());
  const ledgerRanking = Object.values(room.records).map(record => {
    const sessions = room.ledger.filter(entry => entry.players.some(player => player.id === record.id));
    const net = (entry, player) => player.finalChips - (entry.startChips ?? LEGACY_CHIPS) * (1 + player.rebuys);
    const weeklyWins = room.ledger.filter(entry => entry.week === currentWeek && (() => {
      const scores = entry.players.map(player => net(entry, player));
      const best = Math.max(...scores);
      return entry.players.some(player => player.id === record.id && net(entry, player) === best);
    })()).length;
    return { id: record.id, name: record.name, weeklyWins, net: sessions.reduce((sum, entry) => sum + net(entry, entry.players.find(player => player.id === record.id)), 0), finalChips: sessions.reduce((sum, entry) => sum + entry.players.find(player => player.id === record.id).finalChips, 0) };
  }).filter(record => room.ledger.some(entry => entry.players.some(player => player.id === record.id)))
    .sort((a, b) => b.weeklyWins - a.weeklyWins || b.net - a.net || b.finalChips - a.finalChips);
  return {
    id: room.id, name: room.name, hostId: room.hostId, chipUnit: room.chipUnit, stage: room.stage, board: room.board, dealer: room.dealer,
    sb: room.sb, bb: room.bb, turn: room.turn, hand: room.hand, bet: room.bet, smallBlind: room.smallBlind,
    bigBlind: room.bigBlind, pot: room.pot, log: room.log, result: room.result,
    // Hand history keeps every hole card; only showdown hands and the viewer's own cards leave the server.
    history: room.history.map(hand => ({ ...hand, players: hand.players?.map(({ cards, revealed, ...p }) => ({ ...p, cards: revealed || p.id === id ? cards : null })) })),
    queued: room.players.find(p => p.id === id)?.queued || null,
    revision: room.revision, deadline: room.deadline, me: id, legal: legalActions(room, id),
    players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, bet: p.bet, ready: p.ready, active: p.active,
      folded: p.folded, lastAction: p.lastAction, online: online.includes(p.id),
      cards: p.id === id || (room.stage === 'finished' && room.showdown && playing(p)) ? p.cards : p.cards.map(() => null) })),
    ranking: Object.values(room.records).sort((a, b) => b.net - a.net || b.wins - a.wins),
    ledger: room.ledger,
    ledgerRanking,
  };
}
