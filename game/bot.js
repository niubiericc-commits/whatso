// 机器人玩家：用于给现金桌补位。身份随机生成，打法基于牌力评估 + 底池赔率 + 一定随机性
// （避免打法太机械可预测），不是简单的乱按，也不是完美 GTO 解，是一套实用的启发式策略。
const { best7, bestOmaha } = require('./handEval');

const BOT_NAMES = [
  'Mike_23','PokerFace99','LuckyAce7','ChipLeader','RiverRat88','AllInAndy',
  'QueenOfHearts','BluffMaster77','SilentShark','NightOwl42','FoldEmFast','TightTyler',
  'AceHunter','GrinderGreg','StackDaddy','ValueTown','PocketRockets','DonkBuster',
  'CoolHandLuke','RiverKing88','ShoveOrFold','TableCaptain','CalmChris','SharkBait99',
  'BigBlindBob','FelixTheFish','RangeReader','PotOddsPro','TiltProof','LateNightGrind',
  'JennyJacks','SammyShoves','TacticalTom','QuietQueen','BayouBluffer','MidnightRiver'
];

function randomBotName(usedNames) {
  const used = usedNames || new Set();
  const pool = BOT_NAMES.filter(n => !used.has(n));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  return 'Player' + Math.floor(1000 + Math.random() * 9000);
}

// 20000-40000 之间随机取整千
function randomBotStack() {
  return Math.floor((20000 + Math.random() * 20000) / 100) * 100;
}

// 翻牌前手牌强度（0~1）：对子按牌值线性给分，非对子看两张最大牌+顺位/花色加成，
// 参照的是"AK、中大对子都算强牌"这类常识分级，不是随手给的数字。
function preflopStrength(holeCards, gameType) {
  if (gameType === 'omaha') {
    const ranks = holeCards.map(c => c.r);
    const suits = holeCards.map(c => c.s);
    const hasPair = new Set(ranks).size < ranks.length;
    const hasSuited = new Set(suits).size < suits.length;
    const hi = Math.max(...ranks);
    let score = 0.32 + (hi - 2) / 12 * 0.22 + (hasPair ? 0.18 : 0) + (hasSuited ? 0.12 : 0);
    return Math.min(0.88, score);
  }
  const [a, b] = holeCards;
  const hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
  const pair = a.r === b.r;
  const suited = a.s === b.s;
  const gap = hi - lo;
  let score;
  if (pair) {
    // 22≈0.35（凑set用，仍可跟）～AA≈0.95
    score = 0.35 + (hi - 2) / 12 * 0.60;
  } else {
    score = (hi - 2) / 12 * 0.42 + (lo - 2) / 12 * 0.20;
    if (suited) score += 0.07;
    if (gap === 1) score += 0.05;
    else if (gap === 2) score += 0.03;
    else if (gap <= 4) score += 0.01;
    if (hi === 14) score += 0.05; // 带A的牌额外加分（AK/AQ这类）
  }
  return Math.min(0.95, Math.max(0.08, score));
}

// 翻牌后手牌强度：把牌型等级(0高牌~8同花顺)映射到分数，起点抬高一些，
// 避免"随便一对"被算得过弱、一遇下注就弃牌。
function handStrength(holeCards, community, gameType) {
  if (!community || community.length === 0) return preflopStrength(holeCards, gameType);
  if (community.length < 3) return 0.4;
  const val = gameType === 'omaha' ? bestOmaha(holeCards, community) : best7([...holeCards, ...community]);
  if (!val) return 0.4;
  return Math.min(1, 0.22 + (val[0] / 8) * 0.68 + Math.random() * 0.05);
}

function clampRaise(room, player, raiseTo) {
  const maxTo = player.betThisStreet + player.chips;
  if (raiseTo >= maxTo) return { action: 'allin' };
  const minTo = room.currentBet + 1;
  raiseTo = Math.max(Math.floor(raiseTo), minTo);
  if (raiseTo >= maxTo) return { action: 'allin' };
  return { action: 'raise', amount: raiseTo };
}

// 决定机器人这一步怎么做。room/player 是服务端的实时状态对象。
// 跟注门槛比早期版本松了不少——早期版本对"中等牌力"要求底池赔率<25%才跟，
// 现实里这几乎等于"一加注就弃"，这次调宽到接近正常人的松紧度。
function decideBotAction(room, player) {
  const gameType = room.gameType === 'omaha' ? 'omaha' : 'holdem';
  const strength = handStrength(player.cards || [], room.community || [], gameType);
  const need = Math.max(0, room.currentBet - player.betThisStreet);
  const pot = Math.max(1, room.pot);
  const potOdds = need > 0 ? need / (pot + need) : 0;
  const canCheck = need <= 0;

  // 加一点随机噪声：同样的牌力不会每次做一模一样的决定，也会有小概率诈唬，
  // 这样机器人才不会被人一眼看穿"牌力等于行为"。
  const noise = (Math.random() - 0.5) * 0.14;
  const s = Math.min(1, Math.max(0, strength + noise));

  if (s > 0.75) {
    if (Math.random() < 0.22 && player.chips <= pot * 1.4) return { action: 'allin' };
    return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * (0.6 + Math.random() * 0.4))));
  }
  if (s > 0.55) {
    if (canCheck) {
      if (Math.random() < 0.5) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * (0.35 + Math.random() * 0.35))));
      return { action: 'check' };
    }
    // 强牌面对下注：底池赔率只要不离谱就跟，偶尔反加
    if (potOdds < 0.55 || Math.random() < 0.15) {
      if (Math.random() < 0.25) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round((pot + need) * (0.5 + Math.random() * 0.3))));
      return { action: need >= player.chips ? 'allin' : 'call' };
    }
    return { action: 'fold' };
  }
  if (s > 0.32) {
    if (canCheck) {
      if (Math.random() < 0.1) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * 0.4)));
      return { action: 'check' };
    }
    // 中等牌力：只要不是被下重注（need 不超过底池的一半左右），愿意跟
    if (potOdds < 0.4 || Math.random() < 0.12) return { action: need >= player.chips ? 'allin' : 'call' };
    return { action: 'fold' };
  }
  // 弱牌：能过就过，面对下注大概率弃牌，留一点诈唬概率
  if (canCheck) return { action: 'check' };
  if (potOdds < 0.15) return { action: 'call' }; // 便宜到几乎不用弃的价钱，跟一手
  if (Math.random() < 0.06) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * 0.5)));
  return { action: 'fold' };
}

module.exports = { randomBotName, randomBotStack, decideBotAction, BOT_NAMES };
