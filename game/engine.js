const { newDeck, shuffle, best7, bestOmaha, compareVal, computeSidePots, HAND_NAMES } = require('./handEval');

const RANK_TXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_TXT = { s: '♠', h: '♥', d: '♦', c: '♣' };
function cardTxt(c) { return (RANK_TXT[c.r] || c.r) + SUIT_TXT[c.s]; }

function pushLog(room, text) {
  room.log = room.log || [];
  room.log.unshift({ text, time: Date.now() });
  if (room.log.length > 50) room.log.length = 50;
}

function nextActiveSeat(room, idx) {
  const arr = room.activeSeats;
  const pos = arr.indexOf(idx);
  return arr[(pos + 1) % arr.length];
}

function rotateFrom(room, startIdx) {
  const arr = room.activeSeats;
  const pos = arr.indexOf(startIdx);
  if (pos === -1) return arr.slice();
  return arr.slice(pos).concat(arr.slice(0, pos));
}

function postBlind(room, idx, amt) {
  const p = room.players[idx];
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.betThisStreet += pay; p.totalContrib += pay; room.pot += pay;
  if (p.chips === 0) p.allIn = true;
}

function dealHand(room) {
  room.activeSeats = room.players.map((p, i) => i).filter(i => room.players[i].chips > 0);
  if (room.activeSeats.length < 2) {
    room.stage = 'lobby';
    return { error: '筹码大于 0 的玩家不足 2 人，无法开局' };
  }
  room.dealerIdx = (room.dealerIdx == null) ? room.activeSeats[0] : nextActiveSeat(room, room.dealerIdx);
  if (!room.activeSeats.includes(room.dealerIdx)) room.dealerIdx = room.activeSeats[0];

  room.players.forEach(p => {
    p.cards = []; p.folded = p.chips <= 0; p.allIn = false; p.betThisStreet = 0; p.totalContrib = 0; p.lastAction = null;
  });
  room.pot = 0; room.community = []; room.stage = 'preflop'; room.results = null;
  room.lastActedPlayerId = null;
  room.handNumber = (room.handNumber || 0) + 1;
  room.deck = shuffle(newDeck());
  const holeCount = room.gameType === 'omaha' ? 4 : 2;
  room.activeSeats.forEach(i => { room.players[i].cards = Array.from({ length: holeCount }, () => room.deck.pop()); });

  let sbIdx, bbIdx, startIdx;
  if (room.activeSeats.length === 2) {
    sbIdx = room.dealerIdx; bbIdx = nextActiveSeat(room, room.dealerIdx); startIdx = room.dealerIdx;
  } else {
    sbIdx = nextActiveSeat(room, room.dealerIdx); bbIdx = nextActiveSeat(room, sbIdx); startIdx = nextActiveSeat(room, bbIdx);
  }
  postBlind(room, sbIdx, room.smallBlind);
  postBlind(room, bbIdx, room.bigBlind);
  room.currentBet = room.bigBlind; room.sbIdx = sbIdx; room.bbIdx = bbIdx;
  room.minRaise = room.bigBlind; // 标准规则：第一次加注的最小增量至少要等于大盲
  room.actionQueue = rotateFrom(room, startIdx).filter(i => !room.players[i].folded && !room.players[i].allIn);
  room.turn = room.actionQueue[0];
  pushLog(room, `—— 第 ${room.handNumber} 局开局 ——`);
  pushLog(room, `${room.players[sbIdx].name} 下小盲 ${room.smallBlind}`);
  pushLog(room, `${room.players[bbIdx].name} 下大盲 ${room.bigBlind}`);
  return {};
}

function checkSinglePlayerLeft(room) {
  const alive = room.players.filter(p => !p.folded);
  if (alive.length === 1) {
    alive[0].chips += room.pot;
    room.results = [{ amount: room.pot, winners: [alive[0].name], handName: '（其余玩家已弃牌）' }];
    pushLog(room, `${alive[0].name} 获胜，赢得底池 ${room.pot}（其余玩家已弃牌）`);
    room.pot = 0; room.stage = 'showdown'; room.turn = null;
    return true;
  }
  return false;
}

function proceed(room) {
  if (checkSinglePlayerLeft(room)) return;
  if (room.actionQueue.length === 0) { advanceStreet(room); return; }
  room.turn = room.actionQueue[0];
}

function advanceStreet(room) {
  const stillToAct = room.players.filter((p, i) => room.activeSeats.includes(i) && !p.folded && !p.allIn).length;
  if (room.stage === 'river' || stillToAct <= 1) {
    while (room.community.length < 5) room.community.push(room.deck.pop());
    runShowdown(room);
    return;
  }
  if (room.stage === 'preflop') { room.stage = 'flop'; room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); pushLog(room, `翻牌：${room.community.map(cardTxt).join(' ')}`); }
  else if (room.stage === 'flop') { room.stage = 'turn'; room.community.push(room.deck.pop()); pushLog(room, `转牌：${cardTxt(room.community[room.community.length-1])}`); }
  else if (room.stage === 'turn') { room.stage = 'river'; room.community.push(room.deck.pop()); pushLog(room, `河牌：${cardTxt(room.community[room.community.length-1])}`); }
  room.players.forEach(p => { p.betThisStreet = 0; p.lastAction = null; });
  room.currentBet = 0;
  room.minRaise = room.bigBlind; // 每条新街，起始最小加注额重新等于大盲
  room.actionQueue = rotateFrom(room, room.dealerIdx).filter(i => !room.players[i].folded && !room.players[i].allIn);
  if (room.actionQueue.length === 0) { advanceStreet(room); return; }
  room.turn = room.actionQueue[0];
}

function runShowdown(room) {
  const alive = room.players.filter(p => !p.folded);
  const isOmaha = room.gameType === 'omaha';
  alive.forEach(p => {
    p.handVal = isOmaha ? bestOmaha(p.cards, room.community) : best7([...p.cards, ...room.community]);
    p.handName = p.handVal ? HAND_NAMES[p.handVal[0]] : '';
  });
  const pots = computeSidePots(room.players);
  room.results = [];
  pots.forEach(pot => {
    const eligible = pot.eligible.filter(p => !p.folded);
    let winners = [], bestVal = null;
    eligible.forEach(p => {
      if (!bestVal || compareVal(p.handVal, bestVal) > 0) { bestVal = p.handVal; winners = [p]; }
      else if (compareVal(p.handVal, bestVal) === 0) { winners.push(p); }
    });
    const share = Math.floor(pot.amount / winners.length);
    let rem = pot.amount - share * winners.length;
    winners.forEach((w, i) => { w.chips += share + (i < rem ? 1 : 0); });
    const handName = bestVal ? HAND_NAMES[bestVal[0]] : '';
    room.results.push({ amount: pot.amount, winners: winners.map(w => w.name), handName });
    pushLog(room, `摊牌：${winners.map(w => w.name).join('、')} 以「${handName}」赢得 ${pot.amount}`);
  });
  room.pot = 0; room.stage = 'showdown'; room.turn = null;
}

function applyAction(room, playerId, action, amount) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return { error: '玩家不存在' };
  if (room.stage === 'lobby' || room.stage === 'showdown') return { error: '当前不在下注阶段' };
  if (room.turn !== idx) return { error: '还没轮到你行动' };
  room.lastActedPlayerId = playerId; // 记住"最近做出决策的人"，客户端只让这一个人的筹码闪烁提示
  const p = room.players[idx];

  if (action === 'fold') {
    p.folded = true;
    p.lastAction = 'fold';
    pushLog(room, `${p.name} 弃牌`);
    room.actionQueue = room.actionQueue.filter(i => i !== idx);
    proceed(room); return {};
  }
  if (action === 'check' || action === 'call') {
    const need = room.currentBet - p.betThisStreet;
    if (action === 'check' && need > 0) return { error: '当前有下注，无法过牌' };
    if (need > 0) {
      const pay = Math.min(need, p.chips);
      p.chips -= pay; p.betThisStreet += pay; p.totalContrib += pay; room.pot += pay;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? 'allin' : 'call';
      pushLog(room, `${p.name} 跟注 ${pay}${p.allIn ? '（全下）' : ''}`);
    } else {
      p.lastAction = 'check';
      pushLog(room, `${p.name} 过牌`);
    }
    room.actionQueue = room.actionQueue.filter(i => i !== idx);
    proceed(room); return {};
  }
  if (action === 'raise') {
    const toAmount = Math.floor(amount);
    if (!toAmount || toAmount <= room.currentBet) return { error: '加注金额必须大于当前下注' };
    const capped = Math.min(toAmount, p.betThisStreet + p.chips);
    const need = capped - p.betThisStreet;
    if (need <= 0) return { error: '筹码不足' };
    const minRequired = room.currentBet + (room.minRaise || room.bigBlind);
    const isFullRaise = capped >= minRequired;
    const isAllInShort = capped === p.betThisStreet + p.chips; // 筹码不够标准最小加注额时，允许"短全下"
    if (!isFullRaise && !isAllInShort) {
      return { error: `加注至少要到 ${minRequired}（最小加注额度 ${room.minRaise || room.bigBlind}）` };
    }
    p.chips -= need; p.betThisStreet += need; p.totalContrib += need; room.pot += need;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = p.allIn ? 'allin' : 'raise';
    pushLog(room, `${p.name} 加注到 ${capped}${p.allIn ? '（全下）' : ''}`);
    const isRaise = capped > room.currentBet;
    if (isRaise) {
      if (isFullRaise) room.minRaise = capped - room.currentBet; // 短全下不刷新最小加注标准
      room.currentBet = capped;
      room.actionQueue = rotateFrom(room, idx).filter(i => i !== idx && !room.players[i].folded && !room.players[i].allIn);
    } else {
      room.actionQueue = room.actionQueue.filter(i => i !== idx);
    }
    proceed(room); return {};
  }
  if (action === 'allin') {
    const toAmount = p.betThisStreet + p.chips;
    const need = p.chips;
    if (need <= 0) return { error: '没有可用筹码' };
    p.chips = 0; p.betThisStreet += need; p.totalContrib += need; room.pot += need; p.allIn = true;
    p.lastAction = 'allin';
    pushLog(room, `${p.name} 全下 ${toAmount}`);
    if (toAmount > room.currentBet) {
      const minRequired = room.currentBet + (room.minRaise || room.bigBlind);
      if (toAmount >= minRequired) room.minRaise = toAmount - room.currentBet; // 全下够标准最小加注额，才刷新标准
      room.currentBet = toAmount;
      room.actionQueue = rotateFrom(room, idx).filter(i => i !== idx && !room.players[i].folded && !room.players[i].allIn);
    } else {
      room.actionQueue = room.actionQueue.filter(i => i !== idx);
    }
    proceed(room); return {};
  }
  return { error: '未知操作' };
}

// 生成发给某个观察者(某玩家自己 或 房主)的视图：绝不泄露他人底牌
function serializeForViewer(room, viewerId) {
  return {
    type: 'state',
    roomId: room.id,
    name: room.name,
    stage: room.stage,
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise || room.bigBlind,
    community: room.community || [],
    handNumber: room.handNumber || 0,
    dealerIdx: room.dealerIdx,
    sbIdx: room.sbIdx,
    bbIdx: room.bbIdx,
    turn: room.turn,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    turnTimeLimit: room.turnTimeLimit || 0,
    turnDeadline: room.turnDeadline || null,
    nextHandDeadline: room.nextHandDeadline || null,
    gameType: room.gameType || 'holdem',
    minBuyIn: room.minBuyIn || Math.round(room.startingChips * 0.2),
    log: (room.log || []).slice(0, 10),
    lastActedPlayerId: room.lastActedPlayerId || null,
    you: viewerId,
    players: room.players.map((p, i) => {
      const seated = room.activeSeats ? room.activeSeats.includes(i) : false;
      const revealCards = (p.id === viewerId) || (room.stage === 'showdown' && !p.folded);
      return {
        id: p.id,
        name: p.name,
        chips: p.chips,
        folded: p.folded,
        allIn: p.allIn,
        betThisStreet: p.betThisStreet,
        lastAction: p.lastAction || null,
        connected: !!p.connected,
        hasAccount: !!p.accountUsername,
        needsRebuy: !!p.needsRebuy,
        seated,
        hasCards: !!(p.cards && p.cards.length),
        cards: revealCards ? (p.cards || []) : [],
        handName: (room.stage === 'showdown' && !p.folded) ? (p.handName || null) : null
      };
    }),
    results: room.results || null
  };
}

module.exports = { dealHand, applyAction, serializeForViewer };
