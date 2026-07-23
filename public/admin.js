(function(){
  let ws = null;
  let connSeq = 0;
  let reconnectTimer = null;
  let adminToken = localStorage.getItem('pokergo_admin_token') || null;
  let lastError = null;
  let tournaments = [];
  let lookupResult = null;
  let listTimer = null;

  function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
      if(myConn!==connSeq) return;
      const msg = JSON.parse(ev.data);
      if(msg.type === 'admin_ok'){
        adminToken = msg.adminToken;
        localStorage.setItem('pokergo_admin_token', adminToken);
        lastError = null;
        refreshTournaments();
        render();
      } else if(msg.type === 'admin_tournaments'){
        tournaments = msg.tournaments; lastError = null; render();
      } else if(msg.type === 'admin_account_info'){
        lookupResult = msg; lastError = null; render();
      } else if(msg.type === 'error'){
        lastError = msg.message; render();
      }
    };
    socket.onclose = () => {
      if(myConn!==connSeq) return;
      reconnectTimer = setTimeout(()=>{ if(adminToken) connect(refreshTournaments); }, 2000);
    };
  }

  function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  function refreshTournaments(){ send({type:'admin_list_tournaments', adminToken}); }

  function logout(){
    adminToken = null;
    localStorage.removeItem('pokergo_admin_token');
    clearInterval(listTimer);
    render();
  }

  const STATUS_LABEL = { registering:'报名中', running:'进行中', finished:'已结束' };

  function render(){
    const app = document.getElementById('app');

    if(!adminToken){
      app.innerHTML = `
        <div class="card">
          <h2 class="section-title">管理员登录</h2>
          <p class="section-sub">用管理员密码登录后台，用来建赛事、调整俱乐部积分。</p>
          ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
          <div class="field"><label>管理员密码</label><input type="password" id="adminPass"></div>
          <div class="btn-row"><button class="btn btn-primary" id="adminLoginBtn">登录</button></div>
        </div>`;
      document.getElementById('adminLoginBtn').onclick = () => {
        const pass = document.getElementById('adminPass').value;
        if(!pass){ alert('请输入密码'); return; }
        connect(()=> send({type:'admin_login', password: pass}));
      };
      return;
    }

    if(!listTimer) listTimer = setInterval(refreshTournaments, 4000);
    if(ws==null || ws.readyState!==1) connect(refreshTournaments);

    const tourneyRows = tournaments.map(t => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
          <div>
            <h3 style="font-family:var(--font-display);font-size:22px;margin:0 0 4px;color:var(--gold-bright);">${esc(t.name)}</h3>
            <p class="section-sub" style="margin:0;">状态：${STATUS_LABEL[t.status]||t.status} · 门票 ${t.ticketPrice} 俱乐部积分 · 已报名 ${t.registeredCount} 人 · 在场 ${t.remainingCount} 人 · 每桌最多 ${t.maxTableSize} 人</p>
          </div>
          ${t.status==='registering' ? `<button class="btn btn-primary btn-sm auto" data-start="${t.id}">开赛</button>` : ''}
        </div>
        <div class="hint-box" style="margin-top:10px;">🥇 冠军：${esc(t.prizes[1])}　🥈 亚军：${esc(t.prizes[2])}　🥉 季军：${esc(t.prizes[3])}</div>
        ${t.status==='finished' && t.results ? `
        <div style="margin-top:10px;">
          ${[1,2,3].map(r => t.results[r] ? `<div class="showdown-row"><span>${r===1?'🥇冠军':r===2?'🥈亚军':'🥉季军'} ${esc(t.results[r].username)}</span><span>${esc(t.results[r].prize)}</span></div>` : '').join('')}
        </div>` : ''}
      </div>`).join('') || '<p class="section-sub">还没有创建任何赛事</p>';

    app.innerHTML = `
      ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
      <div class="card">
        <div class="btn-row"><button class="btn btn-ghost btn-sm auto" id="logoutBtn">退出管理员登录</button></div>
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
        <div class="btn-row"><button class="btn btn-primary" id="createBtn">创建赛事</button></div>
      </div>

      <div class="card">
        <h2 class="section-title">赛事列表</h2>
      </div>
      ${tourneyRows}
    `;

    document.getElementById('logoutBtn').onclick = logout;
    document.getElementById('lookupBtn').onclick = () => {
      const u = document.getElementById('lookupUser').value.trim();
      if(!u){ alert('请输入用户名'); return; }
      send({type:'admin_lookup_account', adminToken, username: u});
    };
    const adjustBtn = document.getElementById('adjustBtn');
    if(adjustBtn) adjustBtn.onclick = () => {
      const delta = parseInt(document.getElementById('adjustDelta').value, 10);
      if(!delta){ alert('请输入调整数值'); return; }
      send({type:'admin_adjust_club_points', adminToken, username: lookupResult.username, delta});
    };
    document.getElementById('createBtn').onclick = () => {
      send({
        type:'admin_create_tournament', adminToken,
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
    };
    document.querySelectorAll('[data-start]').forEach(b=>{
      b.onclick = () => {
        if(!confirm('确认开赛吗？开赛后不能再接受新报名。')) return;
        send({type:'admin_start_tournament', adminToken, tournamentId: b.dataset.start});
      };
    });
  }

  if(adminToken) connect(refreshTournaments);
  render();
})();
