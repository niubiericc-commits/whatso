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
const COUPON_FILE = path.join(DATA_DIR, 'coupons.json');
const PROMO_FILE = path.join(DATA_DIR, 'promotion.json');
const LEVELS_FILE = path.join(DATA_DIR, 'levels.json');
const SHOP_FILE = path.join(DATA_DIR, 'shop.json');
let fileUsers = {}; // key: 用户名小写 -> { username, salt, hash, points, token, avatar, history, coupons, rewards, tier, growth, level }
let fileCoupons = {}; // code -> { code, amount, active }
const DEFAULT_PROMOTION = { announcement: { title: '', body: '' }, packages: [], tiers: { VIP: '', SVIP: '' } };
let filePromotion = JSON.parse(JSON.stringify(DEFAULT_PROMOTION));
let fileLevels = []; // [{level, threshold, rewardText, rewardClubPoints}]
let fileShop = []; // [{id, name, costGrowth, rewardClubPoints, note}]
let fileSaveTimer = null, fileCouponSaveTimer = null, filePromoSaveTimer = null, fileLevelsSaveTimer = null, fileShopSaveTimer = null;

function fileLoad() {
  try { fileUsers = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { fileUsers = {}; }
  try { fileCoupons = JSON.parse(fs.readFileSync(COUPON_FILE, 'utf8')); }
  catch (e) { fileCoupons = {}; }
  try { filePromotion = JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8')); }
  catch (e) { filePromotion = JSON.parse(JSON.stringify(DEFAULT_PROMOTION)); }
  try { fileLevels = JSON.parse(fs.readFileSync(LEVELS_FILE, 'utf8')); }
  catch (e) { fileLevels = []; }
  try { fileShop = JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8')); }
  catch (e) { fileShop = []; }
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
function fileCouponSaveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COUPON_FILE, JSON.stringify(fileCoupons, null, 2));
  } catch (e) { console.error('保存优惠券数据失败:', e.message); }
}
function fileCouponSave() {
  clearTimeout(fileCouponSaveTimer);
  fileCouponSaveTimer = setTimeout(fileCouponSaveNow, 500);
}
function filePromoSaveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROMO_FILE, JSON.stringify(filePromotion, null, 2));
  } catch (e) { console.error('保存推广信息失败:', e.message); }
}
function filePromoSave() {
  clearTimeout(filePromoSaveTimer);
  filePromoSaveTimer = setTimeout(filePromoSaveNow, 500);
}
function fileLevelsSaveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEVELS_FILE, JSON.stringify(fileLevels, null, 2));
  } catch (e) { console.error('保存等级配置失败:', e.message); }
}
function fileLevelsSave() {
  clearTimeout(fileLevelsSaveTimer);
  fileLevelsSaveTimer = setTimeout(fileLevelsSaveNow, 500);
}
function fileShopSaveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SHOP_FILE, JSON.stringify(fileShop, null, 2));
  } catch (e) { console.error('保存商城配置失败:', e.message); }
}
function fileShopSave() {
  clearTimeout(fileShopSaveTimer);
  fileShopSaveTimer = setTimeout(fileShopSaveNow, 500);
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

async function getCoupon(code) {
  if (USE_REDIS) return await redis.get('coupon:' + code);
  return fileCoupons[code] || null;
}
async function setCoupon(code, record) {
  if (USE_REDIS) { await redis.set('coupon:' + code, record); return; }
  fileCoupons[code] = record; fileCouponSave();
}
async function getPromotion() {
  if (USE_REDIS) return (await redis.get('promotion')) || JSON.parse(JSON.stringify(DEFAULT_PROMOTION));
  return filePromotion;
}
async function savePromotion(record) {
  if (USE_REDIS) { await redis.set('promotion', record); return; }
  filePromotion = record; filePromoSave();
}
async function setAnnouncement(title, body) {
  const p = await getPromotion();
  p.announcement = { title: (title || '').slice(0, 60), body: (body || '').slice(0, 2000) };
  await savePromotion(p);
  return p;
}
async function addPackage(pkg) {
  const p = await getPromotion();
  const id = 'PKG' + Math.random().toString(36).slice(2, 8).toUpperCase();
  p.packages = p.packages || [];
  p.packages.push({
    id,
    amountRMB: Math.max(0, Math.round(Number(pkg.amountRMB) || 0)),
    tickets: Math.max(0, Math.round(Number(pkg.tickets) || 0)),
    clubPoints: Math.max(0, Math.round(Number(pkg.clubPoints) || 0)),
    note: (pkg.note || '').slice(0, 100)
  });
  await savePromotion(p);
  return p;
}
async function removePackage(id) {
  const p = await getPromotion();
  p.packages = (p.packages || []).filter(x => x.id !== id);
  await savePromotion(p);
  return p;
}
async function setTierInfo(tier, text) {
  const p = await getPromotion();
  p.tiers = p.tiers || {};
  p.tiers[tier] = (text || '').slice(0, 500);
  await savePromotion(p);
  return p;
}

// ---------------- 等级配置（消费换算成长值，达到门槛自动升级发奖励）----------------
async function getLevels() {
  if (USE_REDIS) return (await redis.get('levels')) || [];
  return fileLevels;
}
async function saveLevels(list) {
  if (USE_REDIS) { await redis.set('levels', list); return; }
  fileLevels = list; fileLevelsSave();
}
async function addLevel(level, threshold, rewardText, rewardClubPoints) {
  const list = await getLevels();
  const lv = Math.max(1, Math.round(Number(level) || 0));
  const filtered = list.filter(x => x.level !== lv);
  filtered.push({
    level: lv,
    threshold: Math.max(0, Math.round(Number(threshold) || 0)),
    rewardText: (rewardText || '').slice(0, 100),
    rewardClubPoints: Math.max(0, Math.round(Number(rewardClubPoints) || 0))
  });
  filtered.sort((a, b) => a.level - b.level);
  await saveLevels(filtered);
  return filtered;
}
async function removeLevel(level) {
  const list = await getLevels();
  const filtered = list.filter(x => x.level !== Math.round(Number(level)));
  await saveLevels(filtered);
  return filtered;
}

// ---------------- 积分商城（成长值兑换奖品/门票对应的俱乐部积分）----------------
async function getShop() {
  if (USE_REDIS) return (await redis.get('shop')) || [];
  return fileShop;
}
async function saveShop(list) {
  if (USE_REDIS) { await redis.set('shop', list); return; }
  fileShop = list; fileShopSave();
}
async function addShopItem(item) {
  const list = await getShop();
  const id = 'SHOP' + Math.random().toString(36).slice(2, 8).toUpperCase();
  list.push({
    id,
    name: (item.name || '').slice(0, 60),
    costGrowth: Math.max(1, Math.round(Number(item.costGrowth) || 0)),
    rewardClubPoints: Math.max(0, Math.round(Number(item.rewardClubPoints) || 0)),
    note: (item.note || '').slice(0, 100)
  });
  await saveShop(list);
  return list;
}
async function removeShopItem(id) {
  const list = await getShop();
  const filtered = list.filter(x => x.id !== id);
  await saveShop(filtered);
  return filtered;
}

// 记录一笔"消费"（管理员帮玩家线下转账后录入）：1元 = 1 成长值，累计到等级门槛自动升级发奖励
async function recordSpend(username, amountRMB, note) {
  const amt = Math.max(0, Math.round(Number(amountRMB) || 0));
  if (amt <= 0) return { error: '金额必须大于 0' };
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  u.growth = (u.growth || 0) + amt;
  u.level = u.level || 0;
  pushHistory(u, { kind: 'growth', delta: amt, balance: u.growth, note: note || ('充值 ¥' + amt) });

  const levels = await getLevels();
  const eligible = levels.filter(l => u.growth >= l.threshold && l.level > u.level).sort((a, b) => a.level - b.level);
  for (const lv of eligible) {
    u.level = lv.level;
    if (lv.rewardClubPoints > 0) {
      u.clubPoints = (u.clubPoints || 0) + lv.rewardClubPoints;
      pushHistory(u, { kind: 'club', delta: lv.rewardClubPoints, balance: u.clubPoints, note: '升级到 Lv.' + lv.level + ' 奖励' });
    }
    u.rewards = u.rewards || [];
    u.rewards.unshift({ time: Date.now(), kind: 'level', level: lv.level, prize: lv.rewardText || ('Lv.' + lv.level + ' 奖励') });
    if (u.rewards.length > 50) u.rewards.length = 50;
  }

  await setUser(key, u);
  return { growth: u.growth, level: u.level, clubPoints: u.clubPoints };
}

async function redeemShopItem(username, itemId) {
  const list = await getShop();
  const item = list.find(x => x.id === itemId);
  if (!item) return { error: '商品不存在' };
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  if ((u.growth || 0) < item.costGrowth) return { error: '成长值不足' };
  u.growth -= item.costGrowth;
  if (item.rewardClubPoints > 0) u.clubPoints = (u.clubPoints || 0) + item.rewardClubPoints;
  pushHistory(u, { kind: 'growth', delta: -item.costGrowth, balance: u.growth, note: '兑换：' + item.name });
  u.rewards = u.rewards || [];
  u.rewards.unshift({ time: Date.now(), kind: 'shop', prize: item.name + (item.note ? '（' + item.note + '）' : '') });
  if (u.rewards.length > 50) u.rewards.length = 50;
  await setUser(key, u);
  return { growth: u.growth, clubPoints: u.clubPoints };
}

function pushHistory(u, entry) {
  u.history = u.history || [];
  u.history.unshift(Object.assign({ time: Date.now() }, entry));
  if (u.history.length > 50) u.history.length = 50;
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
  const record = { username: name, salt, hash, points: STARTING_POINTS, clubPoints: 0, token, avatar: '🂠', history: [], coupons: [], rewards: [] };
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
  const next = Math.max(0, Math.round(points));
  const delta = next - (u.points || 0);
  if (delta !== 0) pushHistory(u, { kind: 'points', delta, balance: next, note: '现金桌筹码结算' });
  u.points = next;
  await setUser(key, u);
}

// 俱乐部积分：跟桌上筹码积分(points)完全独立的第二种货币，只用来买锦标赛门票。
// delta 可正可负；返回调整后的余额，余额不足时返回 { error }
async function adjustClubPoints(username, delta, note) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  const next = (u.clubPoints || 0) + delta;
  if (next < 0) return { error: '俱乐部积分不足' };
  pushHistory(u, { kind: 'club', delta, balance: next, note: note || (delta >= 0 ? '管理员发放' : '扣减') });
  u.clubPoints = next;
  await setUser(key, u);
  return { clubPoints: next };
}

async function setClubPoints(username, value) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  const next = Math.max(0, Math.round(value));
  const delta = next - (u.clubPoints || 0);
  if (delta !== 0) pushHistory(u, { kind: 'club', delta, balance: next, note: '现金桌筹码结算' });
  u.clubPoints = next;
  await setUser(key, u);
  return { clubPoints: u.clubPoints };
}

async function getAccountInfo(username) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return null;
  return { username: u.username, points: u.points, clubPoints: u.clubPoints || 0, tier: u.tier || 'none', growth: u.growth || 0, level: u.level || 0 };
}

// 完整的个人中心资料：余额 + 头像 + 交易记录 + 优惠券 + 获奖记录 + 会员等级 + 成长值/等级
async function getProfile(username) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return null;
  return {
    username: u.username,
    points: u.points,
    clubPoints: u.clubPoints || 0,
    avatar: u.avatar || '🂠',
    tier: u.tier || 'none',
    growth: u.growth || 0,
    level: u.level || 0,
    history: u.history || [],
    coupons: u.coupons || [],
    rewards: u.rewards || []
  };
}

async function setMemberTier(username, tier) {
  const t = ['none', 'VIP', 'SVIP'].includes(tier) ? tier : 'none';
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  u.tier = t;
  pushHistory(u, { kind: 'tier', delta: 0, balance: u.clubPoints || 0, note: '会员等级变更为 ' + (t === 'none' ? '普通用户' : t) });
  await setUser(key, u);
  return { tier: t };
}

async function setAvatar(username, avatar) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  u.avatar = String(avatar || '🂠').slice(0, 8);
  await setUser(key, u);
  return { avatar: u.avatar };
}

// 优惠券：管理员创建兑换码，玩家凭码兑换俱乐部积分，每个账号每个码只能兑换一次
async function createCoupon(code, amount) {
  const c = (code || '').trim().toUpperCase();
  if (c.length < 3) return { error: '兑换码至少 3 个字符' };
  if (!amount || amount <= 0) return { error: '面额必须大于 0' };
  const existing = await getCoupon(c);
  if (existing) return { error: '这个兑换码已经存在' };
  await setCoupon(c, { code: c, amount, active: true });
  return { code: c, amount };
}

async function redeemCoupon(username, code) {
  const c = (code || '').trim().toUpperCase();
  const coupon = await getCoupon(c);
  if (!coupon || !coupon.active) return { error: '兑换码无效或已失效' };
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return { error: '账号不存在' };
  u.coupons = u.coupons || [];
  if (u.coupons.some(x => x.code === c)) return { error: '这个兑换码你已经用过了' };
  u.coupons.unshift({ code: c, amount: coupon.amount, time: Date.now() });
  u.clubPoints = (u.clubPoints || 0) + coupon.amount;
  pushHistory(u, { kind: 'club', delta: coupon.amount, balance: u.clubPoints, note: '兑换码 ' + c });
  await setUser(key, u);
  return { clubPoints: u.clubPoints, amount: coupon.amount };
}

// 获奖记录：锦标赛结束时，给前三名各自的账号写一条记录
async function addReward(username, entry) {
  const key = (username || '').trim().toLowerCase();
  const u = await getUser(key);
  if (!u) return;
  u.rewards = u.rewards || [];
  u.rewards.unshift(Object.assign({ time: Date.now() }, entry));
  if (u.rewards.length > 50) u.rewards.length = 50;
  await setUser(key, u);
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
  adminLogin, isAdminToken,
  getProfile, setAvatar, createCoupon, redeemCoupon, addReward,
  getPromotion, setAnnouncement, addPackage, removePackage, setTierInfo,
  setMemberTier,
  getLevels, addLevel, removeLevel, getShop, addShopItem, removeShopItem,
  recordSpend, redeemShopItem
};
