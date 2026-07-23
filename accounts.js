// 账户系统：用户名/密码注册登录，积分持久保存。
// 密码用 Node 内置的 scrypt 加盐哈希，不存明文，不引入额外依赖。
//
// 存储后端二选一：
// - 配置了 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 环境变量：用 Upstash Redis，
//   数据独立于 Render 的磁盘，重新部署/重启都不会丢，推荐生产环境使用。
// - 没配置：退回本地 JSON 文件（data/users.json），适合本地开发测试，
//   但部署平台如果每次重新部署都重置磁盘，数据会丢失。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STARTING_POINTS = 1000;
const USE_REDIS = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let redis = null;
if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  });
}

// ---------------- 本地文件后端（无 Redis 配置时的退路） ----------------
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
let fileUsers = {}; // key: 用户名小写 -> { username, salt, hash, points, token }
let fileSaveTimer = null;

function fileLoad() {
  try { fileUsers = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { fileUsers = {}; }
}
function fileSaveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(fileUsers, null, 2));
  } catch (e) { console.error('保存账户数据失败:', e.message); }
}
function fileSave() {
  clearTimeout(fileSaveTimer);
  fileSaveTimer = setTimeout(fileSaveNow, 500);
}

// ---------------- 通用逻辑 ----------------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function load() {
  if (USE_REDIS) {
    console.log('账户数据存储：Upstash Redis（持久化，重新部署不会丢）');
    return;
  }
  console.log('账户数据存储：本地文件 data/users.json（未配置 Upstash，重新部署可能会丢数据）');
  fileLoad();
}

async function getUser(key) {
  if (USE_REDIS) return await redis.get('user:' + key);
  return fileUsers[key] || null;
}
async function setUser(key, record) {
  if (USE_REDIS) { await redis.set('user:' + key, record); return; }
  fileUsers[key] = record; fileSave();
}
async function setTokenIndex(token, key) {
  if (USE_REDIS) { await redis.set('token:' + token, key); return; }
  // 本地文件模式下，token 直接存在用户记录里，authToken() 走遍历查找即可，不需要额外索引
}
async function getKeyByToken(token) {
  if (USE_REDIS) return await redis.get('token:' + token);
  const found = Object.entries(fileUsers).find(([, u]) => u.token === token);
  return found ? found[0] : null;
}

async function register(username, password) {
  const name = (username || '').trim();
  const key = name.toLowerCase();
  if (name.length < 2 || name.length > 20) return { error: '用户名需要 2-20 个字符' };
  if (!password || password.length < 4) return { error: '密码至少需要 4 位' };
  if (await getUser(key)) return { error: '该用户名已被注册' };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const token = makeToken();
  const record = { username: name, salt, hash, points: STARTING_POINTS, clubPoints: 0, token };
  await setUser(key, record);
  await setTokenIndex(token, key);
  return { username: name, points: STARTING_POINTS, clubPoints: 0, accountToken: token };
}

async function login(username, password) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在，请先注册' };
  if (hashPassword(password, u.salt) !== u.hash) return { error: '密码错误' };
  const token = makeToken();
  u.token = token;
  await setUser(key, u);
  await setTokenIndex(token, key);
  return { username: u.username, points: u.points, clubPoints: u.clubPoints || 0, accountToken: token };
}

async function authToken(token) {
  if (!token) return null;
  const key = await getKeyByToken(token);
  if (!key) return null;
  const u = await getUser(key);
  if (!u) return null;
  return { username: u.username, points: u.points, clubPoints: u.clubPoints || 0 };
}

async function updatePoints(username, points) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return;
  u.points = Math.max(0, Math.round(points));
  await setUser(key, u);
}

// 俱乐部积分：跟桌上筹码积分(points)完全独立的第二种货币，只用来买锦标赛门票。
// delta 可正可负；返回调整后的余额，余额不足时返回 { error }
async function adjustClubPoints(username, delta) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  const next = (u.clubPoints || 0) + delta;
  if (next < 0) return { error: '俱乐部积分不足' };
  u.clubPoints = next;
  await setUser(key, u);
  return { clubPoints: next };
}

async function setClubPoints(username, value) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  u.clubPoints = Math.max(0, Math.round(value));
  await setUser(key, u);
  return { clubPoints: u.clubPoints };
}

async function getAccountInfo(username) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return null;
  return { username: u.username, points: u.points, clubPoints: u.clubPoints || 0 };
}

// ---------------- 管理员（俱乐部后台）----------------
// 独立于普通用户账号，用一个环境变量密码登录；不持久化会话，重启服务需要重新登录。
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pokergo_admin_2026';
const validAdminTokens = new Set();

function adminLogin(password) {
  if (password !== ADMIN_PASSWORD) return { error: '管理员密码错误' };
  const token = makeToken();
  validAdminTokens.add(token);
  return { adminToken: token };
}
function isAdminToken(token) {
  return !!token && validAdminTokens.has(token);
}

module.exports = {
  load, register, login, authToken, updatePoints,
  adjustClubPoints, setClubPoints, getAccountInfo,
  adminLogin, isAdminToken
};
