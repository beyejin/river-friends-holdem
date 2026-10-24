import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, shuffledDeck, createRoom, addPlayer, startHand, act, publicRoom, legalActions, settle } from '../src/poker.js';

const c = (rank, suit = 0) => suit * 13 + rank - 2;
function setup(stacks = [2000, 2000]) {
  const room = createRoom('test', 'p0', '테스트');
  room.smallBlind = 10; room.bigBlind = 20; room.minRaise = 20;
  stacks.forEach((chips, i) => { addPlayer(room, `p${i}`, `친구${i}`); room.players[i].chips = chips; room.players[i].ready = true; });
  startHand(room, 'p0'); return room;
}
test('새 테이블은 1인당 30,000칩으로 최대 9명까지 입장한다', () => {
  const room = createRoom('capacity', 'p0', '정원 검증');
  for (let index = 0; index < 9; index++) addPlayer(room, `p${index}`, `참가자${index}`);
  assert.equal(room.players.length, 9);
  assert.ok(room.players.every(player => player.chips === 30000));
  assert.throws(() => addPlayer(room, 'p9', '열 번째 참가자'), /정원이 가득/);
  assert.equal(room.players.length, 9);
  assert.equal(room.records.p9, undefined);
});
test('덱은 중복 없이 52장을 포함한다', () => {
  const deck = shuffledDeck(); assert.equal(new Set(deck).size, 52); assert.ok(deck.every(c => c >= 0 && c < 52));
});
test('족보 순위, 휠 스트레이트, 두 트리플의 풀 하우스', () => {
  const royal = evaluate([10,11,12,13,14].map(r => c(r)));
  assert.equal(royal.name, '로열 플러시');
  const wheel = evaluate([c(14), c(2,1), c(3,2), c(4,3), c(5), c(9), c(10,2)]);
  assert.equal(wheel.name, '스트레이트');
  assert.ok(evaluate([c(2), c(3,1), c(4,2), c(5,3), c(6)]).score > wheel.score);
  assert.equal(evaluate([c(14),c(14,1),c(14,2),c(13),c(13,1),c(13,2),c(2)]).name,'풀 하우스');
  assert.ok(royal.score > evaluate([c(14),c(14,1),c(14,2),c(14,3),c(13)]).score);
});
test('같은 족보의 킥커와 보드 공유 무승부', () => {
  const board = [c(2),c(2,1),c(5,2),c(8,3),c(10)];
  assert.ok(evaluate([...board,c(14,2),c(3)]).score > evaluate([...board,c(13,2),c(3)]).score);
  const royal = [10,11,12,13,14].map(r => c(r));
  assert.equal(evaluate([...royal,c(2,1),c(3,1)]).score, evaluate([...royal,c(8,2),c(9,2)]).score);
});
test('헤즈업 딜러는 스몰 블라인드이며 프리플롭 먼저 행동한다', () => {
  const room = setup(); assert.equal(room.dealer, room.sb); assert.equal(room.turn, room.sb);
  act(room, room.players[room.turn].id, 'call');
  assert.equal(room.turn, room.bb); assert.ok(legalActions(room,room.players[room.turn].id).canCheck);
  act(room, room.players[room.turn].id, 'check');
  assert.equal(room.stage, 'flop'); assert.equal(room.turn, room.bb); assert.equal(room.board.length,3);
});
test('차례, 체크, 레이즈 금액 검증 및 개인 패 비공개', () => {
  const room = setup();
  assert.throws(() => act(room,'p1','check'), /차례/);
  assert.throws(() => act(room,'p0','check'), /콜/);
  assert.throws(() => act(room,'p0','raise',21), /범위/);
  assert.throws(() => act(room,'p0','raise',NaN), /범위/);
  const state = publicRoom(room,'p0');
  assert.equal(state.players[0].cards.length,2); assert.ok(state.players[0].cards.every(Number.isInteger));
  assert.deepEqual(state.players[1].cards,[null,null]);
  assert.equal(state.deck,undefined); assert.equal(state.records,undefined);
});
test('체크와 콜로 쇼다운까지 진행하고 전적은 한 번 정산한다', () => {
  const room = setup([2000,2000,2000]);
  let count = 0;
  while(room.stage !== 'finished' && count++ < 30) {
    const id = room.players[room.turn].id; const legal = legalActions(room,id);
    act(room,id,legal.canCheck ? 'check' : 'call');
  }
  assert.equal(room.stage,'finished'); assert.equal(room.board.length,5);
  assert.equal(room.players.reduce((sum,p)=>sum+p.chips,0),6000);
  assert.equal(Object.values(room.records).reduce((sum,r)=>sum+r.net,0),0);
  assert.equal(room.history.length,1); assert.equal(room.records.p0.hands,1);
  assert.throws(()=>act(room,'p0','call'));
});
test('쇼다운 전에 모두 폴드하면 승자의 패를 공개하지 않는다', () => {
  const room = setup(); act(room,'p0','fold');
  assert.equal(room.stage,'finished'); assert.equal(room.players[1].chips,2010);
  assert.deepEqual(publicRoom(room,'p0').players[1].cards,[null,null]);
});
test('짧은 올인은 이미 행동한 플레이어의 레이즈 권한을 열지 않는다', () => {
  const room = setup([2000,30,2000]);
  assert.equal(room.turn,0); act(room,'p0','call');
  act(room,'p1','raise',30); act(room,'p2','call');
  assert.equal(room.turn,0); assert.equal(legalActions(room,'p0').canRaise,false);
  assert.throws(()=>act(room,'p0','raise',50),/범위/);
  act(room,'p0','call'); assert.equal(room.stage,'flop');
});
test('여러 짧은 올인의 누적 상승이 정규 레이즈 크기를 채우면 다시 레이즈할 수 있다', () => {
  const room = setup([2000,2000,2000,2000]);
  room.stage='flop'; room.bet=100; room.minRaise=100; room.turn=1;
  for (const p of room.players) { p.bet=100; p.total=100; p.actedAt=100; }
  room.players[1].chips=50; room.players[1].actedAt=null;
  room.players[2].chips=100; room.players[2].actedAt=null;
  act(room,'p1','raise',150); act(room,'p2','raise',200);
  assert.equal(legalActions(room,'p3').canRaise,true);
});
test('사이드 팟과 미콜 초과 금액을 정확히 나눈다', () => {
  const room = setup([100,200,500]);
  room.board=[c(2),c(5,1),c(8,2),c(10,3),c(3)];
  const totals=[100,200,300];
  room.players.forEach((p,i)=>{p.total=totals[i];p.chips=i===2?200:0;p.startChips=[100,200,500][i];p.cards=[c(14-i,1),c(14-i,2)];});
  room.pot=600; settle(room,true);
  assert.deepEqual(room.players.map(p=>p.chips),[300,200,300]);
  assert.equal(room.records.p0.net,200); assert.equal(room.records.p2.net,-200);
});
test('나눌 수 없는 홀수 칩은 딜러 왼쪽 승자부터 분배한다', () => {
  const room=setup([100,100,100]);
  room.board=[10,11,12,13,14].map(r=>c(r)); room.dealer=0;
  room.players.forEach(p=>{p.total=5;p.chips=95;p.startChips=100;});
  room.players[2].folded=true; room.pot=15;
  settle(room,true); assert.deepEqual(room.players.map(p=>p.chips),[102,103,95]);
});
test('빅 블라인드보다 작은 올인도 자동 진행 후 정산된다', () => {
  const room=setup([5,10]); assert.equal(room.stage,'finished');
  assert.equal(room.players.reduce((sum,p)=>sum+p.chips,0),15);
});
test('헤즈업에서 빅 블라인드가 짧게 올인하면 초과 콜을 요구하지 않는다', () => {
  const room=setup([2000,5]); assert.equal(room.stage,'finished');
  assert.equal(room.players.reduce((sum,p)=>sum+p.chips,0),2005);
});
test('500개 무작위 핸드에서 칩 보존, 유효 차례, 종료를 유지한다', () => {
  let seed=93280;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
  for(let n=0;n<500;n++){
    const stacks=Array.from({length:2+Math.floor(random()*5)},()=>1+Math.floor(random()*2000));
    const total=stacks.reduce((a,b)=>a+b,0); const room=setup(stacks); let count=0;
    while(room.stage!=='finished' && count++<300){
      const p=room.players[room.turn]; assert.ok(p && !p.folded && p.chips>0);
      const legal=legalActions(room,p.id);const r=random();
      if(r<.14)act(room,p.id,'fold');
      else if(r<.35 && legal.canRaise)act(room,p.id,'raise',r<.21?legal.max:legal.min);
      else act(room,p.id,legal.canCheck?'check':'call');
      assert.equal(room.players.reduce((s,p)=>s+p.chips,room.pot),total);
      assert.ok(room.players.every(p=>Number.isSafeInteger(p.chips)&&p.chips>=0));
    }
    assert.equal(room.stage,'finished');
    assert.equal(Object.values(room.records).reduce((s,r)=>s+r.net,0),0);
  }
});
