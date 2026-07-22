const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { dealHand, applyAction, serializeForViewer } = require('./game/engine');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map(); // roomId -> room

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

function broadcastRoom(room) {
  scheduleTurnTimer(room);
  scheduleAutoNextHand(room);
  if (room.hostWs) send(room.hostWs, serializeForViewer(room, '__host__'));
  room.players.forEach(p => { if (p.ws) send(p.ws, serializeForViewer(room, p.id)); });
}

// 思考时间计时器：轮到某人时若设置了限时，超时自动执行默认动作（能过牌就过牌，否则弃牌）
function scheduleTurnTimer(room) {
  if (room.turn == null || room.stage === 'lobby' || room.stage === 'showdown' || !room.turnTimeLimit) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnDeadline = null;
    room._scheduledTurn = null;
    return;
  }
  if (room._scheduledTurn === room.turn && room.turnTimer) return; // 同一回合已经在计时，不重复设置
  clearTimeout(room.turnTimer);
  room._scheduledTurn = room.turn;
  room.turnDeadline = Date.now() + room.turnTimeLimit * 1000;
  const turnIdxAtSchedule = room.turn;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.turn !== turnIdxAtSchedule) return; // 这期间已经有人手动操作了，忽略
    const player = room.players[turnIdxAtSchedule];
    if (!player) return;
    const need = room.currentBet - player.betThisStreet;
    applyAction(room, player.id, need > 0 ? 'fold' : 'check', null);
    broadcastRoom(room);
  }, room.turnTimeLimit * 1000);
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
    handleMessage(ws, msg);
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

function handleMessage(ws, msg) {
  switch (msg.type) {
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
      const name = (msg.name || '').trim().slice(0, 20) || ('玩家' + (room.players.length + 1));
      const id = randomId(8);
      const token = randomToken();
      const player = { id, name, token, chips: room.startingChips, cards: [], folded: false, allIn: false, betThisStreet: 0, totalContrib: 0, ws, connected: true };
      room.players.push(player);
      ws.roomId = room.id; ws.playerId = id;
      send(ws, { type: 'joined', roomId: room.id, playerId: id, playerToken: token, roomName: room.name });
      broadcastRoom(room);
      break;
    }
    case 'rejoin': {
      const room = rooms.get((msg.roomId || '').toUpperCase());
      if (!room) { send(ws, { type: 'error', message: '房间不存在' }); return; }
      const player = room.players.find(p => p.token === msg.playerToken);
      if (!player) { send(ws, { type: 'error', message: '身份校验失败，请重新加入' }); return; }
      player.ws = ws; player.connected = true;
      ws.roomId = room.id; ws.playerId = player.id;
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
    if (p) { p.connected = false; p.ws = null; }
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
server.listen(PORT, () => console.log('德州扑克对战服务已启动，端口 ' + PORT));
