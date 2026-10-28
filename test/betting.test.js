import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raisePresets, raisePreview } from '../public/betting.js';
import { createRoom, addPlayer, startHand, legalActions } from '../src/poker.js';

function headsUp() {
  const room = createRoom('betting', 'p0', '베팅 확인');
  room.smallBlind = 100; room.bigBlind = 200;
  for (const id of ['p0', 'p1']) { addPlayer(room, id, id); room.players.at(-1).chips = 20000; room.players.at(-1).ready = true; }
  startHand(room, 'p0');
  const player = room.players[room.turn];
  return { room, player, legal: legalActions(room, player.id) };
}

test('헤즈업 스몰 블라인드는 이미 낸 칩을 빼고 추가 투입과 남은 칩을 본다', () => {
  const { room, player, legal } = headsUp();
  assert.equal(room.sb, room.dealer);
  assert.equal(player.bet, 100);
  assert.deepEqual(raisePreview('400', player, legal, room.bigBlind), {
    additional: 300, remaining: 19600, bigBlinds: 2,
  });
  assert.deepEqual(raisePreview(String(legal.max), player, legal, room.bigBlind), {
    additional: 19900, remaining: 0, bigBlinds: 100,
  });
});

test('팟 프리셋은 콜을 마친 뒤의 팟을 기준으로 총 베팅액을 선택한다', () => {
  const { room, legal } = headsUp();
  assert.equal(room.pot, 300);
  assert.equal(legal.toCall, 100);
  assert.deepEqual(raisePresets(room, legal), [
    { label: '최소', amount: 400 },
    { label: '½ 팟', amount: 400 },
    { label: '팟', amount: 600 },
    { label: '올인', amount: 20000 },
  ]);
  assert.deepEqual(raisePresets({ pot: 1250, bet: 0 }, { min: 200, max: 5000, toCall: 0 }).map(p => p.amount), [200, 625, 1250, 5000]);
});

test('프리셋은 최소 레이즈와 올인 한도를 지키고 짧은 올인도 선택한다', () => {
  assert.deepEqual(raisePresets({ pot: 300, bet: 200 }, { min: 800, max: 1000, toCall: 100 }).map(p => p.amount), [800, 800, 800, 1000]);
  assert.deepEqual(raisePresets({ pot: 3000, bet: 200 }, { min: 400, max: 500, toCall: 100 }).map(p => p.amount), [400, 500, 500, 500]);
  assert.deepEqual(raisePresets({ pot: 300, bet: 200 }, { min: 300, max: 300, toCall: 100 }).map(p => p.amount), [300, 300, 300, 300]);
});

test('잘못된 금액은 미리보기 계산을 하지 않고 새 범위에서 다시 검사한다', () => {
  const { room, player, legal } = headsUp();
  for (const amount of ['', ' ', 'NaN', 'Infinity', '399', '20001', '400.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(raisePreview(amount, player, legal, room.bigBlind), null, amount);
  }
  assert.equal(raisePreview('400', player, { ...legal, min: 600 }, room.bigBlind), null);
});
