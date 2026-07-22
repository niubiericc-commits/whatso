# 德州扑克真人手机对战 · 服务端

这是一个带真正后端的德州扑克对战工具：发牌、算牌、下注全部在服务器上完成，
每个人的底牌只发送给他自己的手机连接，房主和其他玩家都读不到——不同于纯前端
的 Claude 网页版本（那个只适合朋友局的"轻信任"场景），这个是服务器权威架构。

## 目录结构

```
poker-server/
  server.js          启动入口 + WebSocket 消息路由
  game/
    handEval.js       比牌算法（含边池计算）
    engine.js          下注轮状态机（弃牌/跟注/加注/全下/摊牌）
  public/
    index.html         首页
    host.html + host.js  房主控制台
    play.html + play.js  玩家端
    style.css           共用样式
```

数据全部保存在内存中（没有接数据库），重启服务会清空所有牌局，适合单场活动使用。
如果需要跨重启保留数据，可以自行接入 Redis/SQLite，我可以在需要时帮你加。

## 本地运行

```bash
cd poker-server
npm install
npm start
```

打开 `http://localhost:3000`，一台设备开"创建牌局"当房主，
其他设备（同一 WiFi 下用局域网 IP，比如 `http://192.168.1.5:3000`）打开"加入牌局"。

## 部署到公网（几种常见的免费/低价方案）

无论选哪个，步骤基本一致：把这个文件夹推到 Git 仓库，连接到平台，
平台会自动执行 `npm install && npm start`。

### Render.com（推荐，免费额度够用）
1. 把 `poker-server` 文件夹推到 GitHub 仓库
2. 在 Render 新建 "Web Service"，连接该仓库
3. Build Command: `npm install`　Start Command: `npm start`
4. 部署完成后会得到一个 `https://xxx.onrender.com` 地址，把这个地址发给玩家即可

### Railway.app
1. 同样推到 GitHub，New Project → Deploy from repo
2. Railway 会自动识别 Node.js 项目并运行 `npm start`

### Fly.io / 自己的云服务器
标准 Node.js 应用，`npm install && npm start` 即可，注意开放 `PORT` 环境变量
（平台一般会自动注入，`server.js` 已读取 `process.env.PORT`）。

## 使用流程

1. 房主打开首页 → 创建牌局 → 设置起始筹码 / 小盲 / 大盲 → 得到 6 位房间码和加入链接
2. 把房间码或链接发给朋友（微信群转发链接最方便）
3. 每位玩家在自己手机上打开链接 → 输入姓名 → 加入
4. 房主看到人齐后点"开始游戏"，之后每局结束点"开始下一局"
5. 轮到谁行动，谁的手机上会亮起操作按钮（弃牌/跟注/加注/全下），其他人看不到他的牌

## 安全说明

- 每位玩家的手牌只通过其专属 WebSocket 连接下发，服务器不会把别人的手牌发给你的设备。
- 玩家身份用随机 token 保存在浏览器 `localStorage`，刷新页面可自动重连、不掉线不丢筹码。
- 这套机制能防"看到别人屏幕才能作弊"级别的问题，但不含支付/实名等金融级合规能力，
  请勿用于真实货币结算的正式赌博场景。
