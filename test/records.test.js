import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { addPlayer, createRoom, weekKey } from '../src/poker.js';

// Storage fixture access exists only in this isolated test Worker, never in production.
const fixtureWorker = `
import worker, { PokerRoom as BasePokerRoom } from './src/worker.js';
export default worker;
export class PokerRoom extends BasePokerRoom {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__test_seed') return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(await request.json());
      return Response.json({ ok: true });
    });
    if (path === '/__test_snapshot') return this.ctx.blockConcurrencyWhile(async () =>
      Response.json(Object.fromEntries(await this.ctx.storage.list())));
    if (path === '/__test_message') {
      const { id, message } = await request.json();
      const messages = [];
      let attachment = { id, lastMessage: 0 };
      await this.webSocketMessage({
        deserializeAttachment: () => attachment,
        serializeAttachment: value => { attachment = value; },
        send: value => messages.push(JSON.parse(value)),
      }, JSON.stringify(message));
      return Response.json({ messages });
    }
    return super.fetch(request);
  }
}`;

test('기존 Durable Object 데이터와 회원별 기록을 보존한다', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const persistence = await mkdtemp(join(tmpdir(), 'river-records-test-'));
  const options = convertV4MiniflareOptions({
    name: 'river-records-test',
    compatibilityDate: '2026-10-01',
    resourcePersistencePath: persistence,
    modulesRoot: root,
    modules: [
      { type: 'ESModule', path: `${root}records-fixture-worker.js`, contents: fixtureWorker },
      { type: 'ESModule', path: `${root}src/worker.js`, contents: await readFile(new URL('../src/worker.js', import.meta.url), 'utf8') },
      { type: 'ESModule', path: `${root}src/poker.js`, contents: await readFile(new URL('../src/poker.js', import.meta.url), 'utf8') },
    ],
    durableObjects: { ROOMS: { className: 'PokerRoom', useSQLite: true } },
  });
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); });
  const namespace = await mf.getDurableObjectNamespace('ROOMS');
  const registry = namespace.get(namespace.idFromName('river-members'));
  const date = weekKey(Date.now());
  const previousDate = weekKey(Date.now() - 7 * 86400000);
  const at = Date.parse(`${date}T12:00:00+09:00`);
  const legacy = {
    id: 'legacy-manual', date, at, week: date, note: '기존 세션 메모',
    players: [
      { name: '한예진', wins: 2, rebuys: 2, finalChips: 100000, note: '기존 참가자 메모' },
      { name: '김영광', wins: 1, rebuys: 0, finalChips: 30000 },
    ],
  };
  const oldRoomLedger = [{
    id: 'old-room-ledger', date, at, week: date,
    players: [
      { id: 'old-a', name: '한예진', rebuys: 1, finalChips: 90000 },
      { id: 'old-b', name: '김영광', rebuys: 0, finalChips: 30000 },
    ],
  }];
  const registered = [{ key: 'member:9기:한예진', cohort: '9기', name: '한예진' }];
  const fixture = {
    'registered-members': registered,
    'leaderboard-sessions': [legacy],
    'leaderboard-rooms': { 'abcdef1234567890': oldRoomLedger },
    'unrelated-existing-key': { preserved: true },
  };
  async function call(stub, path, data, id = 'test-player', method = data === undefined ? 'GET' : 'POST') {
    const response = await stub.fetch(`https://room${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-player-id': id },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  }
  const snapshot = async stub => (await call(stub, '/__test_snapshot')).data;
  await call(registry, '/__test_seed', fixture);

  await t.test('조회는 기존 저장값을 바꾸지 않고 무키 기록을 한 회원에게만 집계한다', async () => {
    const { data } = await call(registry, '/leaderboard');
    const original = data.ranking.find(player => player.key === 'default:한예진');
    const namesake = data.ranking.find(player => player.key === registered[0].key);
    assert.equal(original.weeklyWins, 3);
    assert.equal(original.rebuys, 3);
    assert.equal(original.net, 40000);
    assert.equal(namesake.weeklyWins, 0);
    assert.equal(namesake.rebuys, 0);
    assert.equal(namesake.cohort, '9기');
    assert.deepEqual(await snapshot(registry), fixture);
  });

  await t.test('수정은 같은 ID를 교체하고 칩/메모/다른 저장 키를 보존한다', async () => {
    const payload = {
      sessionId: legacy.id, date,
      players: [
        { memberKey: 'default:한예진', name: '한예진', wins: 5, rebuys: 2, rebuyEvents: [at, null] },
        { name: '김영광', wins: 0, rebuys: 0 },
      ],
    };
    const saved = await call(registry, '/leaderboard-session', payload);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.session.id, legacy.id);
    assert.equal(saved.data.session.note, legacy.note);
    assert.equal(saved.data.session.players[0].note, legacy.players[0].note);
    assert.equal(saved.data.session.players[0].finalChips, 100000);
    assert.deepEqual(saved.data.session.players[0].rebuyEvents, [at, null]);
    const stored = await snapshot(registry);
    assert.equal(stored['leaderboard-sessions'].length, 1);
    assert.deepEqual(stored['registered-members'], fixture['registered-members']);
    assert.deepEqual(stored['leaderboard-rooms'], fixture['leaderboard-rooms']);
    assert.deepEqual(stored['unrelated-existing-key'], fixture['unrelated-existing-key']);
    const current = (await call(registry, '/leaderboard')).data.ranking.find(player => player.key === 'default:한예진');
    assert.equal(current.weeklyWins, 6);
    assert.equal(current.rebuys, 3);
    payload.date = previousDate;
    payload.players[0].rebuys = 1;
    payload.players[0].rebuyEvents = [null];
    await call(registry, '/leaderboard-session', payload);
    const updated = (await call(registry, '/leaderboard')).data.ranking.find(player => player.key === 'default:한예진');
    assert.equal(updated.weeklyWins, 1);
    assert.equal(updated.wins, 6);
    assert.equal(updated.rebuys, 2);
    assert.equal((await snapshot(registry))['leaderboard-sessions'].length, 1);
  });

  await t.test('동명이인과 미기록 시각을 구분하고 새 기록을 별도로 저장한다', async () => {
    const result = await call(registry, '/leaderboard-session', { date, players: [
      { memberKey: 'default:한예진', name: '한예진', rebuys: 0, wins: 1 },
      { memberKey: registered[0].key, name: '한예진', rebuys: 2, wins: 4 },
    ] });
    assert.equal(result.status, 201);
    assert.deepEqual(result.data.session.players[1].rebuyEvents, [null, null]);
    const ranking = (await call(registry, '/leaderboard')).data.ranking;
    assert.equal(ranking.find(player => player.key === 'default:한예진').weeklyWins, 2);
    assert.equal(ranking.find(player => player.key === registered[0].key).weeklyWins, 4);
    assert.equal(ranking.find(player => player.key === registered[0].key).rebuys, 2);
  });

  await t.test('잘못된 날짜/인원/횟수/시각/수정 ID는 저장하지 않는다', async () => {
    const before = await snapshot(registry);
    const players = [{ name: '한예진', wins: 1, rebuys: 0 }, { name: '김영광', wins: 0, rebuys: 0 }];
    const invalid = [
      { date: '2026-02-30', players },
      { date, players: players.slice(0, 1) },
      { date, players: Array(10).fill(players[0]) },
      { date, players: [players[0], players[0]] },
      { date, players: [{ ...players[0], rebuys: 0.5 }, players[1]] },
      { date, players: [{ ...players[0], rebuys: 1, rebuyEvents: [] }, players[1]] },
      { date, players: [{ ...players[0], rebuys: 1, rebuyEvents: ['unknown'] }, players[1]] },
      { date, players: [{ ...players[0], wins: -1 }, players[1]] },
      { date, players: [{ ...players[0], memberKey: 'missing' }, players[1]] },
      { date, players, sessionId: '' },
      { date, players, sessionId: 'missing' },
    ];
    for (const payload of invalid) assert.ok((await call(registry, '/leaderboard-session', payload)).status >= 400);
    assert.deepEqual(await snapshot(registry), before);
  });

  await t.test('등록만 해도 회원이 저장되고 동시에 저장한 기록도 사라지지 않는다', async () => {
    const before = await snapshot(registry);
    assert.equal((await call(registry, '/members', { cohort: '10기', name: '새회원' })).status, 201);
    assert.equal((await call(registry, '/members', { cohort: '10기', name: '새회원' })).status, 409);
    assert.equal((await call(registry, '/members', { cohort: '', name: '새회원' })).status, 400);
    assert.deepEqual((await snapshot(registry))['leaderboard-sessions'], before['leaderboard-sessions']);
    const players = [{ name: '한예진', wins: 1, rebuys: 0 }, { name: '김영광', wins: 0, rebuys: 0 }];
    const saved = await Promise.all([1, 2, 3].map(() => call(registry, '/leaderboard-session', { date, players })));
    assert.ok(saved.every(result => result.status === 201));
    const sessions = (await snapshot(registry))['leaderboard-sessions'];
    assert.equal(sessions.length, before['leaderboard-sessions'].length + 3);
    assert.equal(new Set(sessions.map(session => session.id)).size, sessions.length);
  });

  await t.test('기존 room 객체는 재시작 후 그대로이며 회원 키가 새 테이블 기록에 이어진다', async () => {
    const roomId = '1234567890abcdef';
    const oldRoom = createRoom(roomId, 'old-a', '기존 테이블');
    addPlayer(oldRoom, 'old-a', '한예진');
    addPlayer(oldRoom, 'old-b', '김영광');
    oldRoom.ledger = oldRoomLedger;
    const stub = namespace.get(namespace.idFromName(roomId));
    await call(stub, '/__test_seed', { room: oldRoom });
    await mf.unsafeEvictDurableObject('river-records-test', 'PokerRoom', { name: roomId });
    assert.deepEqual((await snapshot(stub)).room, oldRoom);
    assert.equal((await call(stub, '/join', { nickname: '김영광', memberKey: 'default:김영광' }, 'old-a')).status, 400);
    assert.deepEqual((await snapshot(stub)).room, oldRoom);
    assert.equal((await call(stub, '/join', { nickname: '한예진', memberKey: 'default:한예진' }, 'old-a')).status, 200);
    assert.equal((await snapshot(stub)).room.records['old-a'].memberKey, 'default:한예진');
    const currentRoom = namespace.get(namespace.idFromName('fedcba0987654321'));
    const initialized = await call(currentRoom, '/init', { id: 'fedcba0987654321', name: '새 테이블', nickname: '다른 이름', memberKey: 'default:한예진' }, 'new-a');
    assert.equal(initialized.status, 201);
    assert.equal((await call(currentRoom, '/join', { nickname: '한예진', memberKey: registered[0].key }, 'new-b')).status, 200);
    const room = (await snapshot(currentRoom)).room;
    assert.equal(room.players[0].name, '한예진');
    assert.equal(room.players[0].chips, 20000);
    assert.equal(room.players[1].chips, 20000);
    assert.equal(room.records['new-a'].memberKey, 'default:한예진');
    assert.equal(room.records['new-b'].memberKey, registered[0].key);
    assert.equal((await call(currentRoom, '/join', { nickname: '한예진', memberKey: registered[0].key }, 'new-a')).status, 400);
    assert.deepEqual((await snapshot(currentRoom)).room, room);
    assert.equal((await call(currentRoom, '/join', { nickname: '변경 시도' }, 'new-a')).status, 200);
    const rejoined = (await snapshot(currentRoom)).room;
    assert.equal(rejoined.players.length, 2);
    assert.equal(rejoined.players[0].name, '한예진');
    assert.equal(rejoined.records['new-a'].memberKey, 'default:한예진');
    const saved = await call(currentRoom, '/__test_message', {
      id: 'new-a', message: { type: 'ledgerSave', revision: rejoined.revision, date, players: [
        { id: 'new-a', rebuys: 0, finalChips: 20000 },
        { id: 'new-b', rebuys: 1, finalChips: 70000 },
      ] },
    });
    assert.deepEqual(saved.data.messages, []);
    const ledger = (await snapshot(currentRoom)).room.ledger;
    assert.equal(ledger[0].players[1].memberKey, registered[0].key);
    assert.equal(ledger[0].players[1].cohort, '9기');
    const score = (await call(registry, '/leaderboard')).data.ranking.find(player => player.key === registered[0].key);
    assert.equal(score.weeklyWins, 5);
    assert.equal(score.rebuys, 3);
  });

  await t.test('9인 테이블 기록은 브라우저 ID와 수정 ID를 포함해 저장되고 같은 기록을 교체한다', async () => {
    const roomId = '9999999999999999';
    const stub = namespace.get(namespace.idFromName(roomId));
    const ids = Array.from({ length: 9 }, (_, index) => String(index).padStart(64, '0'));
    assert.equal((await call(stub, '/init', { id: roomId, name: '9인 기록 검증', nickname: '참가자1' }, ids[0])).status, 201);
    for (let index = 1; index < ids.length; index++) {
      assert.equal((await call(stub, '/join', { nickname: `참가자${index + 1}` }, ids[index])).status, 200);
    }
    const room = (await snapshot(stub)).room;
    const players = ids.map(id => ({ id, rebuys: 0, finalChips: 30000 }));
    const create = { type: 'ledgerSave', revision: room.revision, date, players };
    assert.ok(JSON.stringify(create).length <= 1024);
    assert.deepEqual((await call(stub, '/__test_message', { id: ids[0], message: create })).data.messages, []);
    const created = (await snapshot(stub)).room;
    assert.equal(created.ledger.length, 1);
    const update = { ...create, revision: created.revision, recordId: created.ledger[0].id, players: players.map((player, index) => ({ ...player, rebuys: index === 0 ? 1 : 0 })) };
    assert.ok(JSON.stringify(update).length > 1024);
    assert.deepEqual((await call(stub, '/__test_message', { id: ids[0], message: update })).data.messages, []);
    const edited = (await snapshot(stub)).room;
    assert.equal(edited.ledger.length, 1);
    assert.equal(edited.ledger[0].id, created.ledger[0].id);
    assert.equal(edited.ledger[0].players.length, 9);
    assert.equal(edited.ledger[0].players[0].rebuys, 1);
    const rejected = await call(stub, '/__test_message', { id: ids[0], message: { ...update, revision: edited.revision, padding: 'x'.repeat(8192) } });
    assert.match(rejected.data.messages[0].error, /요청이 너무 큽니다/);
    assert.deepEqual((await snapshot(stub)).room, edited);
  });

  await t.test('회원 삭제는 명단에서만 제외하고 기존 기록과 동명이인의 랭킹 연결을 보존한다', async () => {
    const before = await snapshot(registry);
    const beforeMembers = (await call(registry, '/members')).data;
    const beforeRanking = (await call(registry, '/leaderboard')).data.ranking;
    const room = namespace.get(namespace.idFromName('1234567890abcdef'));
    const beforeRoom = await snapshot(room);
    const deletedKeys = ['default:한예진', registered[0].key, 'default:박진환', 'member:10기:새회원'];
    for (const memberKey of deletedKeys) {
      const deleted = await call(registry, '/members', { memberKey }, 'test-player', 'DELETE');
      assert.equal(deleted.status, 200);
      assert.equal(deleted.data.ok, true);
      assert.ok(!deleted.data.members.some(member => member.key === memberKey));
    }
    assert.deepEqual(await snapshot(registry), { ...before, 'deleted-member-keys': deletedKeys });
    assert.deepEqual(await snapshot(room), beforeRoom);
    const members = (await call(registry, '/members')).data;
    assert.deepEqual(members.recordMembers, beforeMembers.recordMembers);
    assert.deepEqual(members.members, beforeMembers.members.filter(member => !deletedKeys.includes(member.key)));
    const ranking = (await call(registry, '/leaderboard')).data.ranking;
    for (const key of deletedKeys.slice(0, 2)) {
      assert.deepEqual(ranking.find(member => member.key === key), { ...beforeRanking.find(member => member.key === key), deleted: true });
    }
    for (const key of deletedKeys.slice(2)) assert.ok(!ranking.some(member => member.key === key));
    assert.deepEqual((await call(registry, '/leaderboard')).data.sessions, before['leaderboard-sessions']);
    assert.equal((await call(registry, '/members', { memberKey: deletedKeys[0] }, 'test-player', 'DELETE')).status, 200);
    for (const memberKey of [null, 42, '', 'not-a-key', 'default:한예진\n']) {
      assert.equal((await call(registry, '/members', { memberKey }, 'test-player', 'DELETE')).status, 400);
    }
    assert.equal((await call(registry, '/members', { memberKey: 'default:없는회원' }, 'test-player', 'DELETE')).status, 404);
    assert.deepEqual(await snapshot(registry), { ...before, 'deleted-member-keys': deletedKeys });
  });

  await t.test('삭제 회원은 기존 기록에서만 수정할 수 있고 새 기록과 테이블의 참가자로는 선택할 수 없다', async () => {
    const before = await snapshot(registry);
    const existing = before['leaderboard-sessions'].find(session => session.id === legacy.id);
    const payload = { sessionId: existing.id, date: existing.date, players: existing.players.map(player => ({ ...player })) };
    payload.players[0].wins++;
    const edited = await call(registry, '/leaderboard-session', payload);
    assert.equal(edited.status, 200);
    assert.equal(edited.data.session.id, existing.id);
    assert.equal(edited.data.session.players[0].wins, existing.players[0].wins + 1);
    const after = await snapshot(registry);
    assert.equal(after['leaderboard-sessions'].length, before['leaderboard-sessions'].length);
    assert.deepEqual(after['leaderboard-sessions'].filter(session => session.id !== existing.id), before['leaderboard-sessions'].filter(session => session.id !== existing.id));
    assert.deepEqual(after['leaderboard-rooms'], before['leaderboard-rooms']);
    assert.deepEqual(after['registered-members'], before['registered-members']);
    assert.equal((await call(registry, '/leaderboard-session', { ...payload, sessionId: undefined })).status, 400);
    const added = { ...payload, players: [...payload.players, { memberKey: registered[0].key, rebuys: 0, wins: 0 }] };
    assert.equal((await call(registry, '/leaderboard-session', added)).status, 400);
    const roomId = 'dddddddddddddddd';
    const room = namespace.get(namespace.idFromName(roomId));
    assert.equal((await call(room, '/init', { id: roomId, name: '삭제 회원 검증', nickname: '한예진', memberKey: 'default:한예진' })).status, 400);
    assert.deepEqual(await snapshot(room), {});
    const existingRoom = namespace.get(namespace.idFromName('1234567890abcdef'));
    const beforeRoom = await snapshot(existingRoom);
    assert.equal((await call(existingRoom, '/join', { memberKey: registered[0].key }, 'new-deleted-player')).status, 400);
    assert.deepEqual(await snapshot(existingRoom), beforeRoom);
    assert.deepEqual(await snapshot(registry), after);
  });

  await t.test('삭제된 등록회원의 재가입은 같은 회원 키를 복원하고 기록과 등록 원문을 유지한다', async () => {
    const before = await snapshot(registry);
    const member = registered[0];
    const restored = await call(registry, '/members', { cohort: member.cohort, name: member.name });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.data.member, member);
    assert.ok(restored.data.members.some(entry => entry.key === member.key));
    assert.equal(restored.data.recordMembers.filter(entry => entry.key === member.key).length, 1);
    assert.deepEqual(await snapshot(registry), { ...before, 'deleted-member-keys': before['deleted-member-keys'].filter(key => key !== member.key) });
    assert.equal((await call(registry, '/members', { cohort: member.cohort, name: member.name })).status, 409);
    assert.equal((await call(registry, '/leaderboard')).data.ranking.find(entry => entry.key === member.key).deleted, undefined);
  });

  await t.test('공개 회원 삭제 API는 세션과 Origin을 확인하고 반복 요청을 안전하게 처리한다', async () => {
    const before = await snapshot(registry);
    const request = headers => mf.dispatchFetch('https://river.test/api/members', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ memberKey: 'default:박진환' }),
    });
    assert.equal((await request({ Origin: 'https://river.test' })).status, 401);
    const cookie = 'river_session=12345678-1234-1234-1234-123456789012';
    assert.equal((await request({ Cookie: cookie, Origin: 'https://outside.test' })).status, 403);
    assert.equal((await request({ Cookie: cookie, Origin: 'https://river.test', 'Content-Type': 'text/plain' })).status, 415);
    const response = await request({ Cookie: cookie, Origin: 'https://river.test' });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.ok(!data.members.some(member => member.key === 'default:박진환'));
    assert.ok(data.recordMembers.some(member => member.key === 'default:박진환'));
    assert.deepEqual(await snapshot(registry), before);
  });

  await t.test('Durable Object 재시작 뒤 회원과 수정된 기록이 저장값 그대로 복구된다', async () => {
    const before = await snapshot(registry);
    await mf.dispose();
    mf = new Miniflare(options);
    const restartedNamespace = await mf.getDurableObjectNamespace('ROOMS');
    const restored = restartedNamespace.get(restartedNamespace.idFromName('river-members'));
    assert.deepEqual(await snapshot(restored), before);
    assert.deepEqual((await call(restored, '/leaderboard')).data.sessions, before['leaderboard-sessions']);
    assert.ok(!(await call(restored, '/members')).data.members.some(member => member.key === 'default:한예진'));
    assert.equal((await call(restored, '/leaderboard')).data.ranking.find(member => member.key === 'default:한예진').deleted, true);
  });
});
