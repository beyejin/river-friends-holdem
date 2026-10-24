// Run against a local Wrangler server: node test/integration.mjs
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.TEST_URL || 'http://localhost:8787';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(path, data, cookie = '') {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base }, body: JSON.stringify(data) });
  return { response, data: await response.json() };
}
async function player(name) {
  const { response } = await post('/api/session', {});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { name, cookie, room: null, errors: [], ws: null };
}
async function connect(p, code) {
  p.ws = new WebSocket(base.replace(/^http/, 'ws') + `/api/rooms/${code}/socket`, { headers: { Cookie: p.cookie, Origin: base } });
  p.ws.on('message', raw => { const data = JSON.parse(String(raw)); if (data.type === 'state') p.room = data.room; if (data.type === 'error') p.errors.push(data.error); if (data.type === 'left') p.left = true; });
  await until(() => p.room);
}
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(20); }
  throw new Error('Timed out waiting for expected state');
}
async function send(p, type, data = {}) {
  await delay(175);
  const revision = p.room.revision;
  p.ws.send(JSON.stringify({ type, revision, ...data }));
  await until(() => p.room.revision > revision || p.errors.length || p.left);
  assert.deepEqual(p.errors, []);
}

const players = [];
try {
  assert.equal((await post('/api/rooms', {})).response.status, 401);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/session',{method:'POST',body:'{}'})).status,415);
  const a=await player('검증 A'),b=await player('검증 B'); players.push(a,b);
  const created=await post('/api/rooms',{nickname:a.name,roomName:'자동 검증 테이블'},a.cookie);
  assert.equal(created.response.status,201); const code=created.data.code;
  assert.equal((await post(`/api/rooms/${code}/join`,{nickname:b.name},b.cookie)).response.status,200);
  await connect(a,code); await connect(b,code);
  assert.equal(a.room.players.length,2); assert.equal(b.room.players.length,2);
  assert.notEqual(a.room.me,b.room.me);
  await send(a,'ready'); await send(b,'ready'); await send(a,'start');
  await until(()=>b.room.stage==='preflop');
  assert.ok(a.room.players.find(p=>p.id===a.room.me).cards.every(Number.isInteger));
  assert.deepEqual(a.room.players.find(p=>p.id===b.room.me).cards,[null,null]);
  assert.deepEqual(b.room.players.find(p=>p.id===a.room.me).cards,[null,null]);
  assert.equal(a.room.deck,undefined);
  const revision=a.room.revision;
  a.ws.send(JSON.stringify({type:'action',revision:revision-1,action:'fold'}));
  await until(()=>a.errors.length); assert.match(a.errors.shift(),/갱신|잠시/);
  assert.equal(a.room.revision,revision);
  while(a.room.stage!=='finished') {
    const active=players.find(p=>p.room.legal);
    assert.ok(active); await send(active,'action',{action:active.room.legal.canCheck?'check':'call'});
    await until(()=>a.room.revision===b.room.revision);
  }
  assert.equal(a.room.history.length,1);
  assert.equal(a.room.ranking.reduce((s,p)=>s+p.net,0),0);
  assert.equal(a.room.players.reduce((s,p)=>s+p.chips,0),60000);
  const expected=JSON.stringify(a.room.ranking);
  a.ws.close(); await delay(100); a.room=null; await connect(a,code);
  assert.equal(JSON.stringify(a.room.ranking),expected);
  assert.equal(a.room.history.length,1);
  // Rejoining with the same browser identity must not create another seat.
  await post(`/api/rooms/${code}/join`,{nickname:a.name},a.cookie);
  await until(()=>a.room.players.length===2);
  await send(a,'leave'); await until(()=>b.room.players.length===1);
  assert.equal(b.room.hostId,b.room.me);
  console.log('PASS: authentication, origin checks, two-player WebSocket sync, hidden cards, stale actions, full hand, chip conservation, ranking, reconnect and host transfer');
} finally {
  for(const p of players) p.ws?.close();
}
