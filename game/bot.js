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

// 翻牌前手牌强度（0~1），德州按经典起手牌分级思路简化，奥马哈按对子/同花/牌值粗估
function preflopStrength(holeCards, gameType) {
  if (gameType === 'omaha') {
    const ranks = holeCards.map(c => c.r);
    const suits = holeCards.map(c => c.s);
    const hasPair = new Set(ranks).size < ranks.length;
    const hasSuited = new Set(suits).size < suits.length;
    const hi = Math.max(...ranks);
    let score = 0.28 + (hi - 2) / 12 * 0.2 + (hasPair ? 0.15 : 0) + (hasSuited ? 0.1 : 0);
    return Math.min(0.82, score);
  }
  const [a, b] = holeCards;
  const hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
  const pair = a.r === b.r;
  const suited = a.s === b.s;
  const gap = hi - lo;
  let score = (hi - 2) / 12 * 0.32 + (lo - 2) / 12 * 0.14;
  if (pair) score += 0.36 + (hi - 2) / 12 * 0.14;
  if (suited) score += 0.08;
  if (!pair && gap <= 4) score += (5 - gap) * 0.018;
  return Math.min(0.95, Math.max(0.05, score));
}

function handStrength(holeCards, community, gameType) {
  if (!community || community.length === 0) return preflopStrength(holeCards, gameType);
  if (community.length < 3) return 0.35;
  const val = gameType === 'omaha' ? bestOmaha(holeCards, community) : best7([...holeCards, ...community]);
  if (!val) return 0.35;
  return Math.min(1, 0.12 + (val[0] / 8) * 0.75 + Math.random() * 0.05);
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
function decideBotAction(room, player) {
  const gameType = room.gameType === 'omaha' ? 'omaha' : 'holdem';
  const strength = handStrength(player.cards || [], room.community || [], gameType);
  const need = Math.max(0, room.currentBet - player.betThisStreet);
  const pot = Math.max(1, room.pot);
  const potOdds = need > 0 ? need / (pot + need) : 0;
  const canCheck = need <= 0;

  // 加一点随机噪声：同样的牌力不会每次做一模一样的决定，也会有小概率诈唬，
  // 这样机器人才不会被人一眼看穿"牌力等于行为"。
  const noise = (Math.random() - 0.5) * 0.16;
  const s = Math.min(1, Math.max(0, strength + noise));

  if (s > 0.80) {
    if (Math.random() < 0.22 && player.chips <= pot * 1.4) return { action: 'allin' };
    return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * (0.6 + Math.random() * 0.4))));
  }
  if (s > 0.60) {
    if (canCheck) {
      if (Math.random() < 0.5) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * (0.35 + Math.random() * 0.35))));
      return { action: 'check' };
    }
    if (potOdds < 0.42 || Math.random() < 0.2) {
      if (Math.random() < 0.28) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round((pot + need) * (0.5 + Math.random() * 0.3))));
      return { action: need >= player.chips ? 'allin' : 'call' };
    }
    return { action: 'fold' };
  }
  if (s > 0.40) {
    if (canCheck) {
      if (Math.random() < 0.1) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * 0.4)));
      return { action: 'check' };
    }
    if (potOdds < 0.25 || Math.random() < 0.07) return { action: need >= player.chips ? 'allin' : 'call' };
    return { action: 'fold' };
  }
  // 弱牌：能过就过，面对下注大概率弃牌，留一点诈唬概率
  if (canCheck) return { action: 'check' };
  if (Math.random() < 0.05) return clampRaise(room, player, room.currentBet + Math.max(room.bigBlind, Math.round(pot * 0.5)));
  return { action: 'fold' };
}

module.exports = { randomBotName, randomBotStack, decideBotAction, BOT_NAMES };
