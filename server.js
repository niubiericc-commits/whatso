const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { dealHand, applyAction, serializeForViewer } = require('./game/engine');
const accounts = require('./accounts');
const createTournamentModule = require('./tournament');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map(); // roomId -> room
const tm = createTournamentModule({ rooms, dealHand, accounts });

function removeRoom(id) {
  const r = rooms.get(id);
  if (r) { clearTimeout(r.turnTimer); clearTimeout(r.autoNextTimer); }
  rooms.delete(id);
}

function createRoomForTable(t, bucket) {
  const roomId = randomId(6);
  const room = {
    id: roomId,
    name: t.name + ' · 第' + (t.tableIds.length + 1) + '桌',
    hostToken: null,
    hostWs: null,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    startingChips: t.startingChips,
    turnTimeLimit: 30, // 锦标赛桌默认给个思考时间上限，避免有人一直不操作卡住整场比赛
    tournamentId: t.id,
    players: bucket.map(p => ({
      id: randomId(8), name: p.username, token: randomToken(), accountUsername: p.username,
      chips: t.startingChips, cards: [], folded: false, allIn: false, betThisStreet: 0, totalContrib: 0,
      ws: null, connected: true // 默认按“在线”处理，给玩家赶到座位的时间；真掉线后才会走快速托管
    })),
    stage: 'lobby', community: [], pot: 0, currentBet: 0, dealerIdx: null, handNumber: 0
  };
  rooms.set(roomId, room);
  return room;
}

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomId(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}
function randomToken() { return crypto.randomBytes(16).toString('hex'); }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const AUTO_NEXT_HAND_DELAY_MS = 8000; // 摊牌后自动开始下一局的等待时间
const AUTO_PILOT_DELAY_MS = 3000;     // 掉线玩家轮到自己时，托管代打的等待时间（不受房主设置的思考时间限制）

function broadcastRoom(room) {
  scheduleTurnTimer(room);
  scheduleAutoNextHand(room);
  syncPointsOnShowdown(room);
  handleTournamentTable(room);
  if (room.hostWs) send(room.hostWs, serializeForViewer(room, '__host__'));
  room.players.forEach(p => { if (p.ws) send(p.ws, serializeForViewer(room, p.id)); });
}

// 锦标赛桌摊牌后：处理淘汰/并桌，并把受影响的其它桌也重新广播一次
// （用 _tBroadcastGuard 防止两桌同时摊牌时互相触发导致死循环）
function handleTournamentTable(room) {
  if (!room.tournamentId || room.stage !== 'showdown') return;
  if (room._tBroadcastGuard) return;
  room._tBroadcastGuard = true;
  const t = tm.getTournamentByRoom(room);
  tm.onTableSettled(room, { removeRoom });
  if (t) {
    t.tableIds.forEach(rid => {
      if (rid === room.id) return;
      const r = rooms.get(rid);
      if (r) broadcastRoom(r);
    });
  }
  room._tBroadcastGuard = false;
}

// 摊牌结算后，把有账号的玩家当前筹码同步写回账号积分（每一局只同步一次）
function syncPointsOnShowdown(room) {
  if (room.tournamentId) return; // 锦标赛桌的筹码是比赛用的，不同步覆盖现金桌积分
  if (room.stage !== 'showdown') return;
  if (room._pointsSyncedHand === room.handNumber) return;
  room._pointsSyncedHand = room.handNumber;
  room.players.forEach(p => {
    if (p.accountUsername) accounts.updatePoints(p.accountUsername, p.chips).catch(e => console.error('积分同步失败:', e.message));
  });
}

// 思考时间/托管计时器：
// - 在线玩家：按房主设置的思考时间，超时自动执行默认动作（能过牌就过牌，否则弃牌）
// - 掉线玩家（托管中）：不管房主设置了多久，固定用较短的托管延迟，避免拖慢整桌
function scheduleTurnTimer(room) {
  if (room.turn == null || room.stage === 'lobby' || room.stage === 'showdown') {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnDeadline = null;
    room._scheduledTurn = null;
    return;
  }
  const player = room.players[room.turn];
  const isAway = !player || !player.connected;
  const limitMs = isAway ? AUTO_PILOT_DELAY_MS : (room.turnTimeLimit ? room.turnTimeLimit * 1000 : 0);
  if (!limitMs) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnDeadline = null;
    room._scheduledTurn = null;
    return;
  }
  if (room._scheduledTurn === room.turn && room.turnTimer) return; // 同一回合已经在计时，不重复设置
  clearTimeout(room.turnTimer);
  room._scheduledTurn = room.turn;
  room.turnDeadline = isAway ? null : (Date.now() + limitMs); // 托管代打不展示倒计时，直接静默处理
  const turnIdxAtSchedule = room.turn;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.turn !== turnIdxAtSchedule) return; // 这期间已经有人手动操作了，忽略
    const p = room.players[turnIdxAtSchedule];
    if (!p) return;
    const need = room.currentBet - p.betThisStreet;
    applyAction(room, p.id, need > 0 ? 'fold' : 'check', null);
    broadcastRoom(room);
  }, limitMs);
}

// 摊牌后自动开始下一局，不需要房主手动点
function scheduleAutoNextHand(room) {
  if (room.stage !== 'showdown') {
    clearTimeout(room.autoNextTimer);
    room.autoNextTimer = null;
    room.nextHandDeadline = null;
    return;
  }
  if (room.autoNextTimer) return; // 已经在倒计时，不重复设置
  room.nextHandDeadline = Date.now() + AUTO_NEXT_HAND_DELAY_MS;
  room.autoNextTimer = setTimeout(() => {
    room.autoNextTimer = null;
    if (room.stage !== 'showdown') return;
    dealHand(room);
    broadcastRoom(room);
  }, AUTO_NEXT_HAND_DELAY_MS);
}

function requireHost(ws) {
  const room = rooms.get(ws.roomId);
  if (!room || !ws.isHost || room.hostWs !== ws) {
    send(ws, { type: 'error', message: '仅房主可执行该操作' });
    return null;
  }
  return room;
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    handleMessage(ws, msg).catch(e => console.error('处理消息出错:', e));
  });
  ws.on('close', () => handleDisconnect(ws));
});

// 心跳检测：定期 ping 所有连接，代理/浏览器悄悄断开而没触发 close 事件的
// "僵尸连接"会在两次心跳内被发现并强制终止，逼客户端走正常的重连流程，
// 避免出现"一边浏览器实时更新、另一边卡在旧状态"的情况。
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'register': {
      const r = await accounts.register(msg.username, msg.password);
      if (r.error) { send(ws, { type: 'error', message: r.error }); return; }
      send(ws, { type: 'account', username: r.username, points: r.points, clubPoints: r.clubPoints, accountToken: r.accountToken });
      break;
    }
    case 'login': {
      const r = await accounts.login(msg.username, msg.password);
      if (r.error) { send(ws, { type: 'error', message: r.error }); return; }
      send(ws, { type: 'account', username: r.username, points: r.points, clubPoints: r.clubPoints, accountToken: r.accountToken });
      break;
    }
    case 'account_auth': {
      const acc = await accounts.authToken(msg.accountToken);
      if (!acc) { send(ws, { type: 'error', message: '登录状态已失效，请重新登录' }); return; }
      send(ws, { type: 'account', username: acc.username, points: acc.points, clubPoints: acc.clubPoints, accountToken: msg.accountToken });
      break;
    }

    // ---------------- 俱乐部管理员 ----------------
    case 'admin_login': {
      const r = accounts.adminLogin(msg.password);
      if (r.error) { send(ws, { type: 'error', message: r.error }); return; }
      ws.isAdmin = true;
      send(ws, { type: 'admin_ok', adminToken: r.adminToken });
      break;
    }
    case 'admin_create_tournament': {
      if (!accounts.isAdminToken(msg.adminToken)) { send(ws, { type: 'error', message: '管理员身份无效，请重新登录' }); return; }
      const t = tm.createTournament(msg);
      send(ws, { type: 'admin_tournaments', tournaments: tm.listTournaments() });
      break;
    }
    case 'admin_start_tournament': {
      if (!accounts.isAdminToken(msg.adminToken)) { send(ws, { type: 'error', message: '管理员身份无效，请重新登录' }); return; }
      const t = tm.tournaments.get(msg.tournamentId);
      if (!t) { send(ws, { type: 'error', message: '赛事不存在' }); return; }
      const r = tm.startTournament(t, { createRoomForTable });
      if (r && r.error) { send(ws, { type: 'error', message: r.error }); return; }
      send(ws, { type: 'admin_tournaments', tournaments: tm.listTournaments() });
      break;
    }
    case 'admin_list_tournaments': {
      if (!accounts.isAdminToken(msg.adminToken)) { send(ws, { type: 'error', message: '管理员身份无效，请重新登录' }); return; }
      send(ws, { type: 'admin_tournaments', tournaments: tm.listTournaments() });
      break;
    }
    case 'admin_lookup_account': {
      if (!accounts.isAdminToken(msg.adminToken)) { send(ws, { type: 'error', message: '管理员身份无效，请重新登录' }); return; }
      const info = await accounts.getAccountInfo(msg.username);
      if (!info) { send(ws, { type: 'error', message: '账号不存在' }); return; }
      send(ws, { type: 'admin_account_info', ...info });
      break;
    }
    case 'admin_adjust_club_points': {
      if (!accounts.isAdminToken(msg.adminToken)) { send(ws, { type: 'error', message: '管理员身份无效，请重新登录' }); return; }
      const r = await accounts.adjustClubPoints(msg.username, parseInt(msg.delta, 10) || 0);
      if (r.error) { send(ws, { type: 'error', message: r.error }); return; }
      send(ws, { type: 'admin_account_info', username: msg.username, clubPoints: r.clubPoints });
      break;
    }

    // ---------------- 玩家侧：锦标赛报名 ----------------
    case 'tournament_list': {
      send(ws, { type: 'tournament_list', tournaments: tm.listTournaments() });
      break;
    }
    case 'tournament_register': {
      const r = await tm.register(msg.tournamentId, msg.accountToken);
      if (r.error) { send(ws, { type: 'error', message: r.error }); return; }
      send(ws, { type: 'tournament_registered', tournamentId: msg.tournamentId, clubPoints: r.clubPoints });
      break;
    }
    case 'tournament_check_assignment': {
      const t = tm.tournaments.get(msg.tournamentId);
      if (!t) { send(ws, { type: 'error', message: '赛事不存在' }); return; }
      const acc = await accounts.authToken(msg.accountToken);
      if (!acc) { send(ws, { type: 'error', message: '登录状态已失效，请重新登录' }); return; }
      if (t.status === 'finished') {
        send(ws, { type: 'tournament_finished', tournamentId: t.id, results: t.results });
        return;
      }
      if (t.status === 'registering') {
        send(ws, { type: 'tournament_waiting', tournamentId: t.id });
        return;
      }
      const assignment = tm.findAssignment(t, acc.username);
      if (!assignment) {
        // 已开赛但没找到这个人（可能没报上名，或者已经在这场比赛里被淘汰出局）
        const eliminated = t.eliminationOrder.find(e => e.username === acc.username);
        if (eliminated) { send(ws, { type: 'tournament_eliminated', tournamentId: t.id, rank: eliminated.rank }); return; }
        send(ws, { type: 'error', message: '未找到你在本场赛事中的座位' });
        return;
      }
      send(ws, { type: 'tournament_assigned', tournamentId: t.id, roomId: assignment.roomId, playerToken: assignment.playerToken });
      break;
    }
    case 'host_create': {
      const roomId = randomId(6);
      const hostToken = randomToken();
      const room = {
        id: roomId,
        name: (msg.roomName || '德州扑克牌局').slice(0, 40),
        hostToken,
        hostWs: ws,
        smallBlind: Math.max(1, parseInt(msg.smallBlind, 10) || 5),
        bigBlind: Math.max(2, parseInt(msg.bigBlind, 10) || 10),
        startingChips: Math.max(20, parseInt(msg.startingChips, 10) || 1000),
        turnTimeLimit: Math.max(0, parseInt(msg.turnTimeLimit, 10) || 0),
        players: [],
        stage: 'lobby',
        community: [],
        pot: 0,
        currentBet: 0,
        dealerIdx: null,
        handNumber: 0
      };
      rooms.set(roomId, room);
      ws.roomId = roomId; ws.isHost = true;
      send(ws, { type: 'host_created', roomId, hostToken });
      broadcastRoom(room);
      break;
    }
    case 'host_auth': {
      const room = rooms.get(msg.roomId);
      if (!room || room.hostToken !== msg.hostToken) { send(ws, { type: 'error', message: '房间不存在或房主口令错误' }); return; }
      room.hostWs = ws; ws.roomId = room.id; ws.isHost = true;
      broadcastRoom(room);
      break;
    }
    case 'join': {
      const room = rooms.get((msg.roomId || '').toUpperCase());
      if (!room) { send(ws, { type: 'error', message: '房间不存在，请检查房间码' }); return; }
      if (room.players.length >= 9) { send(ws, { type: 'error', message: '房间已满（最多 9 人）' }); return; }

      let accountUsername = null;
      let startChips = room.startingChips;
      if (msg.accountToken) {
        const acc = await accounts.authToken(msg.accountToken);
        if (!acc) { send(ws, { type: 'error', message: '登录状态已失效，请重新登录后再加入' }); return; }
        if (acc.points <= 0) { send(ws, { type: 'error', message: '账号积分为 0，无法入座，请联系房主' }); return; }
        if (room.players.some(p => p.accountUsername === acc.username)) { send(ws, { type: 'error', message: '该账号已经在本房间中' }); return; }
        accountUsername = acc.username;
        startChips = acc.points;
      }

      const name = accountUsername || (msg.name || '').trim().slice(0, 20) || ('玩家' + (room.players.length + 1));
      const id = randomId(8);
      const token = randomToken();
      const player = { id, name, token, accountUsername, chips: startChips, cards: [], folded: false, allIn: false, betThisStreet: 0, totalContrib: 0, ws, connected: true };
      room.players.push(player);
      ws.roomId = room.id; ws.playerId = id;
      send(ws, { type: 'joined', roomId: room.id, playerId: id, playerToken: token, roomName: room.name });
      broadcastRoom(room);
      break;
    }
    case 'rejoin': {
      let room = rooms.get((msg.roomId || '').toUpperCase());
      let player = room && room.players.find(p => p.token === msg.playerToken);
      if (!player) {
        // 记忆里的房间号可能已经失效（比如断线期间被锦标赛并桌挪到了别的桌子），
        // 全局搜一遍所有房间，找到这个 token 真正所在的桌子
        for (const r of rooms.values()) {
          const p = r.players.find(x => x.token === msg.playerToken);
          if (p) { room = r; player = p; break; }
        }
      }
      if (!room || !player) { send(ws, { type: 'error', message: '身份校验失败，请重新加入' }); return; }
      player.ws = ws; player.connected = true;
      ws.roomId = room.id; ws.playerId = player.id;
      if (room.turn === room.players.indexOf(player)) room._scheduledTurn = null; // 重连恢复正常思考时间，不再走托管快速通道
      send(ws, { type: 'joined', roomId: room.id, playerId: player.id, playerToken: player.token, roomName: room.name });
      broadcastRoom(room);
      break;
    }
    case 'host_start':
    case 'host_next_hand': {
      const room = requireHost(ws); if (!room) return;
      if (room.players.length < 2) { send(ws, { type: 'error', message: '至少需要 2 名玩家才能开局' }); return; }
      const result = dealHand(room);
      if (result && result.error) { send(ws, { type: 'error', message: result.error }); }
      broadcastRoom(room);
      break;
    }
    case 'host_kick': {
      const room = requireHost(ws); if (!room) return;
      room.players = room.players.filter(p => p.id !== msg.playerId);
      broadcastRoom(room);
      break;
    }
    case 'host_update_blinds': {
      const room = requireHost(ws); if (!room) return;
      const sb = Math.max(1, parseInt(msg.sb, 10) || room.smallBlind);
      const bb = Math.max(sb + 1, parseInt(msg.bb, 10) || room.bigBlind);
      room.smallBlind = sb; room.bigBlind = bb;
      broadcastRoom(room);
      break;
    }
    case 'host_update_timer': {
      const room = requireHost(ws); if (!room) return;
      room.turnTimeLimit = Math.max(0, parseInt(msg.seconds, 10) || 0);
      broadcastRoom(room);
      break;
    }
    case 'action': {
      const room = rooms.get(ws.roomId);
      if (!room || !ws.playerId) return;
      const result = applyAction(room, ws.playerId, msg.action, msg.amount);
      if (result && result.error) { send(ws, { type: 'error', message: result.error }); return; }
      broadcastRoom(room);
      break;
    }
    default:
      send(ws, { type: 'error', message: '未知消息类型' });
  }
}

function handleDisconnect(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (ws.isHost) {
    if (room.hostWs === ws) room.hostWs = null;
    return;
  }
  if (ws.playerId) {
    const p = room.players.find(x => x.id === ws.playerId);
    if (p) {
      p.connected = false; p.ws = null;
      if (p.accountUsername) accounts.updatePoints(p.accountUsername, p.chips).catch(e => console.error('积分同步失败:', e.message));
      const idx = room.players.indexOf(p);
      if (room.turn === idx) room._scheduledTurn = null; // 强制重新排计时器，走托管快速通道
    }
    broadcastRoom(room);
  }
}

// 定期清理长时间无人（房主和所有玩家都断开）的空房间
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    const anyConnected = room.hostWs || room.players.some(p => p.ws);
    if (!anyConnected) {
      room.emptyStreak = (room.emptyStreak || 0) + 1;
      if (room.emptyStreak > 120) {
        clearTimeout(room.turnTimer);
        clearTimeout(room.autoNextTimer);
        rooms.delete(id);
      }
    } else {
      room.emptyStreak = 0;
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
accounts.load().then(() => {
  server.listen(PORT, () => console.log('德州扑克对战服务已启动，端口 ' + PORT));
}).catch(e => {
  console.error('账户存储初始化失败:', e);
  server.listen(PORT, () => console.log('德州扑克对战服务已启动（账户存储初始化有误），端口 ' + PORT));
});
