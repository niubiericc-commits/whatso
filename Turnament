// 多桌锦标赛引擎。
// 每一桌复用主程序里现成的"房间"(room)对象和德州扑克引擎(dealHand/applyAction)，
// 本模块只负责：报名收门票、开赛分桌、每手结束后检查淘汰、桌间人数平衡与并桌、
// 决出冠亚季军并对应到设置好的奖品。
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomId(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

module.exports = function createTournamentModule(deps) {
  const { rooms, dealHand, accounts } = deps;

  const tournaments = new Map(); // id -> tournament

  function createTournament(opts) {
    const id = 'T' + randomId(5);
    const t = {
      id,
      name: (opts.name || '定制锦标赛').slice(0, 40),
      ticketPrice: Math.max(0, parseInt(opts.ticketPrice, 10) || 0),
      prizes: {
        1: (opts.prize1 || '').slice(0, 60) || '冠军奖品',
        2: (opts.prize2 || '').slice(0, 60) || '亚军奖品',
        3: (opts.prize3 || '').slice(0, 60) || '季军奖品'
      },
      startingChips: Math.max(20, parseInt(opts.startingChips, 10) || 1000),
      smallBlind: Math.max(1, parseInt(opts.smallBlind, 10) || 5),
      bigBlind: Math.max(2, parseInt(opts.bigBlind, 10) || 10),
      maxTableSize: Math.min(9, Math.max(2, parseInt(opts.maxTableSize, 10) || 6)),
      status: 'registering',
      registered: [],
      tableIds: [],
      eliminationOrder: [],
      results: null,
      createdAt: Date.now()
    };
    tournaments.set(id, t);
    return t;
  }

  function listTournaments() {
    return Array.from(tournaments.values()).map(publicView);
  }

  function publicView(t) {
    return {
      id: t.id, name: t.name, ticketPrice: t.ticketPrice, prizes: t.prizes,
      startingChips: t.startingChips, smallBlind: t.smallBlind, bigBlind: t.bigBlind,
      maxTableSize: t.maxTableSize, status: t.status,
      registeredCount: t.registered.length,
      remainingCount: t.status === 'running' ? countRemaining(t) : t.registered.length,
      results: t.results
    };
  }

  function countRemaining(t) {
    return t.tableIds.reduce((sum, rid) => {
      const r = rooms.get(rid);
      return sum + (r ? r.players.filter(p => p.chips > 0).length : 0);
    }, 0);
  }

  async function register(tournamentId, accountToken) {
    const t = tournaments.get(tournamentId);
    if (!t) return { error: '赛事不存在' };
    if (t.status !== 'registering') return { error: '该赛事已开赛或已结束，无法报名' };
    const acc = await accounts.authToken(accountToken);
    if (!acc) return { error: '登录状态已失效，请重新登录' };
    if (t.registered.some(r => r.username === acc.username)) return { error: '你已经报过名了' };
    const pay = await accounts.adjustClubPoints(acc.username, -t.ticketPrice);
    if (pay.error) return { error: '俱乐部积分不足，无法购买门票（需要 ' + t.ticketPrice + '，当前 ' + acc.clubPoints + '）' };
    t.registered.push({ username: acc.username });
    return { ok: true, clubPoints: pay.clubPoints };
  }

  function findAssignment(t, username) {
    if (!t) return null;
    for (const rid of t.tableIds) {
      const r = rooms.get(rid);
      if (!r) continue;
      const p = r.players.find(x => x.accountUsername === username);
      if (p) return { roomId: rid, playerToken: p.token, playerId: p.id };
    }
    return null;
  }

  function startTournament(t, ctx) {
    const { createRoomForTable } = ctx;
    if (t.status !== 'registering') return { error: '赛事状态不对，无法开始' };
    if (t.registered.length < 2) return { error: '报名人数不足 2 人，无法开赛' };

    const numTables = Math.max(1, Math.ceil(t.registered.length / t.maxTableSize));
    const shuffled = shuffle(t.registered);
    const buckets = Array.from({ length: numTables }, () => []);
    shuffled.forEach((p, i) => buckets[i % numTables].push(p));

    buckets.forEach(bucket => {
      const room = createRoomForTable(t, bucket);
      t.tableIds.push(room.id);
    });

    t.status = 'running';
    t.tableIds.forEach(rid => {
      const room = rooms.get(rid);
      if (room) dealHand(room);
    });
    return { ok: true };
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function getTournamentByRoom(room) {
    if (!room || !room.tournamentId) return null;
    return tournaments.get(room.tournamentId) || null;
  }

  function onTableSettled(room, ctx) {
    const t = getTournamentByRoom(room);
    if (!t || t.status !== 'running') return;
    if (room._tSyncedHand === room.handNumber) return;
    room._tSyncedHand = room.handNumber;

    const busted = room.players.filter(p => p.chips <= 0 && !p._tEliminated);
    if (busted.length) {
      const remainingBefore = countRemaining(t);
      busted.forEach(p => {
        p._tEliminated = true;
        t.eliminationOrder.unshift({ username: p.accountUsername || p.name, rank: remainingBefore, time: Date.now() });
      });
      room.players = room.players.filter(p => !p._tEliminated);
    }

    const remaining = countRemaining(t);
    if (remaining <= 1) {
      finishTournament(t, room);
      return;
    }

    rebalanceTournament(t, ctx);
  }

  function finishTournament(t, lastRoom) {
    t.status = 'finished';
    const champion = lastRoom.players.find(p => p.chips > 0);
    const byPlace = {};
    if (champion) byPlace[1] = { username: champion.accountUsername || champion.name, prize: t.prizes[1] };
    const secondEntry = t.eliminationOrder.find(e => e.rank === 2);
    const thirdEntry = t.eliminationOrder.find(e => e.rank === 3);
    if (secondEntry) byPlace[2] = { username: secondEntry.username, prize: t.prizes[2] };
    if (thirdEntry) byPlace[3] = { username: thirdEntry.username, prize: t.prizes[3] };
    t.results = byPlace;

    t.tableIds.forEach(rid => rooms.delete(rid));
    t.tableIds = [];
  }

  function movePlayer(p, destRoom) {
    if (p.ws) p.ws.roomId = destRoom.id; // 关键：同步在线连接指向新桌子，否则玩家的操作会发到旧桌子
    destRoom.players.push(p);
  }

  function rebalanceTournament(t, ctx) {
    const { removeRoom } = ctx;
    const tables = t.tableIds.map(rid => rooms.get(rid)).filter(Boolean);
    if (tables.length <= 1) return;

    const safe = tables.filter(r => r.stage === 'lobby' || r.stage === 'showdown');
    if (safe.length === 0) return;

    const totalActive = tables.reduce((s, r) => s + r.players.filter(p => p.chips > 0).length, 0);
    const idealTables = Math.max(1, Math.ceil(totalActive / t.maxTableSize));

    if (tables.length > idealTables) {
      const target = safe.slice().sort((a, b) => a.players.length - b.players.length)[0];
      if (target) {
        const others = tables.filter(r => r !== target);
        target.players.forEach(p => {
          const dest = others.sort((a, b) => a.players.length - b.players.length)[0];
          if (dest) movePlayer(p, dest);
        });
        target.players = [];
        t.tableIds = t.tableIds.filter(rid => rid !== target.id);
        removeRoom(target.id);
        return;
      }
    }

    const sorted = tables.slice().sort((a, b) => a.players.length - b.players.length);
    const smallest = sorted[0], largest = sorted[sorted.length - 1];
    if (largest.players.length - smallest.players.length >= 2 && (safe.includes(smallest) || safe.includes(largest))) {
      const donor = safe.includes(largest) ? largest : null;
      if (donor && donor.players.length > 1) {
        const moved = donor.players.pop();
        movePlayer(moved, smallest);
      }
    }
  }

  return {
    tournaments, createTournament, listTournaments, publicView,
    register, findAssignment, startTournament, onTableSettled, getTournamentByRoom
  };
};
