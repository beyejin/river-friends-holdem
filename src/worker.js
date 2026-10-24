import { DurableObject } from 'cloudflare:workers';
import { createRoom, addPlayer, startHand, act, publicRoom, legalActions, weekKey, STARTING_CHIPS, migrateChipUnit } from './poker.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const cleanName = (value, fallback) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20) || fallback : fallback;
const defaultMembers = ['한예진', '김영광', '남성수', '박진환', '배정호', '엄태웅', '주정원'].map(name => ({ key: `default:${name}`, name, cohort: '' }));
const memberForPlayer = (player, members) => player.memberKey
  ? members.find(member => member.key === player.memberKey)
  : members.find(member => member.name === player.name);
const memberLists = (members, deleted) => ({ members: members.filter(member => !deleted.has(member.key)), recordMembers: members });
const emptyScore = member => ({ key: member.key, name: member.name, cohort: member.cohort || '', weeklyWins: 0, wins: 0, rebuys: 0, net: 0, netRecords: 0, finalChips: 0 });
async function identity(request) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)river_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  if (!token) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function body(request) {
  const text = await request.text();
  if (text.length > 32768) throw new Error('요청이 너무 큽니다.');
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    if (request.method !== 'GET' && request.headers.get('Content-Type') !== 'application/json') return json({ error: 'JSON 요청이 필요합니다.' }, 415);
    try {
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const existing = await identity(request);
        if (existing) return json({ ok: true });
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return json({ ok: true }, 200, { 'Set-Cookie': `river_session=${crypto.randomUUID()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}` });
      }
      if (url.pathname === '/api/members' && request.method === 'GET') {
        return env.ROOMS.getByName('river-members').fetch(new Request('https://room/members'));
      }
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
        return env.ROOMS.getByName('river-members').fetch(new Request('https://room/leaderboard'));
      }
      const id = await identity(request);
      if (!id) return json({ error: '새로고침 후 다시 연결해 주세요.' }, 401);
      if (url.pathname === '/api/leaderboard/session' && request.method === 'POST') {
        const data = await body(request);
        return env.ROOMS.getByName('river-members').fetch(new Request('https://room/leaderboard-session', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-player-id': id }, body: JSON.stringify(data),
        }));
      }
      if (url.pathname === '/api/members' && ['POST', 'DELETE'].includes(request.method)) {
        const data = await body(request);
        return env.ROOMS.getByName('river-members').fetch(new Request('https://room/members', {
          method: request.method, headers: { 'x-player-id': id }, body: JSON.stringify(data),
        }));
      }
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const data = await body(request);
        const code = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        return env.ROOMS.getByName(code).fetch(new Request(`https://room/init`, {
          method: 'POST', headers: { 'x-player-id': id },
          body: JSON.stringify({ id: code, name: cleanName(data.roomName, '친구들의 테이블'), nickname: cleanName(data.nickname, '플레이어'), memberKey: data.memberKey }),
        }));
      }
      const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{16})\/(join|socket|sync-ledger)$/);
      if (!match) return json({ error: '없는 경로입니다.' }, 404);
      if (match[2] === 'socket' && (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')) return json({ error: 'WebSocket 연결이 필요합니다.' }, 426);
      if (match[2] === 'join' && request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
      if (match[2] === 'sync-ledger' && request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
      const headers = new Headers(request.headers);
      headers.set('x-player-id', id);
      return env.ROOMS.getByName(match[1]).fetch(new Request(`https://room/${match[2]}`, { method: request.method, headers, body: request.method === 'POST' ? JSON.stringify(await body(request)) : undefined }));
    } catch {
      return json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 400);
    }
  },
};

export class PokerRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get('room');
      if (this.room && migrateChipUnit(this.room)) await ctx.storage.put('room', this.room);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  online() { return [...new Set(this.ctx.getWebSockets().map(ws => ws.deserializeAttachment().id))]; }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: 'state', room: publicRoom(this.room, ws.deserializeAttachment().id, this.online()) })); } catch { /* Closed connections are removed by the runtime. */ }
    }
  }
  async save() {
    this.room.revision++;
    await this.ctx.storage.put('room', this.room);
    if (this.room.deadline) await this.ctx.storage.setAlarm(this.room.deadline);
    else await this.ctx.storage.deleteAlarm();
  }
  async syncLeaderboard() {
    await this.env.ROOMS.getByName('river-members').fetch(new Request('https://room/leaderboard-sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: this.room.id, sessions: this.room.ledger }),
    }));
  }
  async selectedMember(memberKey) {
    if (!memberKey) return null;
    const response = await this.env.ROOMS.getByName('river-members').fetch(new Request('https://room/members'));
    if (!response.ok) throw new Error('회원 정보를 불러오지 못했습니다. 다시 시도해 주세요.');
    const { members } = await response.json();
    const member = members.find(entry => entry.key === memberKey);
    if (!member) throw new Error('등록된 회원을 선택해 주세요.');
    return member;
  }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      const id = request.headers.get('x-player-id');
      try {
        if (path === '/members') {
          const registered = await this.ctx.storage.get('registered-members') || [];
          const members = [...defaultMembers, ...registered];
          const deleted = new Set(await this.ctx.storage.get('deleted-member-keys') || []);
          if (request.method === 'GET') return json(memberLists(members, deleted));
          if (request.method === 'DELETE' && id) {
            const { memberKey } = await request.json();
            if (typeof memberKey !== 'string' || memberKey.length > 80 || memberKey.trim() !== memberKey || /[\u0000-\u001f\u007f]/.test(memberKey) || !/^(?:default:.+|member:.+:.+)$/.test(memberKey)) return json({ error: '삭제할 회원을 확인해 주세요.' }, 400);
            if (!members.some(member => member.key === memberKey)) return json({ error: '회원을 찾을 수 없습니다.' }, 404);
            if (!deleted.has(memberKey)) {
              deleted.add(memberKey);
              await this.ctx.storage.put('deleted-member-keys', [...deleted]);
            }
            return json({ ok: true, ...memberLists(members, deleted) });
          }
          if (request.method !== 'POST' || !id) return json({ error: '가입 정보를 확인해 주세요.' }, 400);
          const data = await request.json();
          const cohort = cleanName(data.cohort, '');
          const name = cleanName(data.name, '');
          if (!cohort || !name) return json({ error: '기수와 이름을 모두 입력해 주세요.' }, 400);
          const existing = registered.find(member => member.cohort === cohort && member.name === name);
          if (existing) {
            if (!deleted.has(existing.key)) return json({ error: '이미 등록된 회원입니다.' }, 409);
            deleted.delete(existing.key);
            await this.ctx.storage.put('deleted-member-keys', [...deleted]);
            return json({ member: existing, ...memberLists(members, deleted) }, 201);
          }
          if (registered.length >= 500) return json({ error: '등록 가능한 회원 수를 초과했습니다.' }, 400);
          const member = { key: `member:${cohort}:${name}`, cohort, name };
          registered.push(member);
          await this.ctx.storage.put('registered-members', registered);
          return json({ member, ...memberLists([...defaultMembers, ...registered], deleted) }, 201);
        }
        if (path === '/leaderboard') {
          const registered = await this.ctx.storage.get('registered-members') || [];
          const rooms = await this.ctx.storage.get('leaderboard-rooms') || {};
          const manualSessions = await this.ctx.storage.get('leaderboard-sessions') || [];
          const members = [...defaultMembers, ...registered];
          const deleted = new Set(await this.ctx.storage.get('deleted-member-keys') || []);
          const scores = new Map(members.filter(member => !deleted.has(member.key)).map(member => [member.key, emptyScore(member)]));
          const currentWeek = weekKey(Date.now());
          for (const sessions of [...Object.values(rooms), manualSessions]) for (const session of sessions) {
            const results = session.players.map(player => ({ player, net: Number.isSafeInteger(player.finalChips) ? player.finalChips - STARTING_CHIPS * (1 + player.rebuys) : 0 }));
            const best = Math.max(...results.map(result => result.net));
            for (const { player, net } of results) {
              const member = memberForPlayer(player, members) || { key: player.memberKey || `legacy:${player.name}`, name: player.name, cohort: player.cohort };
              const score = scores.get(member.key) || emptyScore(member);
              if (deleted.has(member.key)) score.deleted = true;
              const wins = Number.isSafeInteger(player.wins) ? player.wins : (net === best ? 1 : 0);
              if (Number.isSafeInteger(player.finalChips)) { score.net += net; score.netRecords++; score.finalChips += player.finalChips; }
              score.rebuys += player.rebuys;
              score.wins += wins;
              if (session.week === currentWeek) score.weeklyWins += wins;
              scores.set(member.key, score);
            }
          }
          return json({ ranking: [...scores.values()].sort((a, b) => b.weeklyWins - a.weeklyWins || b.wins - a.wins || b.net - a.net || b.finalChips - a.finalChips), sessions: manualSessions });
        }
        if (path === '/leaderboard-session' && request.method === 'POST') {
          const data = await request.json();
          if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return json({ error: '게임 날짜를 확인해 주세요.' }, 400);
          const at = Date.parse(`${data.date}T12:00:00+09:00`);
          if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== data.date) return json({ error: '게임 날짜를 확인해 주세요.' }, 400);
          if (!Array.isArray(data.players) || data.players.length < 2 || data.players.length > 9) return json({ error: '참가자는 2~9명이어야 합니다.' }, 400);
          if (data.sessionId != null && (typeof data.sessionId !== 'string' || !data.sessionId)) return json({ error: '수정할 게임 기록을 확인해 주세요.' }, 400);
          const sessions = await this.ctx.storage.get('leaderboard-sessions') || [];
          const existingIndex = data.sessionId ? sessions.findIndex(session => session.id === data.sessionId) : -1;
          if (data.sessionId && existingIndex < 0) return json({ error: '수정할 게임 기록을 찾을 수 없습니다.' }, 404);
          const existing = sessions[existingIndex];
          const registered = await this.ctx.storage.get('registered-members') || [];
          const members = [...defaultMembers, ...registered];
          const deleted = new Set(await this.ctx.storage.get('deleted-member-keys') || []);
          const seen = new Set();
          const players = data.players.map(player => {
            const member = memberForPlayer({ ...player, name: cleanName(player.name, '') }, members);
            if (!member || seen.has(member.key) || !Number.isSafeInteger(player.rebuys) || player.rebuys < 0 || player.rebuys > 100 || !Number.isSafeInteger(player.wins) || player.wins < 0 || player.wins > 1000) throw new Error('참가자별 리바인과 승리 횟수를 확인해 주세요.');
            const previous = existing?.players.find(entry => memberForPlayer(entry, members)?.key === member.key);
            if (deleted.has(member.key) && !previous) throw new Error('삭제된 회원은 새 참가자로 추가할 수 없습니다.');
            const rebuyEvents = player.rebuyEvents ?? Array.from({ length: player.rebuys }, (_, index) => previous?.rebuyEvents?.[index] ?? null);
            if (!Array.isArray(rebuyEvents) || rebuyEvents.length !== player.rebuys || rebuyEvents.some(at => at !== null && (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())))) throw new Error('리바인 시각 입력을 확인해 주세요.');
            seen.add(member.key);
            return { ...previous, memberKey: member.key, name: member.name, cohort: member.cohort, rebuys: player.rebuys, rebuyEvents, wins: player.wins };
          });
          if (!players.some(player => player.wins > 0)) return json({ error: '승리 횟수를 한 명 이상 입력해 주세요.' }, 400);
          const session = { ...existing, id: data.sessionId || crypto.randomUUID(), date: data.date, at, week: weekKey(at), players };
          if (existingIndex >= 0) sessions[existingIndex] = session;
          else sessions.unshift(session);
          await this.ctx.storage.put('leaderboard-sessions', sessions);
          return json({ ok: true, session }, existingIndex >= 0 ? 200 : 201);
        }
        if (path === '/leaderboard-sync' && request.method === 'POST') {
          const { roomId, sessions } = await request.json();
          if (!/^[a-f0-9]{16}$/.test(roomId) || !Array.isArray(sessions)) return json({ error: '랭킹 정보를 확인해 주세요.' }, 400);
          const rooms = await this.ctx.storage.get('leaderboard-rooms') || {};
          rooms[roomId] = sessions;
          await this.ctx.storage.put('leaderboard-rooms', rooms);
          return json({ ok: true });
        }
        if (path === '/init') {
          if (this.room) return json({ error: '이미 존재하는 방입니다.' }, 409);
          const data = await request.json();
          const member = await this.selectedMember(data.memberKey);
          this.room = createRoom(data.id, id, data.name);
          addPlayer(this.room, id, member?.name || data.nickname);
          if (member) Object.assign(this.room.records[id], { memberKey: member.key, cohort: member.cohort });
          await this.save();
          return json({ code: data.id }, 201);
        }
        if (!this.room) return json({ error: '방을 찾을 수 없습니다. 초대 링크를 확인해 주세요.' }, 404);
        if (path === '/sync-ledger') {
          if (!this.room.players.some(player => player.id === id)) return json({ error: '먼저 테이블에 입장해 주세요.' }, 403);
          await this.syncLeaderboard();
          return json({ ok: true });
        }
        if (path === '/join') {
          const data = await request.json();
          const member = await this.selectedMember(data.memberKey);
          const previous = this.room.records[id];
          if (previous && member && (previous.memberKey ? previous.memberKey !== member.key : previous.name !== member.name)) throw new Error('이 테이블에 처음 참여한 회원으로 다시 입장해 주세요.');
          addPlayer(this.room, id, previous?.name || member?.name || cleanName(data.nickname, '플레이어'));
          if (member && !previous?.memberKey) Object.assign(this.room.records[id], { memberKey: member.key, cohort: member.cohort });
          await this.save(); this.broadcast();
          return json({ code: this.room.id });
        }
        if (!this.room.players.some(p => p.id === id)) return json({ error: '먼저 테이블에 입장해 주세요.' }, 403);
        if (this.ctx.getWebSockets().length >= 18) return json({ error: '연결 수가 많습니다. 다른 탭을 닫아 주세요.' }, 429);
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ id, lastMessage: 0 });
        try { await this.syncLeaderboard(); } catch { /* Keep table connections available if the shared ranking is temporarily unavailable. */ }
        this.broadcast();
        return new Response(null, { status: 101, webSocket: client });
      } catch (error) { return json({ error: error.message }, 400); }
    });
  }
  async webSocketMessage(ws, message) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const session = ws.deserializeAttachment();
      const before = structuredClone(this.room);
      try {
        if (typeof message !== 'string' || message.length > 8192) throw new Error('요청이 너무 큽니다.');
        if (Date.now() - session.lastMessage < 150) throw new Error('잠시 후 다시 시도해 주세요.');
        session.lastMessage = Date.now(); ws.serializeAttachment(session);
        const data = JSON.parse(message);
        const player = this.room.players.find(p => p.id === session.id);
        if (!player) throw new Error('방에 다시 입장해 주세요.');
        if (data.revision !== this.room.revision) throw new Error('테이블이 갱신되었습니다. 다시 선택해 주세요.');
        if (this.room.deadline && Date.now() >= this.room.deadline) throw new Error('행동 시간이 지났습니다. 테이블 갱신을 기다려 주세요.');
        const idle = ['waiting', 'finished'].includes(this.room.stage);
        if (data.type === 'ready') {
          if (!idle || player.chips <= 0) throw new Error('다음 핸드 대기 중에 준비할 수 있습니다.');
          player.ready = !player.ready;
        } else if (data.type === 'start') {
          const online = this.online();
          for (const p of this.room.players) if (!online.includes(p.id)) p.ready = false;
          startHand(this.room, session.id);
        } else if (data.type === 'rebuy') {
          if (!idle || player.chips > 0) throw new Error('칩을 모두 사용한 뒤 대기 중에 충전할 수 있습니다.');
          player.chips = STARTING_CHIPS; player.ready = false;
        } else if (data.type === 'leave') {
          if (!idle) throw new Error('현재 핸드가 끝난 뒤 나갈 수 있습니다.');
          const dealerId = this.room.players[this.room.dealer]?.id;
          this.room.players = this.room.players.filter(p => p.id !== session.id);
          this.room.dealer = this.room.players.findIndex(p => p.id === dealerId);
          if (this.room.hostId === session.id) this.room.hostId = this.room.players[0]?.id || null;
        } else if (data.type === 'claimHost') {
          if (!idle || this.online().includes(this.room.hostId)) throw new Error('방장이 접속 중입니다.');
          this.room.hostId = session.id;
        } else if (data.type === 'ledgerSave') {
          if (!idle || session.id !== this.room.hostId) throw new Error('대기 중인 방장만 세션 기록을 저장할 수 있습니다.');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error('세션 날짜를 확인해 주세요.');
          const at = Date.parse(`${data.date}T12:00:00+09:00`);
          if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== data.date) throw new Error('세션 날짜를 확인해 주세요.');
          if (!Array.isArray(data.players) || data.players.length < 2 || data.players.length > 9) throw new Error('참가자는 2~9명이어야 합니다.');
          const existing = data.recordId ? this.room.ledger.find(entry => entry.id === data.recordId) : null;
          if (data.recordId && !existing) throw new Error('수정할 세션 기록을 찾을 수 없습니다.');
          const ids = new Set();
          const players = data.players.map(entry => {
            const record = this.room.records[entry.id];
            if (!record || ids.has(entry.id) || !Number.isSafeInteger(entry.rebuys) || entry.rebuys < 0 || entry.rebuys > 100 || !Number.isSafeInteger(entry.finalChips) || entry.finalChips < 0 || entry.finalChips > 100000000) throw new Error('참가자별 리바인 횟수와 종료 칩을 확인해 주세요.');
            ids.add(entry.id);
            const previous = existing?.players.find(player => player.id === entry.id);
            return { ...previous, id: entry.id, name: record.name, ...(record.memberKey ? { memberKey: record.memberKey, cohort: record.cohort } : {}), rebuys: entry.rebuys, finalChips: entry.finalChips };
          });
          const entry = { ...existing, id: existing?.id || crypto.randomUUID(), date: data.date, at, week: weekKey(at), players };
          if (existing) this.room.ledger[this.room.ledger.indexOf(existing)] = entry;
          else this.room.ledger.unshift(entry);
        } else if (data.type === 'ledgerDelete') {
          if (!idle || session.id !== this.room.hostId) throw new Error('대기 중인 방장만 세션 기록을 삭제할 수 있습니다.');
          const index = this.room.ledger.findIndex(entry => entry.id === data.recordId);
          if (index < 0) throw new Error('삭제할 세션 기록을 찾을 수 없습니다.');
          this.room.ledger.splice(index, 1);
        } else if (data.type === 'action') act(this.room, session.id, data.action, data.amount);
        else throw new Error('알 수 없는 요청입니다.');
        await this.save();
        if (data.type === 'ledgerSave' || data.type === 'ledgerDelete') {
          try { await this.syncLeaderboard(); } catch { /* The next table connection will retry the shared ranking sync. */ }
        }
        if (data.type === 'leave') {
          for (const peer of this.ctx.getWebSockets()) if (peer.deserializeAttachment().id === session.id) { peer.send(JSON.stringify({ type: 'left' })); peer.close(1000, 'Left room'); }
        }
        this.broadcast();
      } catch (error) {
        this.room = before;
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        ws.send(JSON.stringify({ type: 'state', room: publicRoom(this.room, session.id, this.online()) }));
      }
    });
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.room?.deadline) return;
      if (this.room.deadline > Date.now()) { await this.ctx.storage.setAlarm(this.room.deadline); return; }
      const player = this.room.players[this.room.turn];
      const legal = legalActions(this.room, player.id);
      act(this.room, player.id, legal.canCheck ? 'check' : 'fold');
      await this.save(); this.broadcast();
    });
  }
  async webSocketClose(ws, code) { ws.close(code === 1005 ? 1000 : code); if (this.room) this.broadcast(); }
  async webSocketError(ws) { ws.close(1011, 'Connection error'); }
}
