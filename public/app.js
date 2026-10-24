const $ = selector => document.querySelector(selector);
const app = $('#app');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = value => Number(value || 0).toLocaleString('ko-KR');
const stages = { waiting: '친구를 기다리는 중', preflop: '프리플롭', flop: '플롭', turn: '턴', river: '리버', finished: '핸드 종료' };
const suits = ['♠', '♥', '♣', '♦'];
const defaultMembers = ['한예진', '김영광', '남성수', '박진환', '배정호', '엄태웅', '주정원'].map(name => ({ key: `default:${name}`, name, cohort: '' }));
let room, socket, retryTimer, toastTimer, panel = 'ranking', pending = false, reconnectAttempt = 0, ledgerFormOpen = false, ledgerEditing = null, manualLedgerOpen = false, manualEditing = null, manualSessions = [];
let members = defaultMembers, recordMembers = defaultMembers, memberDeleting = false, memberDeleteTarget = null;
let manualDraft = null, manualSaving = false, rankingSort = 'wins', rankingStatus = 'loading';
let leaderboard = defaultMembers.map(member => ({ name: member.name, weeklyWins: 0, net: 0, finalChips: 0 }));
let selectedMemberKey = readLocal('river-member-key', 'default:한예진');
let connected = false;
let replyTimer, resumeTimer;
let renderedTurn = null, ledgerDraft = null, ledgerSavePending = null;
// Server states are shown one at a time so bets, new cards and results stay readable.
let stateQueue = [], queueTimer = null, animFrom = null, latestRoom = null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let code = new URLSearchParams(location.search).get('room') || '';
let nickname = readLocal('river-nickname', '');
function readLocal(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function saveLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* Private browser storage can be unavailable. */ } }
function recentRooms() { try { return JSON.parse(readLocal('river-rooms', '[]')); } catch { return []; } }
function renderMemberOptions() {
  const select = $('#member-select');
  if (!select) return;
  const selectingNew = select.value === '__new__';
  if (!members.some(member => member.key === selectedMemberKey)) selectedMemberKey = members[0]?.key || '';
  const selected = members.findIndex(member => member.key === selectedMemberKey);
  select.innerHTML = `${members.map((member, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${member.cohort ? `${escape(member.cohort)} ` : ''}${escape(member.name)}</option>`).join('')}<option value="__new__">새 회원 등록</option>`;
  if (selectingNew || !members.length) select.value = '__new__';
  $('#new-member-fields').hidden = select.value !== '__new__';
  $('#entry-button').textContent = select.value === '__new__' ? '등록하고 입장하기 →' : code ? '테이블 입장하기 →' : '새 테이블 만들기 →';
}
function setMembers(data) {
  members = data.members;
  recordMembers = data.recordMembers || data.members;
}
function renderMemberManager() {
  $('#member-management-list').hidden = Boolean(memberDeleteTarget);
  $('#member-delete-confirmation').hidden = !memberDeleteTarget;
  $('#member-delete-question').textContent = memberDeleteTarget ? `${memberLabel(memberDeleteTarget)} 멤버를 삭제할까요?` : '';
  $('#confirm-member-delete').disabled = memberDeleting;
  $('#cancel-member-delete').disabled = memberDeleting;
  $('#confirm-member-delete').textContent = memberDeleting ? '삭제 중…' : '삭제 확인';
  $('#member-management-list').innerHTML = members.map(member => `<li><b>${escape(memberLabel(member))}</b><button type="button" class="outline member-delete" data-member-delete="${escape(member.key)}" aria-label="${escape(memberLabel(member))} 삭제" ${memberDeleting ? 'disabled' : ''}>삭제</button></li>`).join('') || '<li>등록된 멤버가 없어요. 홈에서 새 회원을 등록해 주세요.</li>';
}
async function loadMembers() {
  const response = await fetch('/api/members');
  if (!response.ok) throw new Error('회원 명단을 불러오지 못했어요.');
  setMembers(await response.json());
  renderMemberOptions();
  renderMemberManager();
}
async function loadLeaderboard() {
  try {
    await Promise.all(recentRooms().map(async room => {
      try { await fetch(`/api/rooms/${room.id}/sync-ledger`); } catch { /* Retry when this table reconnects. */ }
    }));
    const response = await fetch('/api/leaderboard');
    if (!response.ok) throw new Error('랭킹을 불러오지 못했어요.');
    const data = await response.json();
    leaderboard = data.ranking;
    manualSessions = data.sessions || [];
    rankingStatus = 'ready';
  } catch { rankingStatus = 'error'; }
  renderHomeLeaderboard();
}
const koreaDate = timestamp => new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
function localDateTime(timestamp) {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
function memberLabel(member) { return `${member.cohort ? `${member.cohort} ` : ''}${member.name}`; }
function playerMemberKey(player) {
  return player.memberKey || recordMembers.find(member => member.name === player.name)?.key || `legacy:${player.name}`;
}
function deletedMemberLabel(key) {
  return recordMembers.some(member => member.key === key) && !members.some(member => member.key === key) ? '<span class="deleted-member-label">삭제된 멤버</span>' : '';
}
function readManualDraft() {
  const form = $('#home-record-form');
  if (!form) return manualDraft;
  return { date: form.elements.date.value, players: [...form.querySelectorAll('[data-home-row]')].map(row => ({
    memberKey: row.querySelector('[data-home-player]').value,
    selected: row.querySelector('[data-home-player]').checked,
    rebuys: row.querySelector('[data-home-rebuys]').value,
    wins: row.querySelector('[data-home-wins]').value,
    times: [...row.querySelectorAll('[data-home-rebuy-time]')].map(input => input.value),
  })) };
}
function draftForSession(session) {
  return { date: session?.date || koreaDate(Date.now()), players: (session?.players || []).map(player => ({
    memberKey: playerMemberKey(player), selected: true, rebuys: player.rebuys, wins: player.wins || 0,
    times: Array.from({ length: player.rebuys }, (_, index) => player.rebuyEvents?.[index] == null ? '' : localDateTime(player.rebuyEvents[index])),
  })) };
}
function homeRebuyTimes(times, label = '', disabled = false) {
  return times.map((value, index) => `<label>리바인 ${index + 1} 날짜와 시각<input aria-label="${escape(label)} 리바인 ${index + 1} 날짜와 시각" type="datetime-local" data-home-rebuy-time value="${escape(value)}" ${disabled ? 'disabled' : ''}><small>비워두면 미기록</small></label>`).join('');
}
function homeLeaderboardContent() {
  const editing = manualSessions.find(session => session.id === manualEditing);
  const draft = manualDraft || draftForSession(editing);
  const formMembers = [...members];
  for (const player of editing?.players || []) if (!formMembers.some(member => member.key === playerMemberKey(player))) formMembers.push(recordMembers.find(member => member.key === playerMemberKey(player)) || { key: playerMemberKey(player), name: player.name, cohort: player.cohort || '' });
  const rows = manualLedgerOpen ? formMembers.map(member => {
    const player = draft.players.find(item => item.memberKey === member.key);
    const selected = Boolean(player?.selected), label = memberLabel(member);
    return `<div class="home-record-row" data-home-row><label><input type="checkbox" data-home-player value="${escape(member.key)}" ${selected ? 'checked' : ''}><b>${escape(label)}</b>${deletedMemberLabel(member.key)}</label><label data-player-fields ${selected ? '' : 'hidden'}>리바인<input aria-label="${escape(label)} 리바인 횟수" type="number" min="0" max="100" step="1" value="${escape(player?.rebuys ?? 0)}" data-home-rebuys required ${selected ? '' : 'disabled'}></label><label data-player-fields ${selected ? '' : 'hidden'}>승리<input aria-label="${escape(label)} 승리 횟수" type="number" min="0" max="1000" step="1" value="${escape(player?.wins ?? 0)}" data-home-wins required ${selected ? '' : 'disabled'}></label><div class="home-rebuy-times" data-player-fields data-home-rebuy-times ${selected ? '' : 'hidden'}>${homeRebuyTimes(player?.times || [], label, !selected)}</div></div>`;
  }).join('') : '';
  const history = [...manualSessions].sort((a, b) => b.date.localeCompare(a.date)).map(session => `<article class="home-session"><header><b>${escape(session.date)}</b><button type="button" class="outline" data-home-edit="${escape(session.id)}" ${manualSaving ? 'disabled' : ''}>수정</button></header>${session.players.map(player => {
    const times = Array.from({ length: player.rebuys }, (_, index) => {
      const at = player.rebuyEvents?.[index];
      return `<li>리바인 ${index + 1}: ${at == null ? '<span class="unrecorded">미기록</span>' : `<time>${escape(new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))}</time>`}</li>`;
    }).join('');
    return `<div><p><b>${escape(memberLabel(player))}${deletedMemberLabel(playerMemberKey(player))}</b><span>승리 ${player.wins ?? 0}회 / 리바인 ${player.rebuys}회</span></p>${times ? `<details><summary>리바인 시각${Array.from({length: player.rebuys}, (_, i) => player.rebuyEvents?.[i]).some(at => at == null) ? ' (미기록 포함)' : ''}</summary><ol>${times}</ol></details>` : ''}</div>`;
  }).join('')}</article>`).join('');
  const ranked = [...leaderboard].sort((a, b) => rankingSort === 'rebuys' ? (b.rebuys || 0) - (a.rebuys || 0) || b.weeklyWins - a.weeklyWins : b.weeklyWins - a.weeklyWins || (b.wins || 0) - (a.wins || 0));
  return `<header class="home-ranking-heading"><h2 id="home-ranking-title">주간 랭킹</h2><button id="home-record-toggle" class="outline" ${manualSaving ? 'disabled' : ''}>${manualLedgerOpen ? '기록 닫기' : '지난 게임 기록'}</button></header><div class="home-ranking-sort" role="group" aria-label="랭킹 정렬"><button type="button" data-ranking-sort="wins" aria-pressed="${rankingSort === 'wins'}">주간 우승순</button><button type="button" data-ranking-sort="rebuys" aria-pressed="${rankingSort === 'rebuys'}">누적 리바인순</button></div><p class="home-ranking-note">월요일부터 일요일까지, 한국 시간 기준입니다.</p>${rankingStatus === 'loading' ? '<p role="status">랭킹을 불러오는 중…</p>' : rankingStatus === 'error' ? '<p role="status">최신 랭킹을 불러오지 못했어요. <button id="ranking-retry" class="outline">다시 시도</button></p>' : ''}<div class="home-ranking-columns"><span>이름</span><span>주간 우승</span><span>누적 리바인</span></div><ol class="home-ranking-list">${ranked.map((player, index) => `<li><span class="home-rank-number">${index + 1}</span><b>${escape(memberLabel(player))}${player.deleted ? '<span class="deleted-member-label">삭제된 멤버</span>' : ''}</b><span class="home-rank-wins">${rankingStatus === 'loading' ? '—' : `${player.weeklyWins ?? 0}회`}</span><span class="home-rank-rebuys">${rankingStatus === 'loading' ? '—' : `${player.rebuys ?? 0}회`}</span></li>`).join('')}</ol>${manualLedgerOpen ? `<form id="home-record-form" class="home-record-form"><h3 class="home-record-title" tabindex="-1">${editing ? '게임 기록 수정' : '지난 게임 추가'}</h3><fieldset ${manualSaving ? 'disabled' : ''}><label class="home-record-date">게임 날짜<input type="date" name="date" value="${escape(draft.date)}" required></label><p class="home-record-help">참가자 2~9명을 선택하세요. 리바인 날짜와 시각은 한국 시간으로 입력하며, 모르면 비워두세요.</p><div class="home-record-rows">${rows}</div><p id="home-record-error" role="alert"></p><div class="home-record-actions"><button type="submit" class="primary">${manualSaving ? '저장 중…' : editing ? '수정 저장' : '기록 저장'}</button><button type="button" id="home-record-cancel" class="outline">취소</button></div></fieldset></form>` : ''}<section class="home-session-history"><h3>게임별 기록</h3>${history || '<p>지난 게임을 추가하면 여기에서 다시 열고 수정할 수 있어요.</p>'}</section>`;
}
function renderHomeLeaderboard(preserveDraft = true) {
  const target = $('#home-leaderboard');
  if (!target) return;
  if (preserveDraft) manualDraft = readManualDraft();
  target.innerHTML = homeLeaderboardContent();
  $('#home-record-toggle').onclick = () => {
    manualLedgerOpen = !manualLedgerOpen; manualEditing = null; manualDraft = null;
    renderHomeLeaderboard(false);
    $('.home-record-title')?.focus();
  };
  $('#ranking-retry')?.addEventListener('click', loadLeaderboard);
  target.querySelectorAll('[data-ranking-sort]').forEach(button => button.onclick = () => { rankingSort = button.dataset.rankingSort; renderHomeLeaderboard(); });
  target.querySelectorAll('[data-home-edit]').forEach(button => button.addEventListener('click', () => {
    manualEditing = button.dataset.homeEdit; manualLedgerOpen = true;
    manualDraft = draftForSession(manualSessions.find(session => session.id === manualEditing));
    renderHomeLeaderboard(false); $('.home-record-title')?.focus();
  }));
  $('#home-record-cancel')?.addEventListener('click', () => { manualLedgerOpen = false; manualEditing = null; manualDraft = null; renderHomeLeaderboard(false); $('#home-record-toggle').focus(); });
  target.querySelectorAll('[data-home-player]').forEach(input => input.addEventListener('change', () => {
    const row = input.closest('[data-home-row]');
    row.querySelectorAll('[data-player-fields]').forEach(field => { field.hidden = !input.checked; });
    row.querySelectorAll('input:not([type=checkbox])').forEach(field => { field.disabled = !input.checked; });
  }));
  target.querySelectorAll('[data-home-rebuys]').forEach(input => input.addEventListener('input', () => {
    if (!input.validity.valid) return;
    const row = input.closest('[data-home-row]');
    const previous = [...row.querySelectorAll('[data-home-rebuy-time]')].map(field => field.value);
    const times = Array.from({ length: Number(input.value) }, (_, index) => previous[index] || '');
    row.querySelector('[data-home-rebuy-times]').innerHTML = homeRebuyTimes(times, row.querySelector('b').textContent);
  }));
  $('#home-record-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (manualSaving) return;
    const form = event.currentTarget;
    const players = [...form.querySelectorAll('[data-home-player]:checked')].map(checkbox => {
      const row = checkbox.closest('[data-home-row]');
      const member = recordMembers.find(item => item.key === checkbox.value);
      const oldPlayer = manualSessions.find(session => session.id === manualEditing)?.players.find(player => playerMemberKey(player) === checkbox.value);
      const rebuys = Number(row.querySelector('[data-home-rebuys]').value);
      const fields = [...row.querySelectorAll('[data-home-rebuy-time]')];
      const rebuyEvents = Array.from({ length: rebuys }, (_, index) => {
        const value = fields[index]?.value;
        if (!value) return null;
        const previous = oldPlayer?.rebuyEvents?.[index];
        return previous != null && localDateTime(previous) === value ? previous : Date.parse(`${value}+09:00`);
      });
      return { memberKey: member?.key || oldPlayer?.memberKey, name: member?.name || oldPlayer?.name, rebuys, rebuyEvents, wins: Number(row.querySelector('[data-home-wins]').value) };
    });
    if (players.length < 2 || players.length > 9) { $('#home-record-error').textContent = '참가자는 2~9명을 선택해 주세요.'; return; }
    const data = { sessionId: manualEditing, date: form.elements.date.value, players };
    manualDraft = readManualDraft(); manualSaving = true;
    renderHomeLeaderboard(false);
    try {
      await api('/api/session');
      const result = await api('/api/leaderboard/session', data);
      manualSessions = [result.session, ...manualSessions.filter(session => session.id !== result.session.id)];
      manualLedgerOpen = false; manualEditing = null; manualDraft = null; manualSaving = false;
      renderHomeLeaderboard(false);
      notify(data.sessionId ? '게임 기록을 수정했어요.' : '게임 기록을 저장했어요.');
      await loadLeaderboard();
    } catch (error) {
      manualSaving = false; renderHomeLeaderboard(false);
      $('#home-record-error').textContent = error.message;
    }
  });
}
function card(value, extra = '') {
  if (value === undefined) return '<div class="card placeholder" aria-label="아직 공개되지 않은 카드">♧</div>';
  if (value === null) return '<div class="card back" aria-label="상대의 비공개 카드"><span>R</span></div>';
  const rank = value % 13 + 2, suit = Math.floor(value / 13);
  return `<div class="card ${suit % 2 ? 'red' : ''} ${extra}" aria-label="${['스페이드', '하트', '클럽', '다이아몬드'][suit]} ${rank}"><b>${({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || rank}</b><span>${suits[suit]}</span></div>`;
}
function notify(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, data, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(payload.error || '요청을 처리하지 못했습니다.');
  return payload;
}
function home() {
  app.className = 'home';
  document.body.classList.remove('in-game');
  const invited = Boolean(code);
  app.innerHTML = `<section class="welcome">
    <h1>우리들의 <em>홀덤.</em></h1>
    <p class="intro">최대 9명, 시작 칩 30,000</p>
    <form id="entry-form" class="entry-form">
      <div class="form-title"><h2>${invited ? '친구의 테이블에 초대받았어요' : '테이블 열기'}</h2></div>
      <label for="member-select">이름 선택</label><select id="member-select" name="member" required></select>
      <div id="new-member-fields" hidden><label for="member-cohort">기수</label><input id="member-cohort" maxlength="20" placeholder="예: 9기"><label for="member-name">이름</label><input id="member-name" maxlength="20" placeholder="이름을 입력해 주세요"><button type="button" id="register-only" class="outline register-only">등록만 하기</button><p class="form-note">등록 후에도 테이블은 나중에 열 수 있어요.</p></div>
      ${invited ? `<p class="invite-hint">초대 코드 <span>${escape(code)}</span></p>` : ''}
      <button class="primary large" id="entry-button">${invited ? '테이블 입장하기' : '새 테이블 만들기'} <span>→</span></button>
      ${invited ? '<a class="back-home" href="/">내 테이블 새로 만들기</a>' : ''}
    </form>
    <button type="button" id="manage-members" class="outline manage-members" aria-haspopup="dialog">멤버 관리</button>
  </section>
  <section id="home-leaderboard" class="home-leaderboard" aria-labelledby="home-ranking-title">${homeLeaderboardContent()}</section>
  ${!invited && recentRooms().length ? `<section class="recent"><h2>다시 모이는 곳</h2>${recentRooms().map(r => `<a href="/?room=${escape(r.id)}"><span>♠ ${escape(r.name)}</span><span>이어 들어가기 ↗</span></a>`).join('')}</section>` : ''}
  <footer class="home-footer"><span>최대 9명 / 30,000 가상 칩</span><span>현금 결제와 환전이 없는 친구용 게임</span></footer>`;
  $('#manage-members').onclick = async () => {
    $('#member-management-error').textContent = '';
    $('#member-management-list').textContent = '멤버를 불러오는 중…';
    $('#member-management').showModal();
    try { await loadMembers(); } catch (error) { $('#member-management-list').textContent = ''; $('#member-management-error').textContent = error.message; }
  };
  $('#entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#entry-button'); button.disabled = true; button.textContent = '테이블에 연결하는 중…';
    try {
      await api('/api/session');
      const selected = $('#member-select').value;
      let member;
      if (selected === '__new__') {
        const cohort = $('#member-cohort').value.trim(), name = $('#member-name').value.trim();
        if (!cohort || !name) throw new Error('기수와 이름을 입력해 주세요.');
        const result = await api('/api/members', { cohort, name });
        setMembers(result); member = result.member;
      } else member = members[Number(selected)];
      if (!member) throw new Error('이름을 선택해 주세요.');
      nickname = member.name; selectedMemberKey = member.key;
      renderMemberOptions(); $('#member-select').value = String(members.findIndex(item => item.key === selectedMemberKey));
      $('#new-member-fields').hidden = true;
      saveLocal('river-nickname', nickname); saveLocal('river-member-key', selectedMemberKey);
      const result = await api(code ? `/api/rooms/${code}/join` : '/api/rooms', { nickname, memberKey: selectedMemberKey });
      code = result.code; history.replaceState({}, '', `/?room=${code}`); connect();
    } catch (error) { notify(error.message); button.disabled = false; button.textContent = $('#member-select').value === '__new__' ? '등록하고 입장하기 →' : invited ? '테이블 입장하기 →' : '새 테이블 만들기 →'; }
  });
  $('#member-select').addEventListener('change', event => {
    const registering = event.target.value === '__new__';
    if (!registering) selectedMemberKey = members[Number(event.target.value)]?.key || selectedMemberKey;
    $('#new-member-fields').hidden = !registering;
    $('#entry-button').textContent = registering ? '등록하고 입장하기 →' : (invited ? '테이블 입장하기 →' : '새 테이블 만들기 →');
  });
  $('#register-only').addEventListener('click', async () => {
    const cohort = $('#member-cohort').value.trim(), name = $('#member-name').value.trim();
    if (!cohort || !name) { notify('기수와 이름을 입력해 주세요.'); return; }
    const button = $('#register-only'); button.disabled = true;
    try {
      await api('/api/session');
      const result = await api('/api/members', { cohort, name });
      setMembers(result); selectedMemberKey = result.member.key; nickname = result.member.name;
      saveLocal('river-nickname', nickname); saveLocal('river-member-key', selectedMemberKey);
      renderMemberOptions();
      $('#member-select').value = String(members.findIndex(member => member.key === selectedMemberKey));
      $('#new-member-fields').hidden = true;
      $('#entry-button').textContent = invited ? '테이블 입장하기 →' : '새 테이블 만들기 →';
      await loadLeaderboard();
      notify('회원 등록을 마쳤어요. 테이블은 나중에 열어도 됩니다.');
    } catch (error) { notify(error.message); } finally { button.disabled = false; }
  });
  renderHomeLeaderboard();
  renderMemberOptions();
  loadMembers().catch(error => notify(error.message)).finally(loadLeaderboard);
}
function connect() {
  clearTimeout(retryTimer); clearTimeout(replyTimer); clearTimeout(resumeTimer);
  if (!code) return;
  if (socket) { socket.onclose = null; socket.close(); }
  connected = false; pending = false;
  clearStateQueue();
  if (room) render();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${code}/socket`);
  socket = ws;
  ws.onmessage = event => {
    if (socket !== ws) return;
    clearTimeout(resumeTimer);
    if (event.data === 'pong') return;
    const data = JSON.parse(event.data);
    if (data.type === 'state') {
      const savedLedger = ledgerSavePending && data.room.ledger.some(entry =>
        (ledgerSavePending.recordId ? entry.id === ledgerSavePending.recordId : !ledgerSavePending.previousIds.includes(entry.id)) &&
        entry.date === ledgerSavePending.date && entry.players.length === ledgerSavePending.players.length &&
        ledgerSavePending.players.every(player => entry.players.some(saved => saved.id === player.id && saved.rebuys === player.rebuys && saved.finalChips === player.finalChips)));
      if (savedLedger) { ledgerSavePending = null; ledgerDraft = null; ledgerEditing = null; ledgerFormOpen = false; }
      else if (!connected) ledgerSavePending = null;
      latestRoom = data.room; pending = false; connected = true; reconnectAttempt = 0;
      clearTimeout(replyTimer);
      saveLocal('river-rooms', JSON.stringify([{ id: latestRoom.id, name: latestRoom.name }, ...recentRooms().filter(r => r.id !== latestRoom.id)].slice(0, 5)));
      stateQueue.push({ next: data.room, preserve: !savedLedger });
      showNextState();
    } else if (data.type === 'error') { pending = false; ledgerSavePending = null; clearTimeout(replyTimer); notify(data.error); }
    else if (data.type === 'left') {
      clearTimeout(replyTimer); clearTimeout(resumeTimer); clearTimeout(retryTimer);
      ws.onclose = null; ws.close(); socket = null; room = null; code = ''; connected = false; pending = false;
      clearStateQueue(); latestRoom = null;
      ledgerDraft = null; ledgerSavePending = null; ledgerEditing = null; ledgerFormOpen = false;
      history.replaceState({}, '', '/'); home();
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false; pending = false;
    clearTimeout(replyTimer); clearTimeout(resumeTimer);
    if (room) render(); else { notify('연결이 끊겼습니다. 다시 연결하는 중입니다.'); home(); }
    if (navigator.onLine) retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** reconnectAttempt++));
  };
}
function clearStateQueue() { stateQueue = []; clearTimeout(queueTimer); queueTimer = null; }
function pacing(prev, next) {
  if (!prev || reducedMotion.matches || prev.id !== next.id || prev.hand !== next.hand) return 0;
  const revealed = next.board.length - prev.board.length;
  if (next.stage === 'finished' && prev.stage !== 'finished') return 2000 + Math.max(0, revealed) * 600;
  if (revealed > 0) return 400 + revealed * 600;
  return next.players.some(p => p.lastAction && p.lastAction !== prev.players.find(q => q.id === p.id)?.lastAction) ? 700 : 0;
}
function showNextState() {
  if (queueTimer || !stateQueue.length) return;
  const { next, preserve } = stateQueue.shift();
  const delay = pacing(room, next);
  animFrom = delay ? room : null;
  room = next;
  render(preserve);
  animFrom = null;
  if (delay) queueTimer = setTimeout(() => { queueTimer = null; showNextState(); }, delay);
  else showNextState();
}
function confirmAction(action, amount) {
  const legal = room.legal, chips = room.players.find(p => p.id === room.me)?.chips ?? 0;
  if (action === 'fold' && legal?.canCheck) return confirm('지금은 칩을 내지 않고 체크할 수 있어요. 그래도 폴드할까요?');
  const allIn = action === 'call' ? legal?.toCall >= chips : action === 'raise' && amount >= legal?.max;
  return !allIn || confirm(`남은 칩 ${format(chips)}개를 모두 걸어 올인할까요?`);
}
function checkConnection() {
  if (!code || !room || document.hidden || !navigator.onLine) return;
  if (!connected || socket?.readyState !== WebSocket.OPEN) { connect(); return; }
  socket.send('ping');
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(connect, 6000);
}
function send(type, data = {}) {
  if (!connected || pending || socket?.readyState !== WebSocket.OPEN) return;
  pending = true; socket.send(JSON.stringify({ type, revision: (latestRoom || room).revision, ...data }));
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => { notify('응답이 늦어 다시 연결합니다. 행동 결과를 확인해 주세요.'); connect(); }, 8000);
  document.querySelectorAll('[data-send], [data-action], #raise-button, [data-ledger-save]').forEach(el => { el.disabled = true; });
}
function seat(player, index) {
  if (!player) return `<div class="seat seat-${index} empty-seat"><span class="empty-avatar">+</span><span>친구의 자리</span></div>`;
  const me = player.id === room.me;
  const acted = animFrom && player.lastAction && player.lastAction !== animFrom.players.find(p => p.id === player.id)?.lastAction;
  const won = room.stage === 'finished' && room.result.some(r => r.id === player.id);
  return `<div class="seat seat-${index} ${me ? 'my-seat' : ''} ${room.turn === room.players.indexOf(player) ? 'active-seat' : ''} ${player.folded && player.active ? 'folded' : ''} ${acted ? 'acted' : ''} ${won ? 'winner' : ''} ${won && animFrom ? 'just-won' : ''}">
    <div class="seat-cards">${player.cards.map(c => card(c)).join('')}</div>
    <div class="player-info"><span class="avatar">${escape([...player.name][0])}</span><div><b>${escape(player.name)}${me ? ' <small>나</small>' : ''}</b><span class="chips">${format(player.chips)}</span></div><span class="presence ${player.online ? 'online' : ''}" aria-label="${player.online ? '접속 중' : '연결 끊김'}"></span></div>
    <div class="player-state">${room.players.indexOf(player) === room.dealer ? '<span class="dealer-badge">D</span>' : ''}${['waiting', 'finished'].includes(room.stage) ? (player.ready ? '준비 완료 ✓' : '대기 중') : escape(player.lastAction || (player.bet ? `베팅 ${format(player.bet)}` : ''))}</div>
  </div>`;
}
function readRoomLedgerDraft() {
  const form = $('[data-ledger-form]');
  if (!form) return ledgerDraft;
  return { date: form.querySelector('[data-ledger-date]').value, players: [...form.querySelectorAll('[data-ledger-row]')].map(row => ({
    id: row.dataset.ledgerRow, selected: row.querySelector('[data-ledger-player]')?.checked ?? true,
    rebuys: row.querySelector('[data-rebuys]').value, finalChips: row.querySelector('[data-final]').value,
  })) };
}
function render(preserveLedgerDraft = true) {
  if (preserveLedgerDraft) ledgerDraft = readRoomLedgerDraft();
  const focused = app.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.id ? `#${focused.id}` : focused?.dataset.panel ? `[data-panel="${focused.dataset.panel}"]` : focused?.dataset.send ? `[data-send="${focused.dataset.send}"]` : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]` : null;
  const turnKey = `${room.hand}:${room.stage}:${room.turn}:${room.bet}`;
  const previousAmount = renderedTurn === turnKey ? $('#raise-amount')?.value : null;
  renderedTurn = turnKey;
  app.className = 'game';
  document.body.classList.add('in-game');
  const me = room.players.find(p => p.id === room.me);
  const idle = ['waiting', 'finished'].includes(room.stage);
  const host = room.hostId === room.me;
  const legal = room.legal;
  // Rotate seats so this player is always at the bottom of the table.
  const ownIndex = room.players.findIndex(p => p.id === room.me);
  const ordered = ownIndex >= 0 ? [...room.players.slice(ownIndex), ...room.players.slice(0, ownIndex)] : room.players;
  const disabled = connected && !pending ? '' : 'disabled';
  app.innerHTML = `<section class="table-heading"><div><div class="eyebrow"><span class="connection ${connected ? '' : 'disconnected'}">${connected ? '실시간 연결됨' : '다시 연결하는 중…'}</span></div><h1>${escape(room.name)}</h1></div><div class="table-tools"><button class="outline" id="invite-button" aria-haspopup="dialog">친구 초대 <span>↗</span></button><button class="quiet" data-send="leave" ${!idle ? 'disabled' : disabled} title="핸드가 끝난 뒤 나갈 수 있어요">나가기</button></div></section>
    <div class="game-layout"><section class="play-area"><div class="table-meta"><span>블라인드 <b>${room.smallBlind} / ${room.bigBlind}</b></span><span>핸드 <b>${String(room.hand).padStart(2, '0')}</b></span></div>
      <div class="poker-surface"><div class="felt"><div class="felt-border"></div><span class="felt-wordmark">RIVER</span></div>
        <div class="board-area"><div class="round-label">${stages[room.stage]}</div>${idle && room.stage === 'waiting' ? '<div class="waiting-title">자리가 준비됐어요.</div><p class="waiting-description">초대 링크를 보내고<br>친구와 함께 준비를 눌러주세요.</p>' : `<div class="pot-label">TOTAL POT <strong>${format(room.pot)}</strong></div><div class="board-cards">${Array.from({ length: 5 }, (_, i) => card(room.board[i], animFrom && i >= animFrom.board.length ? `reveal reveal-${i - animFrom.board.length}` : '')).join('')}</div>`}</div>
        ${ordered.map((player, i) => seat(player, i)).join('')}
      </div>
      <section class="action-panel" aria-label="게임 행동">${idle ? `<div class="turn-info"><span class="turn-dot"></span><div><b>${room.stage === 'finished' ? room.result.map(r => `${escape(r.name)} +${format(r.amount)}`).join(' / ') : '친구가 모이면 시작해요'}</b><span>${room.stage === 'finished' ? room.result.map(r => escape(r.handName)).join(' / ') + ' — 다음 핸드를 위해 준비를 눌러주세요.' : `${room.players.filter(p => p.ready).length}명 준비 완료 / 최소 2명 필요`}</span></div></div><div class="lobby-actions">${me?.chips === 0 ? `<button class="primary" data-send="rebuy" ${disabled}>가상 칩 30,000 충전</button>` : `<button class="${me?.ready ? 'outline' : 'primary'}" data-send="ready" ${disabled}>${me?.ready ? '준비 취소' : '준비하기'}</button>`}${host ? `<button class="primary gold" data-send="start" ${room.players.filter(p => p.ready && p.online).length < 2 ? 'disabled' : disabled}>${room.hand ? '다음 핸드' : '첫 핸드 시작'} →</button>` : !room.players.find(p => p.id === room.hostId)?.online ? `<button class="outline" data-send="claimHost" ${disabled}>방장 맡기</button>` : '<span class="waiting-host">방장이 핸드를 시작해요</span>'}</div>` : `<div class="turn-info"><span class="turn-dot ${legal ? 'your-turn' : ''}"></span><div><b>${legal ? '내 차례예요.' : `${escape(room.players[room.turn]?.name || '')} 님의 차례`}</b><span>${legal ? '어떤 플레이를 할까요?' : '다음 수를 생각해 보세요.'}</span></div><span class="timer" id="countdown"></span></div><div class="betting-actions"><button class="fold-button" data-action="fold" ${legal ? disabled : 'disabled'}>폴드</button><button class="primary" data-action="${legal?.canCheck ? 'check' : 'call'}" ${legal ? disabled : 'disabled'}>${!legal ? '콜' : legal.canCheck ? '체크' : `콜 ${format(legal.toCall)}`}</button><div class="raise-control"><label for="raise-amount">총 베팅액</label><input id="raise-amount" type="number" inputmode="numeric" required min="${legal?.min || 0}" max="${legal?.max || 0}" step="1" value="${legal?.min || 0}" ${legal?.canRaise ? disabled : 'disabled'}></div><button class="primary gold" id="raise-button" ${legal?.canRaise ? disabled : 'disabled'}>레이즈 ↑</button></div>${legal?.canRaise ? `<div class="quick-bets"><span>빠른 선택</span><button data-bet="${legal.min}">최소 ${format(legal.min)}</button><button data-bet="${Math.min(legal.max, Math.max(legal.min, Math.round(room.pot / 2) + room.bet))}">½ 팟</button><button data-bet="${legal.max}">올인 ${format(legal.max)}</button></div>` : ''}`}</section>
      <p class="table-footnote">30,000 가상 칩으로 시작 / 블라인드 150 / 300 / 행동 시간 45초 / 결제 및 환전 없음</p>
    </section><aside class="sidebar"><div class="side-tabs" role="tablist" aria-label="테이블 정보"><button role="tab" id="tab-ranking" aria-controls="side-content" tabindex="${panel === 'ranking' ? 0 : -1}" aria-selected="${panel === 'ranking'}" data-panel="ranking">리더보드</button><button role="tab" id="tab-history" aria-controls="side-content" tabindex="${panel === 'history' ? 0 : -1}" aria-selected="${panel === 'history'}" data-panel="history">핸드 기록</button><button role="tab" id="tab-ledger" aria-controls="side-content" tabindex="${panel === 'ledger' ? 0 : -1}" aria-selected="${panel === 'ledger'}" data-panel="ledger">주간 기록</button><button role="tab" id="tab-log" aria-controls="side-content" tabindex="${panel === 'log' ? 0 : -1}" aria-selected="${panel === 'log'}" data-panel="log">진행 로그</button></div><div id="side-content" role="tabpanel" tabindex="0" aria-labelledby="tab-${panel}">${sideContent()}</div></aside></div>`;
  const ledgerForm = $('[data-ledger-form]');
  if (ledgerDraft && ledgerForm) {
    ledgerForm.querySelector('[data-ledger-date]').value = ledgerDraft.date;
    ledgerForm.querySelectorAll('[data-ledger-row]').forEach(row => {
      const saved = ledgerDraft.players.find(player => player.id === row.dataset.ledgerRow);
      const checkbox = row.querySelector('[data-ledger-player]');
      if (checkbox) checkbox.checked = saved?.selected ?? false;
      if (saved) { row.querySelector('[data-rebuys]').value = saved.rebuys; row.querySelector('[data-final]').value = saved.finalChips; }
    });
  }
  $('#invite-button').onclick = () => {
    $('#invite-link').value = `${location.origin}/?room=${room.id}`;
    $('#invite-feedback').textContent = '';
    $('#share-invite').hidden = !navigator.share;
    $('#invite').showModal();
  };
  document.querySelectorAll('[data-send]').forEach(button => { button.onclick = () => send(button.dataset.send); });
  document.querySelectorAll('[data-action]').forEach(button => { button.onclick = () => { if (confirmAction(button.dataset.action)) send('action', { action: button.dataset.action }); }; });
  document.querySelectorAll('[data-panel]').forEach(button => {
    button.onclick = () => { panel = button.dataset.panel; ledgerEditing = null; ledgerFormOpen = false; ledgerDraft = null; render(false); };
    button.onkeydown = event => {
      const keys = ['ranking', 'history', 'ledger', 'log'];
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = keys.indexOf(panel);
      panel = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      render(); $(`#tab-${panel}`).focus({ preventScroll: true });
    };
  });
  $('#ledger-new')?.addEventListener('click', () => { ledgerFormOpen = !ledgerFormOpen; ledgerEditing = null; ledgerDraft = null; render(false); });
  document.querySelectorAll('[data-ledger-edit]').forEach(button => { button.onclick = () => { ledgerEditing = button.dataset.ledgerEdit; ledgerFormOpen = false; ledgerDraft = null; render(false); }; });
  document.querySelectorAll('[data-ledger-cancel]').forEach(button => { button.onclick = () => { ledgerEditing = null; ledgerFormOpen = false; ledgerDraft = null; render(false); }; });
  document.querySelectorAll('[data-ledger-save]').forEach(button => {
    button.onclick = () => {
      if (ledgerSavePending) return;
      const form = button.closest('[data-ledger-form]');
      if (![...form.querySelectorAll('input')].every(input => input.reportValidity())) return;
      const players = [...form.querySelectorAll('[data-ledger-row]')].filter(row => !row.querySelector('[data-ledger-player]') || row.querySelector('[data-ledger-player]').checked).map(row => ({ id: row.dataset.ledgerRow, rebuys: Number(row.querySelector('[data-rebuys]').value), finalChips: Number(row.querySelector('[data-final]').value) }));
      const data = { recordId: button.dataset.ledgerSave || undefined, date: form.querySelector('[data-ledger-date]').value, players };
      ledgerDraft = readRoomLedgerDraft();
      ledgerSavePending = { ...data, previousIds: room.ledger.map(entry => entry.id) };
      send('ledgerSave', data);
    };
  });
  document.querySelectorAll('[data-ledger-delete]').forEach(button => { button.onclick = () => { if (confirm('이 세션 기록을 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) send('ledgerDelete', { recordId: button.dataset.ledgerDelete }); }; });
  $('#ledger-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, room: room.name, exportedAt: new Date().toISOString(), sessions: room.ledger }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `river-chip-ledger-${room.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  document.querySelectorAll('[data-bet]').forEach(button => { button.onclick = () => { $('#raise-amount').value = button.dataset.bet; }; });
  if ($('#raise-button')) $('#raise-button').onclick = () => { if ($('#raise-amount').reportValidity() && confirmAction('raise', Number($('#raise-amount').value))) send('action', { action: 'raise', amount: Number($('#raise-amount').value) }); };
  if (previousAmount !== null && legal?.canRaise) $('#raise-amount').value = previousAmount;
  if (focusKey) $(focusKey)?.focus({ preventScroll: true });
  const announcement = !connected ? '서버에 다시 연결하는 중입니다.' : legal ? '내 차례입니다.' : idle ? stages[room.stage] : `${room.players[room.turn]?.name || ''} 님의 차례입니다.`;
  if ($('#turn-announcement').textContent !== announcement) $('#turn-announcement').textContent = announcement;
  countdown();
}
function sideContent() {
  if (panel === 'log') return `<div class="section-caption">지금까지의 플레이</div><ol class="game-log">${room.log.map(item => `<li>${escape(item)}</li>`).join('')}</ol>`;
  if (panel === 'history') return `<div class="section-caption">최근 30개 핸드</div>${room.history.length ? room.history.map(h => `<article class="history-entry"><div><b>HAND #${h.hand}</b><time>${new Date(h.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div><div class="mini-board">${h.board.map(c => card(c)).join('')}</div>${h.result.map(r => `<p>${escape(r.name)} <strong>+${format(r.amount)}</strong><small>${escape(r.handName)}</small></p>`).join('')}</article>`).join('') : '<div class="empty-state"><span>↺</span><b>첫 핸드를 기다리고 있어요</b><p>완료된 핸드의 결과가 여기에 남아요.</p></div>'}`;
  if (panel === 'ledger') return ledgerContent();
  return `<div class="section-caption"><span>이 테이블의 누적 순이익</span><span>가상 칩</span></div><ol class="leaderboard">${room.ranking.map((p, i) => `<li><span class="rank-no">${String(i + 1).padStart(2, '0')}</span><span class="rank-name"><b>${escape(p.name)}${p.id === room.me ? ' <small>나</small>' : ''}</b><small>${p.hands}핸드 / ${p.wins}승</small></span><strong class="${p.net < 0 ? 'negative' : ''}">${p.net > 0 ? '+' : ''}${format(p.net)}</strong></li>`).join('')}</ol><p class="ranking-note">정산된 칩 순이익 순으로 정렬해요. 충전한 칩은 순이익에 포함하지 않으며, 팟을 나눠 가져도 승수에 포함합니다.</p>${!room.ranking.some(p => p.hands) ? '<div class="empty-state"><span>♠</span><b>첫 승의 주인공은 누구일까요?</b><p>첫 핸드가 끝나면 전적이 기록돼요.</p></div>' : ''}`;
}
function ledgerContent() {
  const host = room.hostId === room.me;
  const idle = ['waiting', 'finished'].includes(room.stage);
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fields = (players, selectable = false) => players.map(p => `<div class="ledger-player" data-ledger-row="${escape(p.id)}"><label>${selectable ? `<input type="checkbox" data-ledger-player="${escape(p.id)}" checked>` : ''}<b>${escape(p.name)}</b></label><label>리바인<input type="number" min="0" max="100" step="1" value="${selectable ? 0 : p.rebuys}" data-rebuys required></label><label>종료 칩<input type="number" min="0" max="100000000" step="1" value="${selectable ? 30000 : p.finalChips}" data-final required></label></div>`).join('');
  const form = (players, recordId = '') => `<div class="ledger-form" data-ledger-form><label>게임 날짜<input type="date" data-ledger-date value="${recordId ? escape(room.ledger.find(e => e.id === recordId).date) : today}" required></label>${fields(players, !recordId)}<div class="ledger-actions"><button class="primary" data-ledger-save="${escape(recordId)}" ${!host || !idle || !connected || pending ? 'disabled' : ''}>기록 저장</button><button class="outline" data-ledger-cancel>취소</button></div></div>`;
  const net = p => p.finalChips - 30000 * (p.rebuys + 1);
  return `<div class="ledger-tools"><button id="ledger-new" class="primary" ${!host || !idle || !connected || pending ? 'disabled' : ''}>새 게임 기록</button><button id="ledger-export" class="outline" ${room.ledger.length ? '' : 'disabled'}>백업 다운로드</button></div><p class="ranking-note">참가자마다 30,000칩으로 시작하며 리바인 1회도 30,000칩으로 계산합니다. 게임이 끝난 뒤 각자의 리바인 횟수와 종료 칩을 입력하세요. 새 기록과 수정·삭제는 접속 중인 방장만 할 수 있습니다.</p>${ledgerFormOpen && host ? form(room.players) : ''}<div class="section-caption"><span>주간 우승 / 누적 순이익</span><span>누적 종료 칩</span></div><ol class="leaderboard">${room.ledgerRanking.map((p, i) => `<li><span class="rank-no">${String(i + 1).padStart(2, '0')}</span><span class="rank-name"><b>${escape(p.name)}${p.id === room.me ? ' <small>나</small>' : ''}</b><small>이번 주 ${p.weeklyWins}회 우승 / 순이익 ${p.net > 0 ? '+' : ''}${format(p.net)}</small></span><strong>${format(p.finalChips)}</strong></li>`).join('')}</ol>${room.ledger.length ? [...room.ledger].sort((a, b) => b.at - a.at).map(entry => `<article class="ledger-entry"><header><b>${escape(entry.date)} 세션</b><span>${entry.players.length}명</span></header>${entry.players.map(p => `<p>${escape(p.name)} <span>리바인 ${p.rebuys}회 / 종료 ${format(p.finalChips)}칩 / 순이익 <strong class="${net(p) < 0 ? 'negative' : ''}">${net(p) > 0 ? '+' : ''}${format(net(p))}</strong></span></p>`).join('')}${ledgerEditing === entry.id ? form(entry.players, entry.id) : `<div class="ledger-actions"><button class="outline" data-ledger-edit="${escape(entry.id)}" ${!host || !idle ? 'disabled' : ''}>수정</button><button class="quiet" data-ledger-delete="${escape(entry.id)}" ${!host || !idle || !connected || pending ? 'disabled' : ''}>삭제</button></div>`}</article>`).join('') : '<div class="empty-state"><span>♧</span><b>아직 게임 기록이 없어요</b><p>게임이 끝나면 방장이 새 기록을 추가할 수 있어요.</p></div>'}<p class="ranking-note">백업 파일에는 이 테이블의 세션 날짜, 닉네임, 리바인 횟수와 종료 칩이 담깁니다.</p>`;
}
function countdown() { const el = $('#countdown'); if (el && room?.deadline) el.textContent = `${Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000))}초`; }
setInterval(countdown, 1000);
setInterval(checkConnection, 25000);
document.addEventListener('visibilitychange', checkConnection);
window.addEventListener('online', checkConnection);
window.addEventListener('offline', () => { if (room) { connected = false; pending = false; render(); } });
$('#close-invite').onclick = () => $('#invite').close();
$('#copy-invite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#invite-link').value);
    $('#invite-feedback').textContent = '링크를 복사했어요. 친구에게 보내주세요.';
  } catch {
    $('#invite-link').focus(); $('#invite-link').select();
    $('#invite-feedback').textContent = '자동 복사를 사용할 수 없어요. 선택된 링크를 길게 누르거나 복사 단축키로 복사해 주세요.';
  }
};
$('#share-invite').onclick = async () => {
  try { await navigator.share({ title: `${room.name} | RIVER`, text: '가상 칩으로 함께하는 친구들의 홀덤', url: $('#invite-link').value }); }
  catch (error) { if (error.name !== 'AbortError') $('#invite-feedback').textContent = '공유 메뉴를 열지 못했어요. 링크 복사를 이용해 주세요.'; }
};
$('#invite').addEventListener('close', () => $('#invite-button')?.focus({ preventScroll: true }));
$('#close-member-management').onclick = () => $('#member-management').close();
$('#member-management').addEventListener('close', () => { memberDeleteTarget = null; renderMemberManager(); $('#manage-members')?.focus({ preventScroll: true }); });
$('#member-management-list').addEventListener('click', event => {
  const button = event.target.closest('[data-member-delete]');
  if (!button || memberDeleting) return;
  memberDeleteTarget = members.find(item => item.key === button.dataset.memberDelete);
  if (!memberDeleteTarget) return;
  renderMemberManager(); $('#cancel-member-delete').focus();
});
$('#cancel-member-delete').onclick = () => { memberDeleteTarget = null; renderMemberManager(); $('#close-member-management').focus(); };
$('#confirm-member-delete').onclick = async () => {
  const member = memberDeleteTarget;
  if (!member || memberDeleting) return;
  if (manualSaving) { $('#member-management-error').textContent = '기록 저장이 끝난 뒤 다시 시도해 주세요.'; return; }
  memberDeleting = true;
  $('#member-management-error').textContent = '';
  renderMemberManager();
  try {
    await api('/api/session');
    const result = await api('/api/members', { memberKey: member.key }, 'DELETE');
    manualDraft = readManualDraft();
    setMembers(result);
    if (selectedMemberKey === member.key) {
      selectedMemberKey = members[0]?.key || ''; nickname = members[0]?.name || '';
      saveLocal('river-member-key', selectedMemberKey); saveLocal('river-nickname', nickname);
    }
    renderMemberOptions();
    await loadLeaderboard();
    memberDeleteTarget = null;
    notify(`${memberLabel(member)} 멤버를 삭제했어요. 기존 게임 기록은 유지됩니다.`);
  } catch (error) { $('#member-management-error').textContent = error.message; }
  finally { memberDeleting = false; renderMemberManager(); $('#close-member-management').focus(); }
};
home();
if (code && nickname && recentRooms().some(r => r.id === code)) {
  (async () => { try { await api('/api/session'); await api(`/api/rooms/${code}/join`, { nickname }); connect(); } catch (error) { notify(error.message); } })();
}
