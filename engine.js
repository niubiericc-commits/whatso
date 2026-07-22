(function(){
  const SUIT_SYMBOL = { s:'♠', h:'♥', d:'♦', c:'♣' };
  const RANK_LABEL = {11:'J',12:'Q',13:'K',14:'A'};
  const STAGE_LABEL = { lobby:'等待开局', preflop:'翻牌前', flop:'翻牌', turn:'转牌', river:'河牌', showdown:'摊牌' };

  let ws = null;
  let roomId = localStorage.getItem('poker_host_roomId') || null;
  let hostToken = localStorage.getItem('poker_host_token') || null;
  let lastState = null;
  let lastError = null;
  let connectTimeoutTimer = null;

  function doReset(){
    localStorage.removeItem('poker_host_roomId');
    localStorage.removeItem('poker_host_token');
    roomId = null; hostToken = null; lastState = null; lastError = null;
    clearTimeout(connectTimeoutTimer);
    render();
  }

  function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function cardHtml(c){
    if(!c) return '<div class="pcard back"></div>';
    const red = (c.s==='h'||c.s==='d');
    const label = RANK_LABEL[c.r] || c.r;
    return `<div class="pcard ${red?'red':'black'}"><span class="r">${label}</span><span class="s">${SUIT_SYMBOL[c.s]}</span></div>`;
  }

  function connect(){
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = () => {
      if(roomId && hostToken){ ws.send(JSON.stringify({type:'host_auth', roomId, hostToken})); }
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if(msg.type === 'host_created'){
        roomId = msg.roomId; hostToken = msg.hostToken;
        localStorage.setItem('poker_host_roomId', roomId);
        localStorage.setItem('poker_host_token', hostToken);
        render();
      } else if(msg.type === 'state'){
        lastState = msg; lastError = null; clearTimeout(connectTimeoutTimer); render();
      } else if(msg.type === 'error'){
        lastError = msg.message; render();
      }
    };
    ws.onclose = () => { setTimeout(connect, 2000); };
  }

  function createRoom(name, sb, bb, chips){
    connect();
    ws.onopen = () => {
      ws.send(JSON.stringify({type:'host_create', roomName:name, smallBlind:sb, bigBlind:bb, startingChips:chips}));
    };
  }

  function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  function render(){
    const app = document.getElementById('app');
    if(!roomId || !hostToken){
      app.innerHTML = `
        <div class="card">
          <h2 class="section-title">创建新牌局</h2>
          <p class="section-sub">生成房间码后，把码和加入地址发给朋友，让他们在自己手机上打开加入。</p>
          <div class="field"><label>牌局名称</label><input type="text" id="rName" value="朋友局"></div>
          <div class="field"><label>起始筹码</label><input type="number" id="rChips" value="1000" min="20"></div>
          <div class="field" style="display:flex;gap:12px;">
            <div style="flex:1"><label>小盲注</label><input type="number" id="rSB" value="5" min="1"></div>
            <div style="flex:1"><label>大盲注</label><input type="number" id="rBB" value="10" min="2"></div>
          </div>
          <div class="btn-row"><button class="btn btn-primary" id="createBtn">创建</button></div>
        </div>`;
      document.getElementById('createBtn').onclick = () => {
        const name = document.getElementById('rName').value.trim() || '朋友局';
        const chips = Math.max(20, parseInt(document.getElementById('rChips').value,10)||1000);
        const sb = Math.max(1, parseInt(document.getElementById('rSB').value,10)||5);
        const bb = Math.max(sb+1, parseInt(document.getElementById('rBB').value,10)||10);
        createRoom(name, sb, bb, chips);
      };
      return;
    }

    if(!lastState){
      const stuckMsg = lastError
        ? `<div class="err-box">${esc(lastError)}</div>
           <p class="section-sub">这通常是因为服务器重启过、之前的房间已经不存在了。点下面按钮清除本地记录，重新创建一个新房间。</p>
           <div class="btn-row"><button class="btn btn-primary" id="resetBtn">清除记录并重新创建</button></div>`
        : `<p class="section-sub">正在连接房间 ${esc(roomId)} …</p>
           <p class="section-sub" id="timeoutHint" style="display:none;">一直连不上？请确认运行 npm start 的那个命令行窗口还开着；如果服务器已重启，点下面按钮重新创建房间。</p>
           <div class="btn-row" id="timeoutBtnRow" style="display:none;"><button class="btn btn-ghost" id="resetBtn2">清除记录并重新创建</button></div>`;
      app.innerHTML = `<div class="card">${stuckMsg}</div>`;
      const resetBtn = document.getElementById('resetBtn');
      if(resetBtn) resetBtn.onclick = doReset;
      const resetBtn2 = document.getElementById('resetBtn2');
      if(resetBtn2) resetBtn2.onclick = doReset;
      if(!lastError){
        clearTimeout(connectTimeoutTimer);
        connectTimeoutTimer = setTimeout(()=>{
          const hint = document.getElementById('timeoutHint');
          const row = document.getElementById('timeoutBtnRow');
          if(hint) hint.style.display='block';
          if(row) row.style.display='flex';
        }, 6000);
      }
      return;
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

    const community = (st.community||[]).map(c=>cardHtml(c)).join('') + Array(Math.max(0,5-(st.community||[]).length)).fill('<div class="pcard empty"></div>').join('');

    const seats = st.players.map((p,i) => {
      if(!p.seated && st.stage!=='lobby') return '';
      const tags=[];
      if(i===st.dealerIdx) tags.push('<span class="tag">D</span>');
      if(i===st.sbIdx) tags.push('<span class="tag">SB</span>');
      if(i===st.bbIdx) tags.push('<span class="tag">BB</span>');
      const cls=['p-seat']; if(i===st.turn) cls.push('turn'); if(p.folded) cls.push('folded');
      return `<div class="${cls.join(' ')}">
        <div class="nm">${esc(p.name)} ${tags.join('')} ${p.allIn?'<span class="tag" style="background:var(--burgundy);color:#fff;">ALL-IN</span>':''}</div>
        <div class="chips">${p.chips} 筹码</div>
        <div class="betamt">本轮下注 ${p.betThisStreet}${!p.connected?' · <span class="disc">已断线</span>':''}</div>
      </div>`;
    }).join('');

    let resultsHtml = '';
    if(st.stage==='showdown' && st.results){
      resultsHtml = `<div class="card"><h2 class="section-title" style="font-size:20px;">本局结果</h2>
        ${st.results.map(r=>`<div class="showdown-row"><span>${esc(r.handName)}</span><span>${r.winners.map(esc).join('、')} + ${r.amount}</span></div>`).join('')}
        <div class="btn-row"><button class="btn btn-primary" id="nextHandBtn">开始下一局</button></div>
      </div>`;
    }

    app.innerHTML = `
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
        ${st.stage==='lobby' ? `<div class="btn-row"><button class="btn btn-primary" id="startBtn" ${st.players.length<2?'disabled':''}>开始游戏</button></div>` : ''}
      </div>

      ${st.stage!=='lobby' ? `
      <div class="gt-board">
        <div class="gt-potline"><span>第 ${st.handNumber} 局 · ${STAGE_LABEL[st.stage]||st.stage}</span><span>底池：${st.pot}　当前下注：${st.currentBet}</span></div>
        <div class="community">${community}</div>
        <div class="players-strip">${seats}</div>
      </div>` : ''}

      ${resultsHtml}

      <div class="card">
        <h2 class="section-title" style="font-size:20px;">盲注设置</h2>
        <div class="field" style="display:flex;gap:12px;">
          <div style="flex:1"><label>小盲注</label><input type="number" id="sbInput" value="${st.smallBlind}" min="1"></div>
          <div style="flex:1"><label>大盲注</label><input type="number" id="bbInput" value="${st.bigBlind}" min="2"></div>
        </div>
        <div class="btn-row"><button class="btn btn-ghost" id="updateBlindsBtn">更新盲注（下一局生效）</button></div>
      </div>

      <div class="hint-box">房主看不到任何玩家的底牌（除非摊牌），保证公平。刷新本页会自动用房间口令重新连接，不会丢失牌局。</div>
    `;

    const copyBtn = document.getElementById('copyBtn');
    if(copyBtn) copyBtn.onclick = () => {
      document.getElementById('joinUrlInput').select();
      navigator.clipboard && navigator.clipboard.writeText(joinUrl);
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
    document.querySelectorAll('[data-kick]').forEach(b=>{
      b.onclick = () => { if(confirm('确认踢出该玩家？')) send({type:'host_kick', playerId:b.dataset.kick}); };
    });
  }

  render();
  if(roomId && hostToken) connect();
})();
