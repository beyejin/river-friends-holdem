const guide = document.querySelector('#guide');
const guideTabs = [...guide.querySelectorAll('[role="tab"]')];
const hands = [
  ['로열 플러시', ['A♠', 'K♠', 'Q♠', 'J♠', '10♠'], '같은 무늬의 A, K, Q, J, 10. 가장 높은 스트레이트 플러시예요.'],
  ['스트레이트 플러시', ['9♥', '8♥', '7♥', '6♥', '5♥'], '같은 무늬로 이어지는 숫자 5장이에요.'],
  ['포 카드', ['A♠', 'A♥', 'A♦', 'A♣', 'K♠'], '같은 숫자 4장이에요.'],
  ['풀 하우스', ['K♠', 'K♥', 'K♦', '8♣', '8♠'], '같은 숫자 3장과 다른 같은 숫자 2장이에요.'],
  ['플러시', ['A♦', 'J♦', '8♦', '6♦', '2♦'], '숫자가 이어지지 않아도 같은 무늬 5장이면 돼요.'],
  ['스트레이트', ['9♠', '8♥', '7♦', '6♣', '5♠'], '무늬와 관계없이 이어지는 숫자 5장이에요.'],
  ['트리플', ['Q♠', 'Q♥', 'Q♦', '9♣', '4♠'], '같은 숫자 3장이에요.'],
  ['투 페어', ['J♠', 'J♥', '7♦', '7♣', '3♠'], '같은 숫자 2장짜리 쌍이 두 개예요.'],
  ['원 페어', ['10♠', '10♥', 'K♦', '8♣', '3♠'], '같은 숫자 2장짜리 쌍이 하나예요.'],
  ['하이 카드', ['A♠', 'J♥', '8♦', '6♣', '3♠'], '위 족보가 없으면 가장 높은 카드부터 비교해요.'],
];
const preflop = [
  ['AA', ['A♠', 'A♥'], '에이스 두 장'],
  ['KK', ['K♠', 'K♥'], '킹 두 장'],
  ['QQ', ['Q♠', 'Q♥'], '퀸 두 장'],
  ['JJ', ['J♠', 'J♥'], '잭 두 장'],
  ['AKs', ['A♠', 'K♠'], '같은 무늬의 에이스와 킹'],
];

function guideCards(cards) {
  const suits = { '♠': '스페이드', '♥': '하트', '♦': '다이아몬드', '♣': '클로버' };
  return `<div class="guide-cards">${cards.map(card => {
    const suit = card.slice(-1), rank = card.slice(0, -1);
    return `<span class="guide-card${'♥♦'.includes(suit) ? ' red' : ''}" role="img" aria-label="${suits[suit]} ${rank}"><b aria-hidden="true">${rank}</b><span aria-hidden="true">${suit}</span></span>`;
  }).join('')}</div>`;
}

function guideRows(rows) {
  return rows.map(([name, cards, description], i) => `<li class="guide-rank-row"><span class="guide-rank" aria-label="${i + 1}위">${i + 1}</span><div><h3>${name}</h3>${guideCards(cards)}<p>${description}</p></div></li>`).join('');
}

document.querySelector('#hand-guide').innerHTML = guideRows(hands);
document.querySelector('#preflop-guide').innerHTML = guideRows(preflop);

function selectGuideTab(tab) {
  for (const candidate of guideTabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    document.getElementById(candidate.getAttribute('aria-controls')).hidden = !selected;
  }
  guide.scrollTop = 0;
}

for (const [index, tab] of guideTabs.entries()) {
  tab.addEventListener('click', () => selectGuideTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % guideTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + guideTabs.length - 1) % guideTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = guideTabs.length - 1;
    else return;
    event.preventDefault();
    selectGuideTab(guideTabs[next]);
    guideTabs[next].focus();
  });
}

document.querySelector('#help-button').addEventListener('click', () => {
  guide.showModal();
  guideTabs.find(tab => tab.getAttribute('aria-selected') === 'true').focus();
});
document.querySelector('#close-guide').addEventListener('click', () => guide.close());
