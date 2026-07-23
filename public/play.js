(function(){
  const SUIT_SYMBOL = { s:'♠', h:'♥', d:'♦', c:'♣' };
  const RANK_LABEL = {11:'J',12:'Q',13:'K',14:'A'};
  const STAGE_LABEL = { lobby:'等待房主开局', preflop:'翻牌前', flop:'翻牌', turn:'转牌', river:'河牌', showdown:'摊牌' };
  const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  const params = new URLSearchParams(location.search);
  const prefillRoom = (params.get('room')||'').toUpperCase();

  let ws = null;
  let roomId = null, playerId = null, playerToken = null;
  let lastState = null;
  let lastError = null;
  let connSeq = 0;
  let reconnectTimer = null;
  let account = null;       // {username, accountToken}
  let accountPoints = null;
  let accountClubPoints = null;
  let viewMode = 'join';    // 'join' | 'tournaments'
  let tournamentList = [];
  let pendingTournamentId = localStorage.getItem('pokergo_pending_tournament') || null;
  let tournamentEndInfo = null; // {eliminated:true, rank} 或 {results}
  let tournamentPollTimer = null;

  function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function cardHtml(c){
    const red = (c.s==='h'||c.s==='d');
    const label = RANK_LABEL[c.r] || c.r;
    return `<div class="pcard ${red?'red':'black'}"><span class="r">${label}</span><span class="s">${SUIT_SYMBOL[c.s]}</span></div>`;
  }
  function storageKey(rid){ return 'poker_player_' + rid; }
  function remainingSeconds(deadline){ return deadline ? Math.max(0, Math.ceil((deadline - Date.now())/1000)) : null; }

  // ---------------- 客户端实时算牌（只用来提示自己当前的最大牌型，不影响服务端权威判定） ----------------
  function combinations(arr, k){
    const res = [];
    (function helper(start, combo){
      if(combo.length===k){ res.push(combo.slice()); return; }
      for(let i=start;i<arr.length;i++){ combo.push(arr[i]); helper(i+1, combo); combo.pop(); }
    })(0, []);
    return res;
  }
  function handValue(cards5){
    const ranks = cards5.map(c=>c.r).sort((a,b)=>b-a);
    const suits = cards5.map(c=>c.s);
    const isFlush = suits.every(s=>s===suits[0]);
    let uniq=[...new Set(ranks)], isStraight=false, straightHigh=0;
    if(uniq.length===5){
      if(uniq[0]-uniq[4]===4){ isStraight=true; straightHigh=uniq[0]; }
      else if(uniq[0]===14 && uniq[1]===5 && uniq[2]===4 && uniq[3]===3 && uniq[4]===2){ isStraight=true; straightHigh=5; }
    }
    const counts={}; ranks.forEach(r=>counts[r]=(counts[r]||0)+1);
    const groups = Object.entries(counts).map(([r,c])=>({r:+r,c})).sort((a,b)=> b.c-a.c || b.r-a.r);
    if(isStraight && isFlush) return [8, straightHigh];
    if(groups[0].c===4) return [7, groups[0].r, groups[1].r];
    if(groups[0].c===3 && groups[1] && groups[1].c===2) return [6, groups[0].r, groups[1].r];
    if(isFlush) return [5, ...ranks];
    if(isStraight) return [4, straightHigh];
    if(groups[0].c===3) return [3, groups[0].r, ...groups.slice(1).map(g=>g.r)];
    if(groups[0].c===2 && groups[1] && groups[1].c===2) return [2, Math.max(groups[0].r,groups[1].r), Math.min(groups[0].r,groups[1].r), groups[2].r];
    if(groups[0].c===2) return [1, groups[0].r, ...groups.slice(1).map(g=>g.r)];
    return [0, ...ranks];
  }
  function compareVal(a,b){
    for(let i=0;i<Math.max(a.length,b.length);i++){ const av=a[i]||0, bv=b[i]||0; if(av!==bv) return av-bv; }
    return 0;
  }
  function currentHandName(cards){
    if(!cards || cards.length<5) return null;
    let best=null;
    combinations(cards,5).forEach(c=>{ const v=handValue(c); if(!best||compareVal(v,best)>0) best=v; });
    return best ? HAND_NAMES[best[0]] : null;
  }

  // connSeq 保证切换房间时，旧连接的过期消息/自动重连不会污染新房间的状态
  function connect(onOpen){
    connSeq++;
    const myConn = connSeq;
    clearTimeout(reconnectTimer);
    if(ws){ try{ ws.onclose=null; ws.close(); }catch(e){} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(proto + '://' + location.host + '/ws');
    ws = socket;
    socket.onopen = () => { if(myConn===connSeq && onOpen) onOpen(); };
    socket.onmessage = (ev) => {
      if(myConn!==connSeq) return; // 已被更新的连接取代，忽略
      const msg = JSON.parse(ev.data);
      if(msg.type === 'joined'){
        roomId = msg.roomId; playerId = msg.playerId; playerToken = msg.playerToken;
        localStorage.setItem(storageKey(roomId), JSON.stringify({playerId, playerToken}));
        localStorage.setItem('poker_last_room', roomId);
        render();
      } else if(msg.type === 'state'){
        lastState = msg; lastError = null; render();
      } else if(msg.type === 'account'){
        account = { username: msg.username, accountToken: msg.accountToken };
        accountPoints = msg.points;
        accountClubPoints = msg.clubPoints;
        localStorage.setItem('pokergo_account', JSON.stringify(account));
        lastError = null; render();
      } else if(msg.type === 'tournament_list'){
        tournamentList = msg.tournaments; render();
      } else if(msg.type === 'tournament_registered'){
        accountClubPoints = msg.clubPoints;
        pendingTournamentId = msg.tournamentId;
        localStorage.setItem('pokergo_pending_tournament', pendingTournamentId);
        lastError = null; render();
      } else if(msg.type === 'tournament_waiting'){
        pendingTournamentId = msg.tournamentId;
        localStorage.setItem('pokergo_pending_tournament', pendingTournamentId);
        render();
      } else if(msg.type === 'tournament_assigned'){
        localStorage.removeItem('pokergo_pending_tournament');
        pendingTournamentId = null;
        connect(()=> send({type:'rejoin', roomId: msg.roomId, playerToken: msg.playerToken}));
      } else if(msg.type === 'tournament_eliminated'){
        localStorage.removeItem('pokergo_pending_tournament');
        pendingTournamentId = null;
        tournamentEndInfo = { eliminated: true, rank: msg.rank };
        render();
      } else if(msg.type === 'tournament_finished'){
        localStorage.removeItem('pokergo_pending_tournament');
        pendingTournamentId = null;
        tournamentEndInfo = { results: msg.results };
        render();
      } else if(msg.type === 'error'){
        lastError = msg.message; render();
      }
    };
    socket.onclose = () => {
      if(myConn!==connSeq) return; // 已被新连接取代，不用这条旧连接重连
      reconnectTimer = setTimeout(()=>tryAutoReconnect(), 2000);
    };
  }

  function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  function tryAutoReconnect(){
    if(roomId && playerToken){
      connect(()=> send({type:'rejoin', roomId, playerToken}));
    }
  }

  function loginOrRegister(type, username, password){
    connect(()=> send({type, username, password}));
  }

  function logout(){
    account = null; accountPoints = null; accountClubPoints = null;
    localStorage.removeItem('pokergo_account');
    render();
  }

  function fetchTournamentList(){
    connect(()=> send({type:'tournament_list'}));
  }

  function registerForTournament(tournamentId){
    if(!account){ alert('请先登录账号再报名'); return; }
    send({type:'tournament_register', tournamentId, accountToken: account.accountToken});
  }

  function startTournamentPolling(){
    stopTournamentPolling();
    tournamentPollTimer = setInterval(()=>{
      if(!pendingTournamentId || !account) return;
      send({type:'tournament_check_assignment', tournamentId: pendingTournamentId, accountToken: account.accountToken});
    }, 3000);
  }
  function stopTournamentPolling(){ clearInterval(tournamentPollTimer); tournamentPollTimer = null; }

  function joinRoom(rid, name){
    lastState = null; lastError = null; playerId = null; // 清空上一个房间残留的状态
    const saved = localStorage.getItem(storageKey(rid));
    connect(()=>{
      if(saved){
        const s = JSON.parse(saved);
        send({type:'rejoin', roomId: rid, playerToken: s.playerToken});
      } else if(account){
        send({type:'join', roomId: rid, accountToken: account.accountToken});
      } else {
        send({type:'join', roomId: rid, name});
      }
    });
  }

  function render(){
    const app = document.getElementById('app');

    if(!roomId || !playerId){
      // 分支1：赛事已经结束或本人已被淘汰，展示结果
      if(tournamentEndInfo){
        stopTournamentPolling();
        if(tournamentEndInfo.eliminated){
          app.innerHTML = `
            <div class="card">
              <h2 class="section-title">已出局</h2>
              <p class="section-sub">你在本场赛事中获得第 ${tournamentEndInfo.rank} 名。感谢参赛！</p>
              <div class="btn-row"><button class="btn btn-primary auto" id="backBtn">返回</button></div>
            </div>`;
        } else {
          const r = tournamentEndInfo.results || {};
          const rows = [1,2,3].map(rank => r[rank] ? `<div class="showdown-row"><span>${rank===1?'🥇 冠军':rank===2?'🥈 亚军':'🥉 季军'} ${esc(r[rank].username)}</span><span>${esc(r[rank].prize)}</span></div>` : '').join('');
          app.innerHTML = `
            <div class="card">
              <h2 class="section-title">🏆 赛事结束</h2>
              ${rows}
              <div class="btn-row" style="margin-top:12px;"><button class="btn btn-primary auto" id="backBtn">返回</button></div>
            </div>`;
        }
        document.getElementById('backBtn').onclick = () => { tournamentEndInfo = null; viewMode='join'; render(); };
        return;
      }

      // 分支2：已报名，正在等待管理员开赛 / 等待系统给自己分桌
      if(pendingTournamentId){
        startTournamentPolling();
        app.innerHTML = `
          <div class="card">
            <h2 class="section-title">已报名</h2>
            <div class="waiting-box">
              <div class="big">🎟️</div>
              等待管理员开赛，开赛后会自动带你进入分到的牌桌…
            </div>
            <div class="btn-row"><button class="btn btn-ghost btn-sm auto" id="cancelWaitBtn">取消等待（不退票）</button></div>
          </div>`;
        document.getElementById('cancelWaitBtn').onclick = () => { stopTournamentPolling(); pendingTournamentId=null; localStorage.removeItem('pokergo_pending_tournament'); render(); };
        return;
      }

      // 分支3：锦标赛列表
      if(viewMode === 'tournaments'){
        const rows = tournamentList.map(t => `
          <div class="card">
            <h3 style="font-family:var(--font-display);font-size:20px;margin:0 0 4px;color:var(--gold-bright);">${esc(t.name)}</h3>
            <p class="section-sub" style="margin:0 0 8px;">${t.status==='registering'?'报名中':t.status==='running'?'进行中':'已结束'} · 门票 ${t.ticketPrice} 俱乐部积分 · 已报名 ${t.registeredCount} 人</p>
            <p class="section-sub" style="margin:0 0 10px;">🥇 ${esc(t.prizes[1])}　🥈 ${esc(t.prizes[2])}　🥉 ${esc(t.prizes[3])}</p>
            ${t.status==='registering' ? `<button class="btn btn-primary btn-sm auto" data-reg="${t.id}">花 ${t.ticketPrice} 积分报名</button>` : ''}
            ${t.status==='finished' && t.results ? `<div class="hint-box">${[1,2,3].map(r=>t.results[r]?(r===1?'🥇':r===2?'🥈':'🥉')+esc(t.results[r].username):'').filter(Boolean).join('　')}</div>` : ''}
          </div>`).join('') || '<p class="section-sub">目前没有正在报名的赛事</p>';

        app.innerHTML = `
          ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
          <div class="card">
            <p class="section-sub">${account ? '俱乐部积分：<strong style="color:var(--gold-bright);">'+accountClubPoints+'</strong>' : '登录账号后才能报名，请先返回登录'}</p>
            <div class="btn-row"><button class="btn btn-ghost btn-sm auto" id="backToJoinBtn">← 返回</button></div>
          </div>
          ${rows}
        `;
        document.getElementById('backToJoinBtn').onclick = () => { viewMode='join'; render(); };
        document.querySelectorAll('[data-reg]').forEach(b=>{
          b.onclick = () => registerForTournament(b.dataset.reg);
        });
        return;
      }

      // 分支4：默认——房间码加入 / 账号登录
      const lastRoom = prefillRoom || localStorage.getItem('poker_last_room') || '';

      const accountBlock = account ? `
        <div class="card">
          <h2 class="section-title" style="font-size:20px;">已登录</h2>
          <p class="section-sub">账号：<strong style="color:var(--cream);">${esc(account.username)}</strong>　筹码积分：<strong style="color:var(--gold-bright);">${accountPoints}</strong>　俱乐部积分：<strong style="color:var(--gold-bright);">${accountClubPoints}</strong></p>
          <p class="section-sub">加入房间时会自动带上这个身份和积分作为筹码，掉线时会自动进入托管（能过牌就过牌，否则弃牌），重新连上就恢复正常。</p>
          <div class="btn-row">
            <button class="btn btn-ghost btn-sm auto" id="viewTournamentsBtn">🏆 查看锦标赛</button>
            <button class="btn btn-ghost btn-sm auto" id="logoutBtn">退出登录</button>
          </div>
        </div>` : `
        <div class="card">
          <h2 class="section-title" style="font-size:20px;">账号登录（可选）</h2>
          <p class="section-sub">登录后积分会持久保存在服务器上，下次登录还能接着用；不登录也可以直接以访客身份加入，但积分不会保留，也无法参加锦标赛。</p>
          <div class="field"><label>用户名</label><input type="text" id="authUser" maxlength="20"></div>
          <div class="field"><label>密码</label><input type="password" id="authPass" maxlength="40"></div>
          <div class="btn-row">
            <button class="btn btn-primary auto" id="loginBtn">登录</button>
            <button class="btn btn-ghost auto" id="registerBtn">注册新账号</button>
          </div>
        </div>`;

      app.innerHTML = `
        ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
        ${accountBlock}
        <div class="card">
          <h2 class="section-title">加入牌局</h2>
          <p class="section-sub">向房主索要 6 位房间码即可加入。你的手机屏幕只会显示你自己的底牌。</p>
          <div class="field"><label>房间码</label><input type="text" id="roomInput" value="${esc(lastRoom)}" maxlength="6" style="text-transform:uppercase;letter-spacing:.2em;text-align:center;font-size:20px;"></div>
          ${account ? `<p class="section-sub">将以账号 <strong style="color:var(--cream);">${esc(account.username)}</strong> 身份加入</p>` : `<div class="field"><label>你的名字（访客）</label><input type="text" id="nameInput" maxlength="20" placeholder="输入姓名"></div>`}
          <div class="btn-row"><button class="btn btn-primary" id="joinBtn">加入</button></div>
        </div>`;

      document.getElementById('joinBtn').onclick = () => {
        const rid = document.getElementById('roomInput').value.trim().toUpperCase();
        if(!rid){ alert('请输入房间码'); return; }
        if(account){
          joinRoom(rid, null);
        } else {
          const name = document.getElementById('nameInput').value.trim();
          if(!name){ alert('请输入姓名'); return; }
          joinRoom(rid, name);
        }
      };
      const loginBtn = document.getElementById('loginBtn');
      if(loginBtn) loginBtn.onclick = () => {
        const u = document.getElementById('authUser').value.trim();
        const p = document.getElementById('authPass').value;
        if(!u || !p){ alert('请输入用户名和密码'); return; }
        loginOrRegister('login', u, p);
      };
      const registerBtn = document.getElementById('registerBtn');
      if(registerBtn) registerBtn.onclick = () => {
        const u = document.getElementById('authUser').value.trim();
        const p = document.getElementById('authPass').value;
        if(!u || !p){ alert('请输入用户名和密码'); return; }
        loginOrRegister('register', u, p);
      };
      const logoutBtn = document.getElementById('logoutBtn');
      if(logoutBtn) logoutBtn.onclick = logout;
      const viewTournamentsBtn = document.getElementById('viewTournamentsBtn');
      if(viewTournamentsBtn) viewTournamentsBtn.onclick = () => { viewMode='tournaments'; fetchTournamentList(); render(); };
      return;
    }

    if(!lastState){
      app.innerHTML = `<div class="card"><p class="section-sub">正在连接房间 ${esc(roomId)} …</p></div>`;
      return;
    }

    const st = lastState;
    const me = st.players.find(p=>p.id===playerId);
    const errHtml = lastError ? `<div class="err-box">${esc(lastError)}</div>` : '';

    if(st.stage==='lobby'){
      app.innerHTML = `
        ${errHtml}
        <div class="card">
          <h2 class="section-title">${esc(st.name)}</h2>
          <p class="section-sub">房间码 ${roomId} · 等待房主开始游戏…</p>
          <div class="waiting-box">
            <div class="big">🂠</div>
            已加入，共 ${st.players.length} 位玩家在场
          </div>
        </div>`;
      return;
    }

    const turnSecs = remainingSeconds(st.turnDeadline);
    const potlineExtra = (st.stage!=='showdown' && turnSecs!==null) ? `　行动倒计时：<span id="turnCountdown">${turnSecs}</span>s` : '';
    const communityCards = (st.community||[]).map(c=>cardHtml(c)).join('') + Array(Math.max(0,5-(st.community||[]).length)).fill('<div class="pcard empty"></div>').join('');

    // 以"我"为最下方，环绕椭圆桌排列座位（GGPoker 等主流客户端的经典视角）
    const n = st.players.length;
    const meIdx = st.players.findIndex(p=>p.id===playerId);
    const startIdx = meIdx>=0 ? meIdx : 0;
    const rx=42, ry=37;
    const seatsHtml = st.players.map((p,orig)=>{
      if(!p.seated && st.stage!=='showdown') return '';
      const k = (orig - startIdx + n) % n;
      const angle = Math.PI/2 + (k/n)*2*Math.PI;
      const left = 50 + rx*Math.cos(angle), top = 50 + ry*Math.sin(angle);
      const cls=['seat-pos']; if(orig===st.turn) cls.push('turn'); if(p.folded) cls.push('folded'); if(p.id===playerId) cls.push('me');
      const initial = (p.name||'?').trim().charAt(0).toUpperCase();
      return `<div class="${cls.join(' ')}" style="left:${left}%;top:${top}%">
        <div class="seat-avatar avatar-c${orig%9}">${esc(initial)}${orig===st.dealerIdx?'<span class="seat-dealer-btn">D</span>':''}</div>
        <div class="seat-nameplate">
          <div class="seat-pname">${esc(p.name)}${p.id===playerId?'<span class="me-tag"> (我)</span>':''}</div>
          <div class="seat-chips">${p.chips}${p.allIn?' <span class="seat-allin-tag">ALL-IN</span>':''}${!p.connected?' <span class="seat-allin-tag" style="background:var(--muted);color:var(--ink);">托管中</span>':''}</div>
        </div>
        ${p.betThisStreet>0 ? `<div class="seat-bet-chip">${p.betThisStreet}</div>` : ''}
      </div>`;
    }).join('');

    const tableHtml = `
      <div class="table-strip"><span>第 ${st.handNumber} 局 · ${STAGE_LABEL[st.stage]||st.stage}</span><span>${potlineExtra.replace('　','')}</span></div>
      <div class="poker-table-wrap">
        <div class="poker-table-rail">
          <div class="poker-table-felt">
            <div class="table-center">
              <div class="table-pot"><span class="chip-ico"></span>底池 ${st.pot}${st.currentBet?'　下注 '+st.currentBet:''}</div>
              <div class="table-community">${communityCards}</div>
            </div>
            ${seatsHtml}
          </div>
        </div>
      </div>`;

    let panel = '';
    if(st.stage==='showdown'){
      const reveal = st.players.filter(p=>p.cards && p.cards.length).map(p=>`
        <div style="text-align:center;">
          <div style="font-size:11px;margin-bottom:4px;">${esc(p.name)}${p.id===playerId?' (我)':''}</div>
          <div style="display:flex;gap:4px;justify-content:center;">${p.cards.map(c=>cardHtml(c)).join('')}</div>
          ${p.handName ? `<div style="font-size:11px;color:var(--gold-bright);margin-top:4px;font-family:var(--font-mono);">${esc(p.handName)}</div>` : ''}
        </div>`).join('');
      const results = (st.results||[]).map(r=>`<div class="showdown-row"><span>${esc(r.handName)}</span><span>${r.winners.map(esc).join('、')} + ${r.amount}</span></div>`).join('');
      const nextSecs = remainingSeconds(st.nextHandDeadline);
      panel = `<div class="turn-panel">
        <h3 style="font-family:var(--font-display);font-size:20px;margin:0 0 10px;color:var(--gold-bright);">摊牌结果</h3>
        <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:12px;">${reveal}</div>
        ${results}
        <p class="section-sub" style="margin-top:10px;">${nextSecs!==null ? '<span id="nextHandCountdown">'+nextSecs+'</span> 秒后自动开始下一局…' : '等待房主开始下一局…'}</p>
      </div>`;
    } else if(me && !me.seated){
      panel = `<div class="turn-panel"><p class="section-sub">本局你没有入座（筹码为 0 或本局未参与），请等待下一局。</p></div>`;
    } else if(me){
      // 手牌全程展示（只要你在场、没弃牌），不再只在轮到你时才显示
      const myCardsHtml = (me.cards||[]).length
        ? `<div class="hole-cards">${me.cards.map(c=>cardHtml(c)).join('')}</div>`
        : '';
      const myHandName = currentHandName([...(me.cards||[]), ...(st.community||[])]);
      const handNameHtml = myHandName ? `<div style="font-family:var(--font-mono);font-size:12px;color:var(--gold-bright);margin-bottom:8px;">当前牌型：${esc(myHandName)}</div>` : '';
      const isMyTurn = st.turn === st.players.indexOf(me);
      let bottom;
      if(me.folded){
        bottom = `<p class="section-sub" style="margin-top:10px;">你本局已弃牌，等待结果…</p>`;
      } else if(!isMyTurn){
        bottom = `<p class="section-sub" style="margin-top:10px;">等待其他玩家行动…</p>`;
      } else {
        const need = st.currentBet - me.betThisStreet;
        bottom = `
          <div class="action-row">
            <button class="btn btn-danger" id="foldBtn">弃牌</button>
            <button class="btn btn-blue" id="callBtn">${need<=0?'过牌':'跟注 '+need}</button>
            <button class="btn btn-ghost" id="allinBtn">全下 (${me.chips})</button>
          </div>
          <div class="pot-quick-row">
            <button class="btn btn-ghost btn-sm auto" data-frac="0.25">1/4 池</button>
            <button class="btn btn-ghost btn-sm auto" data-frac="0.5">1/2 池</button>
            <button class="btn btn-ghost btn-sm auto" data-frac="0.75">3/4 池</button>
            <button class="btn btn-ghost btn-sm auto" data-frac="1">全池</button>
          </div>
          <div class="raise-box">
            <input type="number" id="raiseInput" placeholder="加注到…" min="${st.currentBet+1}">
            <button class="btn btn-primary auto" id="raiseBtn">加注</button>
          </div>`;
      }
      panel = `
        <div class="turn-panel">
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">${isMyTurn && !me.folded ? '轮到你了' : '我的手牌'}</div>
          ${myCardsHtml}
          ${handNameHtml}
          ${bottom}
        </div>`;
    }

    app.innerHTML = `
      ${errHtml}
      ${tableHtml}
      ${panel}
    `;

    const foldBtn = document.getElementById('foldBtn');
    if(foldBtn) foldBtn.onclick = () => send({type:'action', action:'fold'});
    const callBtn = document.getElementById('callBtn');
    if(callBtn) callBtn.onclick = () => send({type:'action', action: (st.currentBet - me.betThisStreet)<=0 ? 'check':'call'});
    const allinBtn = document.getElementById('allinBtn');
    if(allinBtn) allinBtn.onclick = () => send({type:'action', action:'allin'});
    const raiseBtn = document.getElementById('raiseBtn');
    if(raiseBtn) raiseBtn.onclick = () => {
      const v = parseInt(document.getElementById('raiseInput').value,10);
      if(!v || v<=st.currentBet){ alert('加注金额需大于当前下注'); return; }
      send({type:'action', action:'raise', amount:v});
    };
    document.querySelectorAll('[data-frac]').forEach(b=>{
      b.onclick = () => {
        const frac = parseFloat(b.dataset.frac);
        const need = Math.max(0, st.currentBet - me.betThisStreet);
        const potAfterCall = st.pot + need;
        let target = st.currentBet + Math.round(frac * potAfterCall);
        target = Math.max(target, st.currentBet + 1);
        target = Math.min(target, me.betThisStreet + me.chips);
        const input = document.getElementById('raiseInput');
        if(input) input.value = target;
      };
    });
  }

  // 尝试用本地保存的身份自动重连（同一浏览器刷新页面后不丢失座位）；
  // 若没有正在进行的房间会话，则尝试用保存的账号 token 自动恢复登录状态
  (function init(){
    const lastRoom = prefillRoom || localStorage.getItem('poker_last_room');
    if(lastRoom){
      const saved = localStorage.getItem(storageKey(lastRoom));
      if(saved){
        const s = JSON.parse(saved);
        roomId = lastRoom;
        connect(()=> send({type:'rejoin', roomId: lastRoom, playerToken: s.playerToken}));
        render();
        return;
      }
    }
    const savedAccount = localStorage.getItem('pokergo_account');
    if(savedAccount){
      try{
        const a = JSON.parse(savedAccount);
        if(a && a.accountToken) connect(()=> send({type:'account_auth', accountToken: a.accountToken}));
      }catch(e){}
    }
    render();
  })();

  // 每秒只更新倒计时的数字文本，不整体重画界面（避免打断正在输入的加注框）
  setInterval(()=>{
    if(!lastState) return;
    const tEl = document.getElementById('turnCountdown');
    if(tEl && lastState.turnDeadline) tEl.textContent = remainingSeconds(lastState.turnDeadline);
    const nEl = document.getElementById('nextHandCountdown');
    if(nEl && lastState.nextHandDeadline) nEl.textContent = remainingSeconds(lastState.nextHandDeadline);
  }, 1000);
})();
