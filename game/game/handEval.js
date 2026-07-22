// 德州扑克 - 算牌核心（服务端权威计算，客户端不参与）
const SUITS = ['s', 'h', 'd', 'c']; // 黑桃 红桃 方块 梅花
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function newDeck() {
  const d = [];
  SUITS.forEach(s => { for (let r = 2; r <= 14; r++) d.push({ r, s }); });
  return d;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function combinations(arr, k) {
  const res = [];
  (function helper(start, combo) {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  })(0, []);
  return res;
}

function handValue(cards5) {
  const ranks = cards5.map(c => c.r).sort((a, b) => b - a);
  const suits = cards5.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  let uniq = [...new Set(ranks)], isStraight = false, straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) { isStraight = true; straightHigh = 5; }
  }
  const counts = {}; ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r, c]) => ({ r: +r, c })).sort((a, b) => b.c - a.c || b.r - a.r);
  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0].c === 4) return [7, groups[0].r, groups[1].r];
  if (groups[0].c === 3 && groups[1] && groups[1].c === 2) return [6, groups[0].r, groups[1].r];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0].c === 3) return [3, groups[0].r, ...groups.slice(1).map(g => g.r)];
  if (groups[0].c === 2 && groups[1] && groups[1].c === 2) return [2, Math.max(groups[0].r, groups[1].r), Math.min(groups[0].r, groups[1].r), groups[2].r];
  if (groups[0].c === 2) return [1, groups[0].r, ...groups.slice(1).map(g => g.r)];
  return [0, ...ranks];
}

function compareVal(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function best7(cards7) {
  let best = null;
  combinations(cards7, 5).forEach(c => {
    const v = handValue(c);
    if (!best || compareVal(v, best) > 0) best = v;
  });
  return best;
}

function computeSidePots(players) {
  let contribs = players.filter(p => p.totalContrib > 0).map(p => ({ p, amt: p.totalContrib }));
  const pots = [];
  while (contribs.length) {
    const min = Math.min(...contribs.map(c => c.amt));
    const potSize = min * contribs.length;
    const eligible = contribs.filter(c => !c.p.folded).map(c => c.p);
    pots.push({ amount: potSize, eligible });
    contribs = contribs.map(c => ({ p: c.p, amt: c.amt - min })).filter(c => c.amt > 0);
  }
  return pots;
}

module.exports = { newDeck, shuffle, best7, compareVal, computeSidePots, HAND_NAMES };
