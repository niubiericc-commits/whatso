(function(){
  const SUIT_SYMBOL = { s:'♠', h:'♥', d:'♦', c:'♣' };
  const RANK_LABEL = {11:'J',12:'Q',13:'K',14:'A'};
  // ---------------- 多语言（先覆盖牌桌核心操作，个人中心等说明性文字暂时保留中文） ----------------
  const I18N = {
    stage_lobby:{zh:'等待房主开局',en:'Waiting for host'}, stage_preflop:{zh:'翻牌前',en:'Pre-Flop'},
    stage_flop:{zh:'翻牌',en:'Flop'}, stage_turn:{zh:'转牌',en:'Turn'}, stage_river:{zh:'河牌',en:'River'}, stage_showdown:{zh:'摊牌',en:'Showdown'},
    hand_0:{zh:'高牌',en:'High Card'}, hand_1:{zh:'一对',en:'Pair'}, hand_2:{zh:'两对',en:'Two Pair'}, hand_3:{zh:'三条',en:'Three of a Kind'},
    hand_4:{zh:'顺子',en:'Straight'}, hand_5:{zh:'同花',en:'Flush'}, hand_6:{zh:'葫芦',en:'Full House'}, hand_7:{zh:'四条',en:'Four of a Kind'}, hand_8:{zh:'同花顺',en:'Straight Flush'},
    action_fold:{zh:'弃牌',en:'Fold'}, action_check:{zh:'过牌',en:'Check'}, action_call:{zh:'跟注',en:'Call'}, action_allin:{zh:'全下',en:'All-In'}, action_raise:{zh:'加注',en:'Raise'},
    raise_to:{zh:'加注到…',en:'Raise to…'}, your_turn:{zh:'轮到你了',en:'Your Turn'}, my_hand:{zh:'我的手牌',en:'My Hand'},
    waiting_others:{zh:'等待其他玩家行动…',en:'Waiting for other players…'}, you_folded:{zh:'你本局已弃牌，等待结果…',en:'You folded, waiting for results…'},
    not_seated:{zh:'本局你没有入座，请等待下一局。',en:"You're not seated this hand, please wait for the next one."},
    current_hand:{zh:'当前牌型：',en:'Current Hand: '}, pot:{zh:'底池',en:'Pot'}, current_bet:{zh:'当前下注',en:'Bet'}, action_timer:{zh:'行动倒计时',en:'Timer'},
    join_room:{zh:'加入牌局',en:'Join Table'}, room_code:{zh:'房间码',en:'Room Code'}, your_name_guest:{zh:'你的名字（访客）',en:'Your Name (Guest)'}, join_btn:{zh:'加入',en:'Join'},
    account_login:{zh:'账号登录（可选）',en:'Account Login (optional)'}, username:{zh:'用户名',en:'Username'}, password:{zh:'密码',en:'Password'},
    login_btn:{zh:'登录',en:'Log In'}, register_btn:{zh:'注册新账号',en:'Register'}, logged_in:{zh:'已登录',en:'Logged In'}, logout_btn:{zh:'退出登录',en:'Log Out'},
    quarter_pot:{zh:'1/4 池',en:'1/4 Pot'}, half_pot:{zh:'1/2 池',en:'1/2 Pot'}, three_q_pot:{zh:'3/4 池',en:'3/4 Pot'}, full_pot:{zh:'满池',en:'Pot'},
    profile_btn:{zh:'👤 个人中心',en:'👤 Profile'}, tournaments_btn:{zh:'🏆 查看锦标赛',en:'🏆 Tournaments'}, back_btn:{zh:'← 返回',en:'← Back'},
    sound_setting:{zh:'音效',en:'Sound'}, lang_setting:{zh:'语言',en:'Language'}, theme_setting:{zh:'牌桌主题',en:'Table Theme'},
    hand_hint_setting:{zh:'实时牌型提示',en:'Live Hand Hint'}, quick_raise_setting:{zh:'加注快捷按钮',en:'Quick Raise Buttons'}
  };
  function getStrSetting(key, def){ const v = localStorage.getItem('pokergo_setting_'+key); return v===null ? def : v; }
  function setStrSetting(key, val){ localStorage.setItem('pokergo_setting_'+key, val); }
  function t(key){ const lang = getStrSetting('lang','zh'); return (I18N[key] && I18N[key][lang]) || (I18N[key] && I18N[key].zh) || key; }

  // ---------------- 音效：用浏览器自带的 Web Audio API 合成简单提示音，不需要任何外部音频文件 ----------------
  let audioCtx = null;
  function playTone(freq, duration, type, volume){
    if(!getSetting('soundOn', true)) return;
    try{
      if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      if(audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine'; osc.frequency.value = freq;
      gain.gain.value = volume===undefined?0.15:volume;
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.stop(audioCtx.currentTime + duration);
    }catch(e){}
  }
  function soundYourTurn(){ playTone(660,0.15,'sine',0.15); setTimeout(()=>playTone(880,0.18,'sine',0.15),150); }
  function soundAction(){ playTone(320,0.08,'square',0.08); }
  function soundWin(){ playTone(523,0.12,'sine',0.15); setTimeout(()=>playTone(659,0.12,'sine',0.15),110); setTimeout(()=>playTone(784,0.25,'sine',0.15),220); }
  function applyTheme(theme){
    setStrSetting('theme', theme);
    if(theme === 'emerald') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', theme);
  }
  let lastTurnWasMine = false;
  let lastSoundedShowdownHand = null;

  const STAGE_LABEL_KEYS = { lobby:'stage_lobby', preflop:'stage_preflop', flop:'stage_flop', turn:'stage_turn', river:'stage_river', showdown:'stage_showdown' };
  function stageLabel(stage){ return t(STAGE_LABEL_KEYS[stage] || stage); }
  function handNameLabel(idx){ return t('hand_'+idx); }

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
  let viewMode = 'join';    // 'join' | 'tournaments' | 'profile'
  let publicTablesLoaded = false;
  let tournamentList = [];
  let lobbyCategory = 'holdem'; // 'holdem' | 'omaha' | 'free'
  let pendingTournamentId = localStorage.getItem('pokergo_pending_tournament') || null;
  let tournamentEndInfo = null; // {eliminated:true, rank} 或 {results}
  let tournamentPollTimer = null;

  // 个人中心
  let profileTab = 'mypage'; // mypage | promotion | gamesetting | reward
  let profileData = null;
  let promotionData = null;
  let rewardsConfig = null;
  let profileBusy = false;
  const AVATAR_CHOICES = ['🂠','🐯','🐉','🦁','🐺','🦊','🐸','🐧','🦄','🎩','😎','🤠','👑','💀','🃏'];
  function getSetting(key, def){ const v = localStorage.getItem('pokergo_setting_'+key); return v===null ? def : v==='1'; }
  function setSetting(key, val){ localStorage.setItem('pokergo_setting_'+key, val?'1':'0'); }

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
    return best ? handNameLabel(best[0]) : null;
  }
  // 奥马哈：必须正好用 2 张底牌 + 3 张公共牌，跟德州"任选5张"不一样
  function currentHandNameOmaha(hole, community){
    if(!community || community.length<3) return null;
    let best=null;
    combinations(hole,2).forEach(hp=>{
      combinations(community,3).forEach(bt=>{
        const v = handValue([...hp,...bt]);
        if(!best||compareVal(v,best)>0) best=v;
      });
    });
    return best ? handNameLabel(best[0]) : null;
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

  // ---------------- 个人中心：普通 HTTP 请求，不走 WebSocket ----------------
  async function apiGet(path, useAccount){
    const headers = useAccount && account ? {'X-Account-Token': account.accountToken} : {};
    const res = await fetch(path, { headers });
    let data = {}; try{ data = await res.json(); }catch(e){}
    if(!res.ok) throw new Error(data.error || ('请求失败（状态码 '+res.status+'）'));
    return data;
  }
  async function apiPost(path, body, useAccount){
    const headers = Object.assign({'Content-Type':'application/json'}, useAccount && account ? {'X-Account-Token': account.accountToken} : {});
    const res = await fetch(path, { method:'POST', headers, body: JSON.stringify(body||{}) });
    let data = {}; try{ data = await res.json(); }catch(e){}
    if(!res.ok) throw new Error(data.error || ('请求失败（状态码 '+res.status+'）'));
    return data;
  }

  async function openProfile(){
    if(!account){ alert('请先登录账号'); return; }
    viewMode = 'profile'; profileTab = 'mypage'; lastError = null;
    render();
    await refreshProfile();
  }
  async function refreshProfile(){
    try{
      profileData = await apiGet('/api/profile', true);
      lastError = null;
    }catch(e){ lastError = e.message; }
    render();
  }
  async function refreshPromotion(){
    try{ promotionData = await apiGet('/api/promotion', false); }
    catch(e){ /* 推广信息拉取失败就静默，不打扰 */ }
    render();
  }
  async function refreshRewardsConfig(){
    try{ rewardsConfig = await apiGet('/api/rewards-config', false); }
    catch(e){ /* 静默失败 */ }
    render();
  }
  async function redeemShopItem(itemId){
    profileBusy = true; render();
    try{
      await apiPost('/api/profile/redeem-shop', { itemId }, true);
      lastError = null;
      await refreshProfile();
    }catch(e){ lastError = e.message; profileBusy = false; render(); }
  }

  // ---------------- 大厅：公开现金桌列表，不需要房间码就能直接坐下 ----------------
  let publicTables = [];
  async function refreshPublicTables(){
    try{ const r = await apiGet('/api/tables', false); publicTables = r.tables; lastError = null; }
    catch(e){ /* 静默失败，不打扰 */ }
    render();
  }
  function joinPublicTable(tableId){
    if(account){ joinRoom(tableId, null); }
    else {
      const name = prompt('输入你的名字（访客加入）：');
      if(!name) return;
      joinRoom(tableId, name.trim());
    }
  }

  // 常驻顶部导航：登录界面之外的三大板块之间可以直接切换，不用先"返回"
  function renderTopNav(active){
    const tabs = [
      { id:'join', icon:'🏠', label:'大厅' },
      { id:'tournaments', icon:'🏆', label:'锦标赛' },
      { id:'profile', icon:'👤', label:'我的' }
    ];
    return `<div class="sub-tabs" style="margin-bottom:14px;">
      ${tabs.map(tb=>`<button class="${active===tb.id?'active':''}" data-nav="${tb.id}">${tb.icon} ${tb.label}</button>`).join('')}
    </div>`;
  }
  function bindTopNav(){
    document.querySelectorAll('[data-nav]').forEach(b=>{
      b.onclick = () => {
        const target = b.dataset.nav;
        if(target === 'profile'){ openProfile(); return; }
        if(target === 'tournaments'){ viewMode='tournaments'; fetchTournamentList(); return; }
        if(target === 'join'){ viewMode='join'; refreshPublicTables(); }
        render();
      };
    });
  }

  // ---------------- 新赛事通知订阅：定期轮询 + 浏览器原生通知，不需要任何推送服务 ----------------
  let notifyTimer = null;
  let knownTournamentIds = null;
  async function checkNewTournaments(){
    try{
      const r = await apiGet('/api/tournaments', false);
      const currentIds = new Set(r.tournaments.filter(t=>t.status==='registering').map(t=>t.id));
      if(knownTournamentIds){
        r.tournaments.forEach(t=>{
          if(t.status==='registering' && !knownTournamentIds.has(t.id)){
            if('Notification' in window && Notification.permission==='granted'){
              new Notification('新赛事开放报名：'+t.name, { body: '门票 '+t.ticketPrice+' 俱乐部积分，快去看看吧！' });
            }
          }
        });
      }
      knownTournamentIds = currentIds;
    }catch(e){ /* 静默失败，不打扰用户 */ }
  }
  function startTournamentNotifyWatcher(){
    stopTournamentNotifyWatcher();
    checkNewTournaments();
    notifyTimer = setInterval(checkNewTournaments, 20000);
  }
  function stopTournamentNotifyWatcher(){ clearInterval(notifyTimer); notifyTimer = null; }
  async function changeAvatar(avatar){
    profileBusy = true; render();
    try{
      await apiPost('/api/profile/avatar', { avatar }, true);
      await refreshProfile();
    }catch(e){ lastError = e.message; }
    profileBusy = false; render();
  }
  async function redeemCoupon(code){
    if(!code){ alert('请输入兑换码'); return; }
    profileBusy = true; render();
    try{
      await apiPost('/api/profile/redeem', { code }, true);
      lastError = null;
      await refreshProfile();
    }catch(e){ lastError = e.message; profileBusy = false; render(); }
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

      // 分支3：锦标赛列表 —— 按 Omaha / Hold'em / 免费比赛 三个分类展示
      if(viewMode === 'tournaments'){
        if(!lobbyCategory) lobbyCategory = 'holdem';
        const categorize = t => t.ticketPrice===0 ? 'free' : (t.gameType==='omaha' ? 'omaha' : 'holdem');
        const filtered = tournamentList.filter(t => categorize(t) === lobbyCategory);
        const counts = { omaha:0, holdem:0, free:0 };
        tournamentList.forEach(t => counts[categorize(t)]++);

        const rows = filtered.map(t => `
          <div class="card">
            <h3 style="font-family:var(--font-display);font-size:20px;margin:0 0 4px;color:var(--gold-bright);">${esc(t.name)} <span class="seat-allin-tag" style="background:var(--gold);color:var(--ink);">${t.gameType==='omaha'?'Omaha':"Hold'em"}</span></h3>
            <p class="section-sub" style="margin:0 0 8px;">${t.status==='registering'?'报名中':t.status==='running'?'进行中':'已结束'} · ${t.ticketPrice===0?'免费':'门票 '+t.ticketPrice+' 俱乐部积分'} · 已报名 ${t.registeredCount} 人</p>
            <p class="section-sub" style="margin:0 0 10px;">🥇 ${esc(t.prizes[1])}　🥈 ${esc(t.prizes[2])}　🥉 ${esc(t.prizes[3])}</p>
            ${t.status==='registering' ? `<button class="btn btn-primary btn-sm auto" data-reg="${t.id}">${t.ticketPrice===0?'免费报名':'花 '+t.ticketPrice+' 积分报名'}</button>` : ''}
            ${t.status==='finished' && t.results ? `<div class="hint-box">${[1,2,3].map(r=>t.results[r]?(r===1?'🥇':r===2?'🥈':'🥉')+esc(t.results[r].username):'').filter(Boolean).join('　')}</div>` : ''}
          </div>`).join('') || '<p class="section-sub">这个分类下目前没有赛事</p>';

        app.innerHTML = `
          ${renderTopNav('tournaments')}
          ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
          <div class="card">
            <p class="section-sub">${account ? '俱乐部积分：<strong style="color:var(--gold-bright);">'+accountClubPoints+'</strong>' : '登录账号后才能报名，请先去"我的"登录'}</p>
          </div>
          <div class="sub-tabs">
            <button class="${lobbyCategory==='holdem'?'active':''}" data-lobbycat="holdem">Hold'em (${counts.holdem})</button>
            <button class="${lobbyCategory==='omaha'?'active':''}" data-lobbycat="omaha">Omaha (${counts.omaha})</button>
            <button class="${lobbyCategory==='free'?'active':''}" data-lobbycat="free">免费比赛 (${counts.free})</button>
          </div>
          ${rows}
        `;
        bindTopNav();
        document.querySelectorAll('[data-lobbycat]').forEach(b=>{
          b.onclick = () => { lobbyCategory = b.dataset.lobbycat; render(); };
        });
        document.querySelectorAll('[data-reg]').forEach(b=>{
          b.onclick = () => registerForTournament(b.dataset.reg);
        });
        return;
      }

      // 分支3.5：个人中心
      if(viewMode === 'profile'){
        const tabsHtml = `
          <div class="sub-tabs">
            <button class="${profileTab==='mypage'?'active':''}" data-ptab="mypage">MyPage</button>
            <button class="${profileTab==='promotion'?'active':''}" data-ptab="promotion">Promotion</button>
            <button class="${profileTab==='gamesetting'?'active':''}" data-ptab="gamesetting">GameSetting</button>
            <button class="${profileTab==='reward'?'active':''}" data-ptab="reward">Reward</button>
          </div>`;

        let tabBody = '<p class="section-sub">正在加载…</p>';
        if(profileTab === 'mypage' && profileData){
          const p = profileData;
          const avatarGrid = AVATAR_CHOICES.map(a => `<button class="avatar-choice ${a===p.avatar?'picked':''}" data-avatar="${esc(a)}" ${profileBusy?'disabled':''}>${a}</button>`).join('');
          const historyRows = (p.history||[]).slice(0,20).map(h => `
            <div class="showdown-row">
              <span>${new Date(h.time).toLocaleString('zh-CN')} · ${esc(h.note||'')}</span>
              <span style="color:${h.delta>=0?'var(--gold-bright)':'var(--burgundy-bright)'};">${h.delta>=0?'+':''}${h.delta}　余额 ${h.balance}</span>
            </div>`).join('') || '<p class="section-sub">还没有交易记录</p>';
          const couponRows = (p.coupons||[]).map(c => `
            <div class="showdown-row"><span>${esc(c.code)}</span><span>+${c.amount} · ${new Date(c.time).toLocaleDateString('zh-CN')}</span></div>`).join('') || '<p class="section-sub">还没有兑换过优惠券</p>';

          tabBody = `
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">头像 ${p.tier && p.tier!=='none' ? '<span class="seat-allin-tag" style="background:var(--gold);color:var(--ink);">'+p.tier+'</span>' : ''}</h2>
              <p class="section-sub">当前头像：<span style="font-size:22px;">${p.avatar}</span></p>
              <div class="avatar-grid">${avatarGrid}</div>
            </div>
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">我的余额</h2>
              <div class="stat-row-2">
                <div><div class="big-num">${p.points}</div><div class="section-sub" style="margin:0;">筹码积分</div></div>
                <div><div class="big-num">${p.clubPoints}</div><div class="section-sub" style="margin:0;">俱乐部积分</div></div>
              </div>
              <p class="hint-box" style="margin-top:12px;">这里只显示余额，没有充值/提现功能——筹码积分靠打现金桌赢得，俱乐部积分靠管理员发放或兑换码获得。</p>
            </div>
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">交易记录</h2>
              ${historyRows}
            </div>
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">优惠券兑换</h2>
              <div class="field"><label>兑换码</label><input type="text" id="couponInput" placeholder="输入兑换码" style="text-transform:uppercase;"></div>
              <div class="btn-row"><button class="btn btn-primary auto" id="redeemBtn" ${profileBusy?'disabled':''}>兑换</button></div>
              <div style="margin-top:14px;">${couponRows}</div>
            </div>`;
        } else if(profileTab === 'promotion'){
          if(!promotionData) refreshPromotion();
          const promo = promotionData;
          const announcementHtml = (promo && promo.announcement && promo.announcement.title) ? `
            <div class="card">
              <h2 class="section-title">📢 ${esc(promo.announcement.title)}</h2>
              <p class="section-sub" style="white-space:pre-wrap;">${esc(promo.announcement.body)}</p>
            </div>` : '';

          const pkgRows = (promo && promo.packages || []).map(p => `
            <div class="showdown-row">
              <span>¥${p.amountRMB}</span>
              <span>${p.tickets>0?p.tickets+' 张门票　':''}${p.clubPoints>0?'+'+p.clubPoints+' 俱乐部积分　':''}${esc(p.note||'')}</span>
            </div>`).join('');
          const packagesHtml = `
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">💰 充值套餐</h2>
              <p class="section-sub">系统不直接收款——转账给俱乐部管理员后，报上你的账号名，管理员会在后台给你加对应的门票/积分。</p>
              ${pkgRows || '<p class="section-sub">目前没有充值套餐。</p>'}
            </div>`;

          const tiers = (promo && promo.tiers) || {};
          const myTier = (profileData && profileData.tier) || 'none';
          const tiersHtml = `
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">⭐ 会员等级</h2>
              <p class="section-sub">我的等级：<strong style="color:var(--gold-bright);">${myTier==='none'?'普通用户':myTier}</strong></p>
              ${tiers.VIP ? `<div class="hint-box" style="margin-bottom:10px;"><strong style="color:var(--gold-bright);">VIP</strong>　${esc(tiers.VIP)}</div>` : ''}
              ${tiers.SVIP ? `<div class="hint-box"><strong style="color:var(--gold-bright);">SVIP</strong>　${esc(tiers.SVIP)}</div>` : ''}
              ${(!tiers.VIP && !tiers.SVIP) ? '<p class="section-sub">目前没有会员等级说明。</p>' : ''}
              <p class="section-sub" style="margin-top:10px;">升级会员同样需要联系俱乐部管理员线下办理。</p>
            </div>`;

          const notifyOn = getSetting('notifyNewTournaments', false);
          const notifyHtml = `
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">🔔 订阅赛事通知</h2>
              <p class="section-sub">开启后，只要保持这个页面开着（浏览器允许通知的情况下），一有新赛事开放报名就会弹通知提醒你，不需要一直盯着看。</p>
              <div class="setting-row">
                <div>新赛事开放报名提醒</div>
                <label class="switch"><input type="checkbox" id="setNotify" ${notifyOn?'checked':''}><span></span></label>
              </div>
            </div>`;

          tabBody = announcementHtml + packagesHtml + tiersHtml + notifyHtml;
        } else if(profileTab === 'gamesetting'){
          const hintOn = getSetting('showHandHint', true);
          const quickRaiseOn = getSetting('showQuickRaise', true);
          const soundOn = getSetting('soundOn', true);
          const curLang = getStrSetting('lang', 'zh');
          const curTheme = getStrSetting('theme', 'emerald');
          const THEMES = [
            {id:'emerald', label:curLang==='en'?'Emerald':'翡翠绿', color:'#184a37'},
            {id:'sapphire', label:curLang==='en'?'Sapphire':'蓝宝石', color:'#164a7a'},
            {id:'ruby', label:curLang==='en'?'Ruby':'红宝石', color:'#6e1a26'},
            {id:'midnight', label:curLang==='en'?'Midnight':'午夜紫', color:'#2a2a52'}
          ];
          tabBody = `
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">GameSetting</h2>
              <div class="setting-row">
                <div><div>${t('hand_hint_setting')}</div><div class="section-sub" style="margin:0;">${curLang==='en'?'Show "Current Hand: xxx" after the flop':'翻牌后显示"当前牌型：xxx"'}</div></div>
                <label class="switch"><input type="checkbox" id="setHint" ${hintOn?'checked':''}><span></span></label>
              </div>
              <div class="setting-row">
                <div><div>${t('quick_raise_setting')}</div><div class="section-sub" style="margin:0;">${curLang==='en'?'Show 1/4, 1/2, 3/4, Pot quick buttons':'显示 1/4池 1/2池 3/4池 满池 快捷按钮'}</div></div>
                <label class="switch"><input type="checkbox" id="setQuickRaise" ${quickRaiseOn?'checked':''}><span></span></label>
              </div>
              <div class="setting-row">
                <div><div>${t('sound_setting')}</div><div class="section-sub" style="margin:0;">${curLang==='en'?'Turn alert, action click, win chime':'轮到你、点击操作、摊牌获胜的提示音'}</div></div>
                <label class="switch"><input type="checkbox" id="setSound" ${soundOn?'checked':''}><span></span></label>
              </div>
            </div>
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">${t('lang_setting')}</h2>
              <div class="btn-row">
                <button class="btn ${curLang==='zh'?'btn-primary':'btn-ghost'} btn-sm auto" data-lang="zh">中文</button>
                <button class="btn ${curLang==='en'?'btn-primary':'btn-ghost'} btn-sm auto" data-lang="en">English</button>
              </div>
              <p class="section-sub" style="margin-top:10px;">${curLang==='en'?'Currently covers table/action UI. Profile & admin panels stay in Chinese for now.':'目前覆盖牌桌操作界面，个人中心等说明性文字暂时还是中文。'}</p>
            </div>
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">${t('theme_setting')}</h2>
              <div class="theme-grid">
                ${THEMES.map(th=>`
                  <div class="theme-swatch ${curTheme===th.id?'picked':''}" data-theme="${th.id}">
                    <div class="dot" style="background:${th.color};"></div>
                    <div class="label">${th.label}</div>
                  </div>`).join('')}
              </div>
            </div>`;
        } else if(profileTab === 'reward'){
          if(!rewardsConfig) refreshRewardsConfig();
          const p = profileData;
          const growth = (p && p.growth) || 0;
          const myLevel = (p && p.level) || 0;
          const levels = (rewardsConfig && rewardsConfig.levels) || [];
          const nextLevel = levels.find(l => l.level > myLevel);
          const progressHtml = `
            <div class="card">
              <h2 class="section-title" style="font-size:20px;">我的成长值</h2>
              <div class="stat-row-2">
                <div><div class="big-num">${growth}</div><div class="section-sub" style="margin:0;">成长值</div></div>
                <div><div class="big-num">Lv.${myLevel}</div><div class="section-sub" style="margin:0;">当前等级</div></div>
              </div>
              ${nextLevel ? `<p class="section-sub" style="margin-top:10px;">距离 Lv.${nextLevel.level}（${esc(nextLevel.rewardText)}）还差 ${Math.max(0,nextLevel.threshold-growth)} 成长值</p>` : '<p class="section-sub" style="margin-top:10px;">已经是最高等级啦</p>'}
              <p class="hint-box" style="margin-top:10px;">成长值由实际消费换算而来（转账给俱乐部管理员后，管理员在后台帮你录入），达到门槛自动升级并发放奖励。</p>
            </div>`;

          const levelRows = levels.map(l => `
            <div class="showdown-row">
              <span>${myLevel>=l.level?'✅':'🔒'} Lv.${l.level}（满 ${l.threshold} 成长值）</span>
              <span>${esc(l.rewardText)}${l.rewardClubPoints?' +'+l.rewardClubPoints+'积分':''}</span>
            </div>`).join('') || '<p class="section-sub">管理员还没设置等级奖励</p>';
          const levelsHtml = `<div class="card"><h2 class="section-title" style="font-size:20px;">等级奖励</h2>${levelRows}</div>`;

          const shopItems = (rewardsConfig && rewardsConfig.shop) || [];
          const shopRows = shopItems.map(s => `
            <div class="showdown-row">
              <span>${esc(s.name)}${s.note?'（'+esc(s.note)+'）':''} · 需要 ${s.costGrowth} 成长值</span>
              <button class="btn btn-ghost btn-sm auto" data-shopitem="${s.id}" ${growth<s.costGrowth||profileBusy?'disabled':''}>兑换</button>
            </div>`).join('') || '<p class="section-sub">积分商城还没有上架商品</p>';
          const shopHtml = `<div class="card"><h2 class="section-title" style="font-size:20px;">积分商城</h2>${shopRows}</div>`;

          const rewards = (p && p.rewards) || [];
          const rewardRows = rewards.map(r => {
            let left, right;
            if(r.kind === 'level'){ left = '⭐ Lv.'+r.level+' 升级奖励'; right = esc(r.prize); }
            else if(r.kind === 'shop'){ left = '🛍️ 商城兑换'; right = esc(r.prize); }
            else { const medal={1:'🥇',2:'🥈',3:'🥉'}; left = (medal[r.rank]||'')+' '+esc(r.tournamentName||''); right = esc(r.prize); }
            return `<div class="showdown-row"><span>${left}</span><span>${right} · ${new Date(r.time).toLocaleDateString('zh-CN')}</span></div>`;
          }).join('') || '<p class="section-sub">还没有获奖记录，去参加锦标赛或者升级试试！</p>';
          const rewardListHtml = `<div class="card"><h2 class="section-title" style="font-size:20px;">我的获奖记录</h2>${rewardRows}</div>`;

          tabBody = progressHtml + levelsHtml + shopHtml + rewardListHtml;
        }

        app.innerHTML = `
          ${renderTopNav('profile')}
          ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
          ${tabsHtml}
          ${tabBody}
        `;
        bindTopNav();
        document.querySelectorAll('[data-ptab]').forEach(b=>{
          b.onclick = () => {
            profileTab = b.dataset.ptab;
            if(profileTab==='promotion') refreshPromotion();
            else if(profileTab==='reward') refreshRewardsConfig();
            else render();
          };
        });
        document.querySelectorAll('[data-avatar]').forEach(b=>{
          b.onclick = () => changeAvatar(b.dataset.avatar);
        });
        document.querySelectorAll('[data-shopitem]').forEach(b=>{
          b.onclick = () => redeemShopItem(b.dataset.shopitem);
        });
        const redeemBtn = document.getElementById('redeemBtn');
        if(redeemBtn) redeemBtn.onclick = () => redeemCoupon(document.getElementById('couponInput').value.trim());
        const setHint = document.getElementById('setHint');
        if(setHint) setHint.onchange = () => setSetting('showHandHint', setHint.checked);
        const setQuickRaise = document.getElementById('setQuickRaise');
        if(setQuickRaise) setQuickRaise.onchange = () => setSetting('showQuickRaise', setQuickRaise.checked);
        const setSound = document.getElementById('setSound');
        if(setSound) setSound.onchange = () => { setSetting('soundOn', setSound.checked); if(setSound.checked) playTone(440,0.12); };
        document.querySelectorAll('[data-lang]').forEach(b=>{
          b.onclick = () => { setStrSetting('lang', b.dataset.lang); render(); };
        });
        document.querySelectorAll('[data-theme]').forEach(b=>{
          b.onclick = () => { applyTheme(b.dataset.theme); render(); };
        });
        const setNotify = document.getElementById('setNotify');
        if(setNotify) setNotify.onchange = async () => {
          if(setNotify.checked){
            if(!('Notification' in window)){ alert('你的浏览器不支持通知功能'); setNotify.checked=false; return; }
            const perm = await Notification.requestPermission();
            if(perm !== 'granted'){ alert('没有获得通知权限，无法开启提醒'); setNotify.checked=false; return; }
            setSetting('notifyNewTournaments', true);
            startTournamentNotifyWatcher();
          } else {
            setSetting('notifyNewTournaments', false);
            stopTournamentNotifyWatcher();
          }
        };
        return;
      }

      // 分支4：默认——房间码加入 / 账号登录
      const lastRoom = prefillRoom || localStorage.getItem('poker_last_room') || '';

      const accountBlock = account ? `
        <div class="card">
          <h2 class="section-title" style="font-size:20px;">${esc(account.username)}</h2>
          <p class="section-sub">筹码积分：<strong style="color:var(--gold-bright);">${accountPoints}</strong>　俱乐部积分：<strong style="color:var(--gold-bright);">${accountClubPoints}</strong></p>
          <div class="btn-row"><button class="btn btn-ghost btn-sm auto" id="logoutBtn">${t('logout_btn')}</button></div>
        </div>` : `
        <div class="card">
          <h2 class="section-title" style="font-size:20px;">${t('account_login')}</h2>
          <p class="section-sub">登录后积分会持久保存在服务器上，下次登录还能接着用；不登录也可以直接以访客身份坐下，但积分不会保留，也无法参加锦标赛。</p>
          <div class="field"><label>${t('username')}</label><input type="text" id="authUser" maxlength="20"></div>
          <div class="field"><label>${t('password')}</label><input type="password" id="authPass" maxlength="40"></div>
          <div class="btn-row">
            <button class="btn btn-primary auto" id="loginBtn">${t('login_btn')}</button>
            <button class="btn btn-ghost auto" id="registerBtn">${t('register_btn')}</button>
          </div>
        </div>`;

      if(!publicTablesLoaded){ publicTablesLoaded = true; refreshPublicTables(); }
      const tableRows = publicTables.map(tb => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
            <div>
              <h3 style="font-family:var(--font-display);font-size:19px;margin:0 0 4px;color:var(--gold-bright);">${esc(tb.name)}</h3>
              <p class="section-sub" style="margin:0;">盲注 ${tb.smallBlind}/${tb.bigBlind} · 起始筹码 ${tb.startingChips} · 在座 ${tb.playerCount}/${tb.maxPlayers}</p>
            </div>
            <button class="btn btn-primary btn-sm auto" data-jointable="${tb.id}" ${tb.playerCount>=tb.maxPlayers?'disabled':''}>${tb.playerCount>=tb.maxPlayers?'已满':'坐下'}</button>
          </div>
        </div>`).join('') || '<div class="card"><p class="section-sub">目前没有公开的现金桌，创建一桌并勾选"公开"就会出现在这里，或者用房间码加入私密桌。</p></div>';

      app.innerHTML = `
        ${renderTopNav('join')}
        ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
        ${accountBlock}
        <h2 class="section-title" style="font-size:20px;margin:0 0 10px;">🃏 现金桌</h2>
        ${tableRows}
        <div class="card">
          <h2 class="section-title" style="font-size:16px;margin:0 0 6px;">用房间码加入私密桌</h2>
          <div class="field"><label>${t('room_code')}</label><input type="text" id="roomInput" value="${esc(lastRoom)}" maxlength="6" style="text-transform:uppercase;letter-spacing:.2em;text-align:center;font-size:20px;"></div>
          ${account ? '' : `<div class="field"><label>${t('your_name_guest')}</label><input type="text" id="nameInput" maxlength="20" placeholder="输入姓名"></div>`}
          <div class="btn-row"><button class="btn btn-ghost" id="joinBtn">${t('join_btn')}</button></div>
        </div>`;

      bindTopNav();
      document.querySelectorAll('[data-jointable]').forEach(b=>{
        b.onclick = () => joinPublicTable(b.dataset.jointable);
      });
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
    const potlineExtra = (st.stage!=='showdown' && turnSecs!==null) ? `　${t('action_timer')}：<span id="turnCountdown">${turnSecs}</span>s` : '';
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
      <div class="table-strip"><span>${st.gameType==='omaha'?'🂡 Omaha':"🂡 Hold'em"}　${getStrSetting('lang','zh')==='en' ? 'Hand #'+st.handNumber+' · '+stageLabel(st.stage) : '第 '+st.handNumber+' 局 · '+stageLabel(st.stage)}</span><span>${potlineExtra.replace('　','')}</span></div>
      <div class="poker-table-wrap">
        <div class="poker-table-rail">
          <div class="poker-table-felt">
            <div class="table-center">
              <div class="table-pot"><span class="chip-ico"></span>${t('pot')} ${st.pot}${st.currentBet?'　'+t('current_bet')+' '+st.currentBet:''}</div>
              <div class="table-community">${communityCards}</div>
            </div>
            ${seatsHtml}
          </div>
        </div>
      </div>`;

    let panel = '';
    if(st.stage==='showdown'){
      if(lastSoundedShowdownHand !== st.handNumber){
        lastSoundedShowdownHand = st.handNumber;
        const iWon = (st.results||[]).some(r => r.winners.includes(me && me.name));
        if(iWon) soundWin();
      }
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
      panel = `<div class="turn-panel"><p class="section-sub">${t('not_seated')}</p></div>`;
    } else if(me){
      // 手牌全程展示（只要你在场、没弃牌），不再只在轮到你时才显示
      const myCardsHtml = (me.cards||[]).length
        ? `<div class="hole-cards ${me.cards.length>2?'omaha':''}">${me.cards.map(c=>cardHtml(c)).join('')}</div>`
        : '';
      const myHandName = st.gameType==='omaha'
        ? currentHandNameOmaha(me.cards||[], st.community||[])
        : currentHandName([...(me.cards||[]), ...(st.community||[])]);
      const handNameHtml = (myHandName && getSetting('showHandHint', true)) ? `<div style="font-family:var(--font-mono);font-size:12px;color:var(--gold-bright);margin-bottom:8px;">${t('current_hand')}${esc(myHandName)}</div>` : '';
      const isMyTurn = st.turn === st.players.indexOf(me);
      if(isMyTurn && !me.folded && !lastTurnWasMine) soundYourTurn();
      lastTurnWasMine = isMyTurn && !me.folded;
      let bottom;
      if(me.folded){
        bottom = `<p class="section-sub" style="margin-top:10px;">${t('you_folded')}</p>`;
      } else if(!isMyTurn){
        bottom = `<p class="section-sub" style="margin-top:10px;">${t('waiting_others')}</p>`;
      } else {
        const need = st.currentBet - me.betThisStreet;
        const quickRaiseHtml = getSetting('showQuickRaise', true) ? `
          <div class="pot-quick-row">
            <button class="btn btn-ghost btn-sm auto" data-frac="0.25">${t('quarter_pot')}</button>
            <button class="btn btn-ghost btn-sm auto" data-frac="0.5">${t('half_pot')}</button>
            <button class="btn btn-ghost btn-sm auto" data-frac="0.75">${t('three_q_pot')}</button>
            <button class="btn btn-ghost btn-sm auto" data-frac="1">${t('full_pot')}</button>
          </div>` : '';
        bottom = `
          <div class="action-row">
            <button class="btn btn-danger" id="foldBtn">${t('action_fold')}</button>
            <button class="btn btn-blue" id="callBtn">${need<=0?t('action_check'):t('action_call')+' '+need}</button>
            <button class="btn btn-ghost" id="allinBtn">${t('action_allin')} (${me.chips})</button>
          </div>
          ${quickRaiseHtml}
          <div class="raise-box">
            <input type="number" id="raiseInput" placeholder="${t('raise_to')}" min="${st.currentBet+1}">
            <button class="btn btn-primary auto" id="raiseBtn">${t('action_raise')}</button>
          </div>`;
      }
      panel = `
        <div class="turn-panel">
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">${isMyTurn && !me.folded ? t('your_turn') : t('my_hand')}</div>
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
    if(foldBtn) foldBtn.onclick = () => { soundAction(); send({type:'action', action:'fold'}); };
    const callBtn = document.getElementById('callBtn');
    if(callBtn) callBtn.onclick = () => { soundAction(); send({type:'action', action: (st.currentBet - me.betThisStreet)<=0 ? 'check':'call'}); };
    const allinBtn = document.getElementById('allinBtn');
    if(allinBtn) allinBtn.onclick = () => { soundAction(); send({type:'action', action:'allin'}); };
    const raiseBtn = document.getElementById('raiseBtn');
    if(raiseBtn) raiseBtn.onclick = () => {
      const v = parseInt(document.getElementById('raiseInput').value,10);
      if(!v || v<=st.currentBet){ alert('加注金额需大于当前下注'); return; }
      soundAction();
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
    const savedTheme = getStrSetting('theme', 'emerald');
    if(savedTheme !== 'emerald') document.body.setAttribute('data-theme', savedTheme);
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
    if(getSetting('notifyNewTournaments', false) && 'Notification' in window && Notification.permission==='granted'){
      startTournamentNotifyWatcher();
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
