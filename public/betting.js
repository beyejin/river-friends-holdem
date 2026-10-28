export function raisePresets(room, legal) {
  const potAfterCall = room.pot + legal.toCall;
  const amount = fraction => Math.min(legal.max, Math.max(legal.min, room.bet + Math.round(potAfterCall * fraction)));
  return [
    { label: '최소', amount: legal.min },
    { label: '½ 팟', amount: amount(0.5) },
    { label: '팟', amount: amount(1) },
    { label: '올인', amount: legal.max },
  ];
}

export function raisePreview(value, player, legal, bigBlind) {
  if (String(value).trim() === '') return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < legal.min || amount > legal.max) return null;
  const additional = amount - player.bet;
  return { additional, remaining: player.chips - additional, bigBlinds: amount / bigBlind };
}
