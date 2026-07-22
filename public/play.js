(function(){
  const SUIT_SYMBOL = { s:'♠', h:'♥', d:'♦', c:'♣' };
  const RANK_LABEL = {11:'J',12:'Q',13:'K',14:'A'};
  const STAGE_LABEL = { lobby:'等待房主开局', preflop:'翻牌前', flop:'翻牌', turn:'转牌', river:'河牌', showdown:'摊牌' };

  const params = new URLSearchParams(location.search);
  const prefillRoom = (params.get('room')||'').toUpperCase();

  let ws = null;
  let roomId = null, playerId = null, playerToken = null;
  let lastState = null;
  let lastError = null;
  let connSeq = 0;
  let reconnectTimer = null;

  function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function cardHtml(c){
    const red = (c.s==='h'||c.s==='d');
    const label = RANK_LABEL[c.r] || c.r;
    return `<div class="pcard ${red?'red':'black'}"><span class="r">${label}</span><span class="s">${SUIT_SYMBOL[c.s]}</span></div>`;
  }
  function storageKey(rid){ return 'poker_player_' + rid; }
  function remainingSeconds(deadline){ return deadline ? Math.max(0, Math.ceil((deadline - Date.now())/1000)) : null; }

  function connect(onOpen){
    connSeq++;
    const myConn = connSeq;
    clearTimeout(reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(proto + '://' + location.host + '/ws');
    ws = socket;
    socket.onopen = () => { if(myConn===connSeq && onOpen) onOpen(); };
    socket.onmessage = (ev) => {
      if(myConn!==connSeq) return;
      const msg = JSON.parse(ev.data);
      if(msg.type === 'joined'){
        roomId = msg.roomId; playerId = msg.playerId; playerToken = msg.playerToken;
        localStorage.setItem(storageKey(roomId), JSON.stringify({playerId, playerToken}));
        localStorage.setItem('poker_last_room', roomId);
        render();
      } else if(msg.type === 'state'){
        lastState = msg; lastError = null; render();
      } else if(msg.type === 'error'){
        lastError = msg.message; render();
      }
    };
    socket.onclose = () => {
      if(myConn!==connSeq) return;
      reconnectTimer = setTimeout(()=>tryAutoReconnect(), 2000);
    };
  }

  function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  function tryAutoReconnect(){
    if(roomId && playerToken){
      connect(()=> send({type:'rejoin', roomId, playerToken}));
    }
  }

  function joinRoom(rid, name){
    lastState = null; lastError = null; playerId = null;
    const saved = localStorage.getItem(storageKey(rid));
    connect(()=>{
      if(saved){
        const s = JSON.parse(saved);
        send({type:'rejoin', roomId: rid, playerToken: s.playerToken});
      } else {
        send({type:'join', roomId: rid, name});
      }
    });
  }

  function render(){
    const app = document.getElementById('app');

    if(!roomId || !playerId){
      const lastRoom = prefillRoom || localStorage.getItem('poker_last_room') || '';
      app.innerHTML = `
        <div class="card">
          <h2 class="section-title">加入牌局</h2>
          <p class="section-sub">向房主索要 6 位房间码，输入你的名字即可加入。你的手机屏幕只会显示你自己的底牌。</p>
          ${lastError?`<div class="err-box">${esc(lastError)}</div>`:''}
          <div class="field"><label>房间码</label><input type="text" id="roomInput" value="${esc(lastRoom)}" maxlength="6" style="text-transform:uppercase;letter-spacing:.2em;text-align:center;font-size:20px;"></div>
          <div class="field"><label>你的名字</label><input type="text" id="nameInput" maxlength="20" placeholder="输入姓名"></div>
          <div class="btn-row"><button class="btn btn-primary" id="joinBtn">加入</button></div>
        </div>`;
      document.getElementById('joinBtn').onclick = () => {
        const rid = document.getElementById('roomInput').value.trim().toUpperCase();
        const name = document.getElementById('nameInput').value.trim();
        if(!rid){ alert('请输入房间码'); return; }
        if(!name){ alert('请输入姓名'); return; }
        joinRoom(rid, name);
      };
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

    const community = (st.community||[]).map(c=>cardHtml(c)).join('') + Array(Math.max(0,5-(st.community||[]).length)).fill('<div class="pcard empty"></div>').join('');
    const turnSecs = remainingSeconds(st.turnDeadline);
    const potlineExtra = (st.stage!=='showdown' && turnSecs!==null) ? `　行动倒计时：${turnSecs}s` : '';
    const seats = st.players.map((p,i) => {
      if(!p.seated && st.stage!=='showdown') return '';
      const tags=[];
      if(i===st.dealerIdx) tags.push('<span class="tag">D</span>');
      if(i===st.sbIdx) tags.push('<span class="tag">SB</span>');
      if(i===st.bbIdx) tags.push('<span class="tag">BB</span>');
      const cls=['p-seat']; if(i===st.turn) cls.push('turn'); if(p.folded) cls.push('folded'); if(p.id===playerId) cls.push('me');
      return `<div class="${cls.join(' ')}">
        <div class="nm">${esc(p.name)}${p.id===playerId?' (我)':''} ${tags.join('')} ${p.allIn?'<span class="tag" style="background:var(--burgundy);color:#fff;">ALL-IN</span>':''}</div>
        <div class="chips">${p.chips} 筹码</div>
        <div class="betamt">本轮下注 ${p.betThisStreet}</div>
      </div>`;
    }).join('');

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
        <p class="section-sub" style="margin-top:10px;">${nextSecs!==null ? nextSecs+' 秒后自动开始下一局…' : '等待房主开始下一局…'}</p>
      </div>`;
    } else if(me && !me.seated){
      panel = `<div class="turn-panel"><p class="section-sub">本局你没有入座（筹码为 0 或本局未参与），请等待下一局。</p></div>`;
    } else if(me){
      const myCardsHtml = (me.cards||[]).length
        ? `<div class="hole-cards">${me.cards.map(c=>cardHtml(c)).join('')}</div>`
        : '';
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
          <div class="raise-box">
            <input type="number" id="raiseInput" placeholder="加注到…" min="${st.currentBet+1}">
            <button class="btn btn-primary auto" id="raiseBtn">加注</button>
          </div>`;
      }
      panel = `
        <div class="turn-panel">
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">${isMyTurn && !me.folded ? '轮到你了' : '我的手牌'}</div>
          ${myCardsHtml}
          ${bottom}
        </div>`;
    }

    app.innerHTML = `
      ${errHtml}
      <div class="gt-board">
        <div class="gt-potline"><span>第 ${st.handNumber} 局 · ${STAGE_LABEL[st.stage]||st.stage}</span><span>底池：${st.pot}　当前下注：${st.currentBet}${potlineExtra}</span></div>
        <div class="community">${community}</div>
        <div class="players-strip">${seats}</div>
      </div>
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
  }

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
    render();
  })();

  setInterval(()=>{
    if(lastState && (lastState.turnDeadline || lastState.nextHandDeadline)) render();
  }, 1000);
})();
