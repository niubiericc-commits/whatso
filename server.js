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

function broadcastRoom(room) {
  if (room.hostWs) send(room.hostWs, serializeForViewer(room, '__host__'));
  room.players.forEach(p => { if (p.ws) send(p.ws, serializeForViewer(room, p.id)); });
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
      if (room.stage !== 'lobby') { send(ws, { type: 'error', message: '牌局已开始，暂时无法加入，请等待下一局' }); return; }
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
      if (room.emptyStreak > 120) rooms.delete(id); // 约 1 小时无人连接后清理
    } else {
      room.emptyStreak = 0;
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('德州扑克对战服务已启动，端口 ' + PORT));
