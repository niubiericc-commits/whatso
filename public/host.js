(function(){
  const SUIT_SYMBOL = { s:'♠', h:'♥', d:'♦', c:'♣' };
  const RANK_LABEL = {11:'J',12:'Q',13:'K',14:'A'};
  const STAGE_LABEL = { lobby:'等待开局', preflop:'翻牌前', flop:'翻牌', turn:'转牌', river:'河牌', showdown:'摊牌' };
  const TSTATUS_LABEL = { registering:'报名中', running:'进行中', finished:'已结束' };

  let ws = null;
  let connSeq = 0;
  let reconnectTimer = null;
  let connStatus = 'idle'; // idle | connecting | open | closed
  let lastError = null;

  let pageMode = 'menu'; // menu | host | club

  // --- 房主模式的状态 ---
  let roomId = localStorage.getItem('poker_host_roomId') || null;
  let hostToken = localStorage.getItem('poker_host_token') || null;
  let lastState = null;
  let connectTimeoutTimer = null;

  // --- 俱乐部后台模式的状态 ---
  let adminToken = localStorage.getItem('pokergo_admin_token') || null;
  let tournaments = [];
  let lookupResult = null;
  let clubListTimer = null;

  function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function cardHtml(c){
    if(!c) return '<div class="pcard back"></div>';
    const red = (c.s==='h'||c.s==='d');
    const label = RANK_LABEL[c.r] || c.r;
    return `<div class="pcard ${red?'red':'black'}"><span class="r">${label}</span><span class="s">${SUIT_SYMBOL[c.s]}</span></div>`;
  }
  function remainingSeconds(deadline){ return deadline ? Math.max(0, Math.ceil((deadline - Date.now())/1000)) : null; }

  // ---------------- 统一的连接层：房主模式和俱乐部模式共用同一套连接/重连逻辑 ----------------
  function connect(onOpen){
    connSeq++;
    const myConn = connSeq;
    console.log('[pokergo] connect() 开始，连接序号', myConn);
    clearTimeout(reconnectTimer);
    if(ws){ try{ ws.onclose=null; ws.close(); }catch(e){} }
    connStatus = 'connecting'; render();
    let socket;
    try{
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = proto + '://' + location.host + '/ws';
      console.log('[pokergo] 正在创建 WebSocket，地址：', url);
      socket = new WebSocket(url);
    }catch(e){
      console.log('[pokergo] 创建 WebSocket 直接抛出异常：', e);
      lastError = '无法创建连接：' + e.message;
      connStatus = 'closed'; render();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      console.log('[pokergo] WebSocket onopen 触发，连接序号', myConn, '当前连接序号', connSeq);
      if(myConn!==connSeq) return;
      connStatus='open'; if(onOpen) onOpen();
    };
    socket.onmessage = (ev) => {
      console.log('[pokergo] 收到消息：', ev.data);
      if(myConn!==connSeq) return;
      let msg;
      try{ msg = JSON.parse(ev.data); }catch(e){ console.log('[pokergo] 消息解析失败', e); return; }
      handleMessage(msg);
    };
    socket.onclose = (ev) => {
      console.log('[pokergo] WebSocket onclose 触发，code=', ev.code, 'reason=', ev.reason, 'wasClean=', ev.wasClean);
      if(myConn!==connSeq) return;
      connStatus = 'closed';
      if(!lastError) lastError = '与服务器的连接断开了（可能是网络问题，或服务器暂时无法访问，免费版服务器休眠唤醒有时会断一次再重连）。';
      reconnectTimer = setTimeout(()=>{
        if(pageMode==='host' && roomId && hostToken) connect(()=> send({type:'host_auth', roomId, hostToken}));
        else if(pageMode==='club' && adminToken) connect(refreshTournaments);
      }, 2000);
      render();
    };
    socket.onerror = (ev) => {
      console.log('[pokergo] WebSocket onerror 触发：', ev);
      if(myConn!==connSeq) return;
      lastError = lastError || '连接出错（网络问题，或服务器暂时没有响应，免费版服务器休眠后首次访问可能要等 30 秒左右）';
      render();
    };
  }

  function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  function handleMessage(msg){
    if(msg.type === 'host_created'){
      roomId = msg.roomId; hostToken = msg.hostToken;
      localStorage.setItem('poker_host_roomId', roomId);
      localStorage.setItem('poker_host_token', hostToken);
      lastError = null; render();
    } else if(msg.type === 'state'){
      lastState = msg; lastError = null; clearTimeout(connectTimeoutTimer); render();
    } else if(msg.type === 'error'){
      lastError = msg.message; render();
    }
  }

  // ---------------- 俱乐部后台用普通 HTTP 请求，不走 WebSocket ----------------
  async function apiGet(path){
    const res = await fetch(path, { headers: adminToken ? {'X-Admin-Token': adminToken} : {} });
    let data = {};
    try{ data = await res.json(); }catch(e){}
    if(!res.ok) throw new Error(data.error || ('请求失败（状态码 ' + res.status + '）'));
    return data;
  }
  async function apiPost(path, body){
    const res = await fetch(path, {
      method: 'POST',
      headers: Object.assign({'Content-Type':'application/json'}, adminToken?{'X-Admin-Token':adminToken}:{}),
      body: JSON.stringify(body||{})
    });
    let data = {};
    try{ data = await res.json(); }catch(e){}
    if(!res.ok) throw new Error(data.error || ('请求失败（状态码 ' + res.status + '）'));
    return data;
  }

  // ==================== 菜单 ====================
  function goMenu(){
    pageMode = 'menu';
    clearInterval(clubListTimer); clubListTimer = null;
    render();
  }

  function renderMenu(){
    return `
      <div class="mode-grid">
        <div class="mode-card" id="goHostBtn">
          <div class="mode-icon">🃏</div><h3>创建牌局</h3>
          <p>开一桌真人手机对战，生成房间码邀请朋友加入。</p>
        </div>
        <div class="mode-card" id="goClubBtn">
          <div class="mode-icon">🏆</div><h3>俱乐部后台</h3>
          <p>管理员登录，创建定制锦标赛、调整玩家的俱乐部积分。</p>
        </div>
      </div>`;
  }

  // ==================== 房主：创建牌局 ====================
  function createRoom(name, sb, bb, chips, timer){
    connect(()=> send({type:'host_create', roomName:name, smallBlind:sb, bigBlind:bb, startingChips:chips, turnTimeLimit:timer}));
  }
  function doResetHost(){
    localStorage.removeItem('poker_host_roomId');
    localStorage.removeItem('poker_host_token');
    roomId = null; hostToken = null; lastState = null; lastError = null;
    clearTimeout(connectTimeoutTimer);
    render();
  }

  function renderHost(){
    if(!roomId || !hostToken){
      return `
        <div class="card">
          <h2 class="section-title">创建新牌局</h2>
          <p class="section-sub">生成房间码后，把码和加入地址发给朋友，让他们在自己手机上打开加入。</p>
          <div class="field"><label>牌局名称</label><input type="text" id="rName" value="朋友局"></div>
          <div class="field"><label>起始筹码</label><input type="number" id="rChips" value="1000" min="20"></div>
          <div class="field" style="display:flex;gap:12px;">
            <div style="flex:1"><label>小盲注</label><input type="number" id="rSB" value="5" min="1"></div>
            <div style="flex:1"><label>大盲注</label><input type="number" id="rBB" value="10" min="2"></div>
          </div>
          <div class="field"><label>每人思考时间（秒，0 = 不限时）</label><input type="number" id="rTimer" value="30" min="0"></div>
          <div class="btn-row"><button class="btn btn-primary" id="createBtn">创建</button></div>
        </div>`;
    }

    if(!lastState){
      const connHint = connStatus==='connecting' ? '正在连接服务器…' : (connStatus==='closed' ? '连接已断开，正在重试…' : `正在连接房间 ${esc(roomId)} …`);
      const stuckMsg = lastError
        ? `<div class="err-box">${esc(lastError)}</div>
           <p class="section-sub">这通常是因为服务器重启过、之前的房间已经不存在了。点下面按钮清除本地记录，重新创建一个新房间。</p>
           <div class="btn-row"><button class="btn btn-primary" id="resetBtn">清除记录并重新创建</button></div>`
        : `<p class="section-sub">${connHint}</p>
           <p class="section-sub" id="timeoutHint" style="display:none;">一直连不上？免费版服务器如果休眠了，首次唤醒可能要等 30 秒左右，请再耐心等等；如果等了很久还不行，点下面按钮重新创建房间。</p>
           <div class="btn-row" id="timeoutBtnRow" style="display:none;"><button class="btn btn-ghost" id="resetBtn2">清除记录并重新创建</button></div>`;
      setTimeout(()=>{
        if(!lastError){
          clearTimeout(connectTimeoutTimer);
          connectTimeoutTimer = setTimeout(()=>{
            const hint = document.getElementById('timeoutHint');
            const row = document.getElementById('timeoutBtnRow');
            if(hint) hint.style.display='block';
            if(row) row.style.display='flex';
          }, 8000);
        }
      }, 0);
      return `<div class="card">${stuckMsg}</div>`;
    }

    const joinUrl = location.origin + '/play.html?room=' + roomId;
    const errHtml = lastError ? `<div class="err-box">${esc(lastError)}</div>` : '';
    const st = lastState;

    const playersRows = st.players.map(p => `
      <div class="player-list-row">
        <span>${esc(p.name)} ${p.connected?'<span class="badge badge-on">在线</span>':'<span class="badge badge-off">离线</span>'}</span>
        <span style="display:flex;align-items:center;gap:8px;">
          <span style="font-family:var(--font-mono);color:var(--gold-bright);">${p.chips} 筹码</span>
          ${st.stage==='lobby' ? `<button class="btn btn-danger btn-sm auto" data-kick="${p.id}" style="padding:5px 10px;font-size:11px;">踢出</button>` : ''}
        </span>
      </div>`).join('') || '<p class="section-sub">还没有玩家加入</p>';

    const communityCards = (st.community||[]).map(c=>cardHtml(c)).join('') + Array(Math.max(0,5-(st.community||[]).length)).fill('<div class="pcard empty"></div>').join('');
    const turnSecs = remainingSeconds(st.turnDeadline);
    const potlineExtra = (st.stage!=='showdown' && turnSecs!==null) ? `　行动倒计时：<span id="turnCountdown">${turnSecs}</span>s` : '';

    const n = st.players.length, rx=42, ry=37;
    const seatsHtml = st.players.map((p,i)=>{
      if(!p.seated && st.stage!=='lobby') return '';
      const angle = -Math.PI/2 + (n?(i/n):0)*2*Math.PI;
      const left = 50 + rx*Math.cos(angle), top = 50 + ry*Math.sin(angle);
      const cls=['seat-pos']; if(i===st.turn) cls.push('turn'); if(p.folded) cls.push('folded');
      const initial = (p.name||'?').trim().charAt(0).toUpperCase();
      return `<div class="${cls.join(' ')}" style="left:${left}%;top:${top}%">
        <div class="seat-avatar avatar-c${i%9}">${esc(initial)}${i===st.dealerIdx?'<span class="seat-dealer-btn">D</span>':''}</div>
        <div class="seat-nameplate">
          <div class="seat-pname">${esc(p.name)}</div>
          <div class="seat-chips">${p.chips}${p.allIn?' <span class="seat-allin-tag">ALL-IN</span>':''}${!p.connected?' <span class="disc">断线</span>':''}</div>
        </div>
        ${p.betThisStreet>0 ? `<div class="seat-bet-chip">${p.betThisStreet}</div>` : ''}
      </div>`;
    }).join('');

    let resultsHtml = '';
    if(st.stage==='showdown' && st.results){
      const reveal = st.players.filter(p=>p.cards && p.cards.length).map(p=>`
        <div style="text-align:center;">
          <div style="font-size:11px;margin-bottom:4px;">${esc(p.name)}</div>
          <div style="display:flex;gap:4px;justify-content:center;">${p.cards.map(c=>cardHtml(c)).join('')}</div>
          ${p.handName ? `<div style="font-size:11px;color:var(--gold-bright);margin-top:4px;font-family:var(--font-mono);">${esc(p.handName)}</div>` : ''}
        </div>`).join('');
      const nextSecs = remainingSeconds(st.nextHandDeadline);
      resultsHtml = `<div class="card"><h2 class="section-title" style="font-size:20px;">本局结果</h2>
        <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin-bottom:14px;">${reveal}</div>
        ${st.results.map(r=>`<div class="showdown-row"><span>${esc(r.handName)}</span><span>${r.winners.map(esc).join('、')} + ${r.amount}</span></div>`).join('')}
        <p class="section-sub" style="margin-top:10px;">${nextSecs!==null ? '<span id="nextHandCountdown">'+nextSecs+'</span> 秒后自动开始下一局' : ''}</p>
        <div class="btn-row"><button class="btn btn-primary" id="nextHandBtn">立即开始下一局</button></div>
      </div>`;
    }

    return `
      ${errHtml}
      <div class="card">
        <h2 class="section-title">${esc(st.name)}</h2>
        <div class="room-code">${roomId}</div>
        <p class="section-sub" style="text-align:center;">把房间码或下面的链接发给朋友，用手机浏览器打开加入</p>
        <div class="copy-row"><input type="text" id="joinUrlInput" readonly value="${joinUrl}"><button class="btn btn-ghost auto" id="copyBtn">复制</button></div>
      </div>

      <div class="card">
        <h2 class="section-title" style="font-size:20px;">玩家列表（${st.players.length} 人）</h2>
        ${playersRows}
        ${st.stage==='lobby' ? `<div class="btn-row"><button class="btn btn-primary" id="startBtn" ${st.players.length<2?'disabled':''}>开始游戏</button></div>` : `<p class="section-sub" style="margin-top:10px;">牌局已开始，新加入的玩家会自动排到下一局，不影响当前这手牌。</p>`}
      </div>

      ${st.stage!=='lobby' ? `
      <div class="table-strip"><span>第 ${st.handNumber} 局 · ${STAGE_LABEL[st.stage]||st.stage}</span><span>底池：${st.pot}　当前下注：${st.currentBet}${potlineExtra}</span></div>
      <div class="poker-table-wrap">
        <div class="poker-table-rail">
          <div class="poker-table-felt">
            <div class="table-center">
              <div class="table-pot"><span class="chip-ico"></span>底池 ${st.pot}</div>
              <div class="table-community">${communityCards}</div>
            </div>
            ${seatsHtml}
          </div>
        </div>
      </div>` : ''}

      ${resultsHtml}

      <div class="card">
        <h2 class="section-title" style="font-size:20px;">盲注 &amp; 思考时间设置</h2>
        <div class="field" style="display:flex;gap:12px;">
          <div style="flex:1"><label>小盲注</label><input type="number" id="sbInput" value="${st.smallBlind}" min="1"></div>
          <div style="flex:1"><label>大盲注</label><input type="number" id="bbInput" value="${st.bigBlind}" min="2"></div>
        </div>
        <div class="btn-row"><button class="btn btn-ghost" id="updateBlindsBtn">更新盲注（下一局生效）</button></div>
        <div class="field" style="margin-top:14px;"><label>每人思考时间（秒，0 = 不限时，立即生效）</label><input type="number" id="timerInput" value="${st.turnTimeLimit||0}" min="0"></div>
        <div class="btn-row"><button class="btn btn-ghost" id="updateTimerBtn">更新思考时间</button></div>
      </div>

      <div class="hint-box">房主看不到任何玩家的底牌（除非摊牌），保证公平。刷新本页会自动用房间口令重新连接，不会丢失牌局。摊牌后会在几秒内自动开始下一局，无需手动点击。思考时间超时会自动执行默认操作（能过牌就过牌，否则弃牌）。</div>
    `;
  }

  function bindHostEvents(){
    const createBtn = document.getElementById('createBtn');
    if(createBtn) createBtn.onclick = () => {
      const name = document.getElementById('rName').value.trim() || '朋友局';
      const chips = Math.max(20, parseInt(document.getElementById('rChips').value,10)||1000);
      const sb = Math.max(1, parseInt(document.getElementById('rSB').value,10)||5);
      const bb = Math.max(sb+1, parseInt(document.getElementById('rBB').value,10)||10);
      const timer = Math.max(0, parseInt(document.getElementById('rTimer').value,10)||0);
      createRoom(name, sb, bb, chips, timer);
    };
    const resetBtn = document.getElementById('resetBtn');
    if(resetBtn) resetBtn.onclick = doResetHost;
    const resetBtn2 = document.getElementById('resetBtn2');
    if(resetBtn2) resetBtn2.onclick = doResetHost;
    const copyBtn = document.getElementById('copyBtn');
    if(copyBtn) copyBtn.onclick = () => {
      const input = document.getElementById('joinUrlInput');
      input.select();
      navigator.clipboard && navigator.clipboard.writeText(input.value);
      copyBtn.textContent = '已复制';
      setTimeout(()=>copyBtn.textContent='复制', 1500);
    };
    const startBtn = document.getElementById('startBtn');
    if(startBtn) startBtn.onclick = () => send({type:'host_start'});
    const nextHandBtn = document.getElementById('nextHandBtn');
    if(nextHandBtn) nextHandBtn.onclick = () => send({type:'host_next_hand'});
    const updateBlindsBtn = document.getElementById('updateBlindsBtn');
    if(updateBlindsBtn) updateBlindsBtn.onclick = () => {
      send({type:'host_update_blinds', sb: parseInt(document.getElementById('sbInput').value,10), bb: parseInt(document.getElementById('bbInput').value,10)});
    };
    const updateTimerBtn = document.getElementById('updateTimerBtn');
    if(updateTimerBtn) updateTimerBtn.onclick = () => {
      send({type:'host_update_timer', seconds: parseInt(document.getElementById('timerInput').value,10)});
    };
    document.querySelectorAll('[data-kick]').forEach(b=>{
      b.onclick = () => { if(confirm('确认踢出该玩家？')) send({type:'host_kick', playerId:b.dataset.kick}); };
    });
  }

  // ==================== 俱乐部后台 ====================
  let clubBusy = false;
  async function refreshTournaments(){
    try{
      const r = await apiGet('/api/admin/tournaments');
      tournaments = r.tournaments; lastError = null;
    }catch(e){ lastError = e.message; }
    render();
  }
  function logoutClub(){
    adminToken = null;
    localStorage.removeItem('pokergo_admin_token');
    clearInterval(clubListTimer); clubListTimer = null;
    render();
  }

  function renderClub(){
    if(!adminToken){
      return `
        <div class="card">
          <h2 class="section-title">管理员登录</h2>
          <p class="section-sub">用管理员密码登录后台，用来建赛事、调整俱乐部积分。</p>
          ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
          ${clubBusy?'<p class="section-sub">正在登录…</p>':''}
          <div class="field"><label>管理员密码</label><input type="password" id="adminPass"></div>
          <div class="btn-row"><button class="btn btn-primary" id="adminLoginBtn" ${clubBusy?'disabled':''}>登录</button></div>
        </div>`;
    }

    if(!clubListTimer) clubListTimer = setInterval(refreshTournaments, 4000);

    const tourneyRows = tournaments.map(t => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
          <div>
            <h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 4px;color:var(--gold-bright);">${esc(t.name)}</h3>
            <p class="section-sub" style="margin:0;">状态：${TSTATUS_LABEL[t.status]||t.status} · 门票 ${t.ticketPrice} 俱乐部积分 · 已报名 ${t.registeredCount} 人 · 在场 ${t.remainingCount} 人 · 每桌最多 ${t.maxTableSize} 人</p>
          </div>
          ${t.status==='registering' ? `<button class="btn btn-primary btn-sm auto" data-start="${t.id}">开赛</button>` : ''}
        </div>
        <div class="hint-box" style="margin-top:10px;">🥇 冠军：${esc(t.prizes[1])}　🥈 亚军：${esc(t.prizes[2])}　🥉 季军：${esc(t.prizes[3])}</div>
        ${t.status==='finished' && t.results ? `
        <div style="margin-top:10px;">
          ${[1,2,3].map(r => t.results[r] ? `<div class="showdown-row"><span>${r===1?'🥇冠军':r===2?'🥈亚军':'🥉季军'} ${esc(t.results[r].username)}</span><span>${esc(t.results[r].prize)}</span></div>` : '').join('')}
        </div>` : ''}
      </div>`).join('') || '<p class="section-sub">还没有创建任何赛事</p>';

    return `
      ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
      <div class="card">
        <div class="btn-row"><button class="btn btn-ghost btn-sm auto" id="logoutClubBtn">退出管理员登录</button></div>
      </div>

      <div class="card">
        <h2 class="section-title">查找账号 / 调整俱乐部积分</h2>
        <p class="section-sub">俱乐部积分只用于购买锦标赛门票，跟桌上打牌用的筹码积分是两套独立的数字。</p>
        <div class="field"><label>用户名</label><input type="text" id="lookupUser"></div>
        <div class="btn-row"><button class="btn btn-ghost auto" id="lookupBtn">查询</button></div>
        ${lookupResult ? `
        <div class="hint-box" style="margin-top:12px;">
          账号：${esc(lookupResult.username)}　筹码积分：${lookupResult.points!==undefined?lookupResult.points:'-'}　俱乐部积分：<strong style="color:var(--gold-bright);">${lookupResult.clubPoints}</strong>
        </div>
        <div class="field" style="margin-top:10px;"><label>调整俱乐部积分（正数增加，负数扣减）</label><input type="number" id="adjustDelta" value="100"></div>
        <div class="btn-row"><button class="btn btn-primary auto" id="adjustBtn">应用调整</button></div>
        ` : ''}
      </div>

      <div class="card">
        <h2 class="section-title">创建定制赛事</h2>
        <p class="section-sub">门票用俱乐部积分购买；奖品是文字说明，实际奖品由你线下发放，系统只负责记录和排名。</p>
        <div class="field"><label>赛事名称</label><input type="text" id="tName" value="定制锦标赛"></div>
        <div class="field" style="display:flex;gap:12px;">
          <div style="flex:1"><label>门票价格（俱乐部积分）</label><input type="number" id="tTicket" value="100" min="0"></div>
          <div style="flex:1"><label>每桌最多人数</label><input type="number" id="tMaxTable" value="9" min="2" max="9"></div>
        </div>
        <div class="field" style="display:flex;gap:12px;">
          <div style="flex:1"><label>起始筹码</label><input type="number" id="tChips" value="1000" min="20"></div>
          <div style="flex:1"><label>小盲/大盲</label>
            <div style="display:flex;gap:6px;">
              <input type="number" id="tSb" value="5" min="1">
              <input type="number" id="tBb" value="10" min="2">
            </div>
          </div>
        </div>
        <div class="field"><label>🥇 冠军奖品</label><input type="text" id="tPrize1" placeholder="例如：平板电脑"></div>
        <div class="field"><label>🥈 亚军奖品</label><input type="text" id="tPrize2" placeholder="例如：机械键盘"></div>
        <div class="field"><label>🥉 季军奖品</label><input type="text" id="tPrize3" placeholder="例如：扑克筹码套装"></div>
        <div class="btn-row"><button class="btn btn-primary" id="createTBtn">创建赛事</button></div>
      </div>

      <div class="card"><h2 class="section-title">赛事列表</h2></div>
      ${tourneyRows}
    `;
  }

  function bindClubEvents(){
    const adminLoginBtn = document.getElementById('adminLoginBtn');
    if(adminLoginBtn) adminLoginBtn.onclick = async () => {
      const pass = document.getElementById('adminPass').value;
      if(!pass){ alert('请输入密码'); return; }
      lastError = null; clubBusy = true; render();
      try{
        const r = await apiPost('/api/admin/login', { password: pass });
        adminToken = r.adminToken;
        localStorage.setItem('pokergo_admin_token', adminToken);
        clubBusy = false;
        await refreshTournaments();
      }catch(e){
        lastError = e.message; clubBusy = false; render();
      }
    };
    const logoutClubBtn = document.getElementById('logoutClubBtn');
    if(logoutClubBtn) logoutClubBtn.onclick = logoutClub;
    const lookupBtn = document.getElementById('lookupBtn');
    if(lookupBtn) lookupBtn.onclick = async () => {
      const u = document.getElementById('lookupUser').value.trim();
      if(!u){ alert('请输入用户名'); return; }
      try{
        lookupResult = await apiGet('/api/admin/accounts/' + encodeURIComponent(u));
        lastError = null;
      }catch(e){ lastError = e.message; }
      render();
    };
    const adjustBtn = document.getElementById('adjustBtn');
    if(adjustBtn) adjustBtn.onclick = async () => {
      const delta = parseInt(document.getElementById('adjustDelta').value, 10);
      if(!delta){ alert('请输入调整数值'); return; }
      try{
        const r = await apiPost('/api/admin/accounts/' + encodeURIComponent(lookupResult.username) + '/club-points', { delta });
        lookupResult = Object.assign({}, lookupResult, { clubPoints: r.clubPoints });
        lastError = null;
      }catch(e){ lastError = e.message; }
      render();
    };
    const createTBtn = document.getElementById('createTBtn');
    if(createTBtn) createTBtn.onclick = async () => {
      try{
        const r = await apiPost('/api/admin/tournaments', {
          name: document.getElementById('tName').value.trim(),
          ticketPrice: parseInt(document.getElementById('tTicket').value,10)||0,
          maxTableSize: parseInt(document.getElementById('tMaxTable').value,10)||9,
          startingChips: parseInt(document.getElementById('tChips').value,10)||1000,
          smallBlind: parseInt(document.getElementById('tSb').value,10)||5,
          bigBlind: parseInt(document.getElementById('tBb').value,10)||10,
          prize1: document.getElementById('tPrize1').value.trim(),
          prize2: document.getElementById('tPrize2').value.trim(),
          prize3: document.getElementById('tPrize3').value.trim()
        });
        tournaments = r.tournaments; lastError = null;
      }catch(e){ lastError = e.message; }
      render();
    };
    document.querySelectorAll('[data-start]').forEach(b=>{
      b.onclick = async () => {
        if(!confirm('确认开赛吗？开赛后不能再接受新报名。')) return;
        try{
          const r = await apiPost('/api/admin/tournaments/' + encodeURIComponent(b.dataset.start) + '/start', {});
          tournaments = r.tournaments; lastError = null;
        }catch(e){ lastError = e.message; }
        render();
      };
    });
  }

  // ==================== 总渲染入口 ====================
  function render(){
    const app = document.getElementById('app');
    if(!app) return;
    const backLink = pageMode!=='menu' ? `<button class="home-btn" id="backMenuBtn">← 返回菜单</button>` : '';
    const titleMap = { menu:'房主 / 俱乐部控制台', host:'房主控制台', club:'俱乐部后台' };
    document.getElementById('pageTitle').textContent = titleMap[pageMode];
    document.getElementById('backSlot').innerHTML = backLink;

    let body = '';
    if(pageMode==='menu') body = renderMenu();
    else if(pageMode==='host') body = renderHost();
    else if(pageMode==='club') body = renderClub();
    app.innerHTML = body;

    const backBtn = document.getElementById('backMenuBtn');
    if(backBtn) backBtn.onclick = goMenu;
    const goHostBtn = document.getElementById('goHostBtn');
    if(goHostBtn) goHostBtn.onclick = () => { pageMode='host'; lastError=null; render(); if(roomId && hostToken) connect(()=> send({type:'host_auth', roomId, hostToken})); };
    const goClubBtn = document.getElementById('goClubBtn');
    if(goClubBtn) goClubBtn.onclick = () => { pageMode='club'; lastError=null; render(); if(adminToken) refreshTournaments(); };

    if(pageMode==='host') bindHostEvents();
    if(pageMode==='club') bindClubEvents();
  }

  // 每秒只更新倒计时的数字文本，不整体重画界面（避免打断正在输入的框）
  setInterval(()=>{
    if(pageMode!=='host' || !lastState) return;
    const tEl = document.getElementById('turnCountdown');
    if(tEl && lastState.turnDeadline) tEl.textContent = remainingSeconds(lastState.turnDeadline);
    const nEl = document.getElementById('nextHandCountdown');
    if(nEl && lastState.nextHandDeadline) nEl.textContent = remainingSeconds(lastState.nextHandDeadline);
  }, 1000);

  render();
})();
