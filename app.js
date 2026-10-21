(function(){
"use strict";
var SUPA_URL = window.CHAT_CONFIG.SUPABASE_URL;
var SUPA_KEY = window.CHAT_CONFIG.SUPABASE_ANON_KEY;
var REST = SUPA_URL + "/rest/v1/messages";
var WS_URL = SUPA_URL.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + SUPA_KEY + "&vsn=1.0.0";

function getRoom(){
  var h = location.hash || "";
  var m = h.match(/r=([a-zA-Z0-9]+)/);
  return m ? m[1] : "";
}
var ROOM = getRoom();
var LS_ME = "cb_me_" + ROOM, LS_MSG = "cb_msg_" + ROOM;
var me = null, messages = [], presence = {}, replyTo = null;
var ws = null, wsOpen = false, refCounter = 1, joinedDb = false, joinedRoom = false, reconnectTimer = null;
var DB_TOPIC = "realtime:public:messages";
var ROOM_TOPIC = "realtime:room-" + ROOM;

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function uid(){ return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2,9); }
function cidNew(){ return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2,9); }
function fmtTime(ts){ var d=new Date(ts); var hh=d.getHours(); var mm=d.getMinutes(); return (hh<10?"0":"")+hh+":"+(mm<10?"0":"")+mm; }
function saveLocal(){ try{ localStorage.setItem(LS_MSG, JSON.stringify(messages.slice(-300))); }catch(e){} }
function loadLocal(){ try{ var raw=localStorage.getItem(LS_MSG); if(raw){ messages=JSON.parse(raw)||[]; } }catch(e){ messages=[]; } }
function headers(extra){
  var h = { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json" };
  if(extra){ for(var k in extra) h[k]=extra[k]; }
  return h;
}
function rowToMsg(r){
  return { id:r.id, cid:r.cid, name:r.name, text:r.body, ts:r.ts,
           replayMsg:r.replay_msg||undefined, replayName:r.replay_name||undefined };
}
function msgToRow(m){
  return { id:m.id, room:ROOM, cid:m.cid, name:m.name, body:m.text, ts:m.ts,
           replay_msg:m.replayMsg||null, replay_name:m.replayName||null };
}
function mergeMessages(incoming){
  var byId = {}, i, m;
  for(i=0;i<messages.length;i++) byId[messages[i].id]=messages[i];
  var changed=false;
  for(i=0;i<incoming.length;i++){
    m=incoming[i];
    if(!m || !m.id || !m.text) continue;
    if(!byId[m.id]){ byId[m.id]=m; changed=true; }
  }
  if(changed){
    var arr=[]; for(var k in byId){ if(byId.hasOwnProperty(k)) arr.push(byId[k]); }
    arr.sort(function(a,b){ return a.ts-b.ts; });
    messages = arr.slice(-300);
    saveLocal();
  }
  return changed;
}
function partner(){
  var best=null;
  for(var k in presence){ if(presence.hasOwnProperty(k) && k!==me.id){ if(!best || presence[k].lastSeen>presence[best].lastSeen) best=k; } }
  if(best) return presence[best];
  for(var i=messages.length-1;i>=0;i--){ if(messages[i].cid!==me.id) return { name: messages[i].name, lastSeen: 0, typing:false }; }
  return null;
}

/* ---------- REST ---------- */
function fetchHistory(){
  fetch(REST + "?room=eq." + encodeURIComponent(ROOM) + "&order=ts.asc&limit=300", { headers: headers() })
  .then(function(r){ return r.json(); })
  .then(function(rows){
    if(rows && rows.length!==undefined){
      var arr = [];
      for(var i=0;i<rows.length;i++) arr.push(rowToMsg(rows[i]));
      if(mergeMessages(arr)) render(false);
      renderStatus();
    }
  })
  .catch(function(){ /* local copy still shown */ });
}
function postMessage(m){
  fetch(REST, { method:"POST", headers: headers({ "Prefer": "return=minimal" }), body: JSON.stringify(msgToRow(m)) })
  .then(function(r){
    if(!r.ok){ $("netWarn").style.display="block"; setTimeout(fetchHistory, 2500); }
  })
  .catch(function(){ $("netWarn").style.display="block"; setTimeout(fetchHistory, 2500); });
}

/* ---------- Realtime (Phoenix protocol) ---------- */
function wsSend(obj){
  if(ws && wsOpen){ try{ ws.send(JSON.stringify(obj)); return true; }catch(e){} }
  return false;
}
function broadcast(event, payload){
  wsSend({ topic: ROOM_TOPIC, event: "broadcast", payload: { type:"broadcast", event: event, payload: payload }, ref: String(refCounter++) });
}
function publishPresence(){ if(me) broadcast("presence", { cid: me.id, name: me.name, lastSeen: Date.now() }); }
function publishTyping(t){ if(me) broadcast("typing", { cid: me.id, name: me.name, typing: !!t, ts: Date.now() }); }
function joinChannels(){
  wsSend({ topic: DB_TOPIC, event: "phx_join",
    payload: { config: { broadcast: { ack:false, self:false }, presence: { key:"" },
      postgres_changes: [ { event:"INSERT", schema:"public", table:"messages", filter:"room=eq."+ROOM } ] },
      access_token: SUPA_KEY },
    ref: String(refCounter++) });
  wsSend({ topic: ROOM_TOPIC, event: "phx_join",
    payload: { config: { broadcast: { ack:false, self:false }, presence: { key: me.id } }, access_token: SUPA_KEY },
    ref: String(refCounter++) });
}
function onWsMessage(evt){
  var d = null;
  try{ d = JSON.parse(evt.data); }catch(e){ return; }
  if(!d || !d.topic) return;
  if(d.topic === DB_TOPIC && d.event === "postgres_changes"){
    var rec = d.payload && d.payload.data && d.payload.data.record;
    if(rec && rec.room===ROOM && rec.cid!==me.id){
      if(mergeMessages([rowToMsg(rec)])) render(false);
      renderStatus();
    }
  } else if(d.topic === ROOM_TOPIC && d.event === "broadcast"){
    var p = d.payload && d.payload.payload;
    if(!p || !p.cid || p.cid===me.id) return;
    if(d.payload.event === "presence"){
      var prev = presence[p.cid] || {};
      prev.name = p.name || prev.name;
      prev.lastSeen = p.lastSeen || prev.lastSeen || 0;
      presence[p.cid] = prev;
      renderStatus();
    } else if(d.payload.event === "typing"){
      var p2 = presence[p.cid] || { name: p.name, lastSeen: 0 };
      p2.name = p.name || p2.name;
      p2.typing = !!p.typing;
      p2.typingTs = p.ts || 0;
      presence[p.cid] = p2;
      renderStatus();
    }
  } else if(d.event === "phx_reply" && d.payload && d.payload.status==="ok"){
    if(d.topic===ROOM_TOPIC){ joinedRoom = true; publishPresence(); }
    if(d.topic===DB_TOPIC){ joinedDb = true; }
  }
}
function connectWs(){
  if(!me) return;
  try{ if(ws){ ws.close(); } }catch(e){}
  try{ ws = new WebSocket(WS_URL); }catch(e){ scheduleWs(); return; }
  ws.onopen = function(){
    wsOpen = true; joinedDb = false; joinedRoom = false;
    $("netWarn").style.display="none";
    joinChannels();
    fetchHistory();
    renderStatus();
  };
  ws.onmessage = onWsMessage;
  ws.onclose = function(){ wsOpen = false; scheduleWs(); renderStatus(); };
  ws.onerror = function(){ try{ ws.close(); }catch(e){} };
}
function scheduleWs(){
  $("netWarn").style.display="block";
  if(reconnectTimer) return;
  reconnectTimer = setTimeout(function(){ reconnectTimer = null; connectWs(); }, 3000);
}
setInterval(function(){
  wsSend({ topic:"phoenix", event:"heartbeat", payload:{}, ref: String(refCounter++) });
  if(wsOpen) publishPresence();
}, 25000);

/* ---------- Rendering ---------- */
function render(forceScroll){
  var box = $("messages");
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if(messages.length===0){
    box.innerHTML = '<div class="empty">Belum ada pesan.<br>Kirim pesan pertama kamu &#128150;</div>';
    return;
  }
  var html = '<div class="day-note"><span>Pesan di ruang ini hanya bisa dibuka pakai link rahasia kalian berdua</span></div>';
  for(var i=0;i<messages.length;i++){
    var m = messages[i];
    var mine = m.cid===me.id;
    var p = partner();
    var read = p && p.lastSeen && p.lastSeen > m.ts;
    if(mine){
      html += '<div class="row me"><div class="mcol">';
      html += '<div class="bubble" data-mid="'+esc(m.id)+'">';
      if(m.replayMsg) html += '<div class="quote"><b>'+esc(m.replayName||"")+'</b>'+esc(m.replayMsg.slice(0,90))+'</div>';
      html += '<div class="btext">'+esc(m.text)+'</div></div>';
      html += '<div class="bunder"><button class="replybtn" data-mid="'+esc(m.id)+'">&#8617; Balas</button><span>'+fmtTime(m.ts)+'</span><span class="checks '+(read?"":"grey")+'">&#10003;&#10003;</span></div>';
      html += '</div></div>';
    } else {
      html += '<div class="row her"><div class="mavatar">'+esc((m.name||"?").charAt(0).toUpperCase())+'</div><div class="mcol">';
      html += '<div class="bname">'+esc(m.name)+'</div>';
      html += '<div class="bubble" data-mid="'+esc(m.id)+'">';
      if(m.replayMsg) html += '<div class="quote"><b>'+esc(m.replayName||"")+'</b>'+esc(m.replayMsg.slice(0,90))+'</div>';
      html += '<div class="btext">'+esc(m.text)+'</div></div>';
      html += '<div class="bunder"><button class="replybtn" data-mid="'+esc(m.id)+'">&#8617; Balas</button><span>'+fmtTime(m.ts)+'</span></div>';
      html += '</div></div>';
    }
  }
  box.innerHTML = html;
  var clickables = box.querySelectorAll(".bubble, .replybtn");
  for(var j=0;j<clickables.length;j++){
    clickables[j].addEventListener("click", function(){
      var mid = this.getAttribute("data-mid");
      for(var i=0;i<messages.length;i++) if(messages[i].id===mid){ setReply(messages[i]); break; }
    });
  }
  if(forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}
function renderStatus(){
  var p = partner();
  if(p){
    $("partnerName").textContent = p.name || "Chat Berdua";
    $("avatar").textContent = (p.name||"?").charAt(0).toUpperCase();
    var age = Date.now() - (p.lastSeen||0);
    var typing = p.typing && p.typingTs && (Date.now()-p.typingTs < 6000);
    if(typing){ $("partnerStatus").textContent = "sedang mengetik..."; }
    else if(p.lastSeen && age < 60000){ $("partnerStatus").textContent = "online"; }
    else if(p.lastSeen){ $("partnerStatus").textContent = "terakhir online " + fmtTime(p.lastSeen); }
    else { $("partnerStatus").textContent = wsOpen ? "" : "menghubungkan..."; }
    $("typingBar").style.display = typing ? "block" : "none";
    if(typing) $("typingBar").textContent = p.name + " sedang mengetik...";
  } else {
    $("partnerName").textContent = "Chat Berdua";
    $("partnerStatus").textContent = wsOpen ? "menunggu dia online..." : "menghubungkan...";
    $("typingBar").style.display = "none";
  }
}
function setReply(m){
  replyTo = m;
  $("replyBar").style.display="block";
  $("replyName").textContent = (m.cid===me.id ? "Kamu" : m.name);
  $("replyText").textContent = m.text.slice(0,90);
  $("msgInput").focus();
}
function clearReply(){ replyTo=null; $("replyBar").style.display="none"; }

/* ---------- Send ---------- */
function send(){
  var input = $("msgInput");
  var text = input.value.trim();
  if(!text) return;
  var m = { id: uid(), cid: me.id, name: me.name, text: text, ts: Date.now() };
  if(replyTo){ m.replayMsg = replyTo.text; m.replayName = replyTo.name; }
  messages.push(m); saveLocal(); render(true);
  input.value=""; input.style.height="auto"; clearReply();
  publishTyping(false);
  postMessage(m);
  publishPresence();
}

/* ---------- Lobby / rooms ---------- */
function roomLink(code){ return location.origin + location.pathname + "#r=" + code; }
function parseCode(raw){
  if(!raw) return "";
  var v = String(raw).trim();
  var m = v.match(/r=([a-zA-Z0-9]+)/);
  if(m) return m[1];
  return v.replace(/[^a-zA-Z0-9]/g, "");
}
function gotoRoom(code){ location.hash = "r=" + code; location.reload(); }
function makeRoomCode(){
  var s = Date.now().toString(36);
  var r = "";
  var chars = "abcdefghjkmnpqrstuvwxyz23456789";
  for(var i=0;i<14;i++) r += chars.charAt(Math.floor(Math.random()*chars.length));
  return s + r;
}
function initLobby(){
  $("lobby").style.display="block"; $("nameForm").style.display="none";
  var createdCode = "";
  $("createRoomBtn").addEventListener("click", function(){
    createdCode = makeRoomCode();
    $("createdLink").value = roomLink(createdCode);
    $("createdBox").style.display="block";
  });
  $("createdLink").addEventListener("click", function(){ this.select(); });
  $("enterCreatedBtn").addEventListener("click", function(){ if(createdCode) gotoRoom(createdCode); });
  $("joinBtn").addEventListener("click", function(){
    var code = parseCode($("joinCode").value);
    if(!code){ alert("Tempel kode / link room-nya dulu ya"); return; }
    gotoRoom(code);
  });
  $("joinCode").addEventListener("keydown", function(e){ if(e.key==="Enter") $("joinBtn").click(); });
}

/* ---------- Boot ---------- */
function startChat(){
  $("setup").style.display="none";
  var c = $("chat"); c.style.display="flex";
  loadLocal(); render(true); renderStatus();
  fetchHistory();
  connectWs();
  setInterval(renderStatus, 5000);
}
function init(){
  if(!ROOM){ initLobby(); return; }
  $("lobby").style.display="none"; $("nameForm").style.display="block";
  $("roomCodeShow").value = ROOM;
  $("roomCodeShow").addEventListener("click", function(){ this.select(); });
  $("backLobbyBtn").addEventListener("click", function(){ location.hash=""; location.reload(); });
  try{ var raw=localStorage.getItem(LS_ME); if(raw) me=JSON.parse(raw); }catch(e){}
  if(me && me.id && me.name){ startChat(); return; }
  $("enterBtn").addEventListener("click", function(){
    var name = $("nameInput").value.trim();
    if(!name){ alert("Isi nama kamu dulu ya"); return; }
    me = { id: cidNew(), name: name };
    try{ localStorage.setItem(LS_ME, JSON.stringify(me)); }catch(e){}
    startChat();
  });
  $("nameInput").addEventListener("keydown", function(e){ if(e.key==="Enter") $("enterBtn").click(); });
}
$("sendBtn").addEventListener("click", send);
$("msgInput").addEventListener("keydown", function(e){
  if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); }
});
var typingState = false, typingTimer = null;
$("msgInput").addEventListener("input", function(){
  this.style.height="auto"; this.style.height=Math.min(this.scrollHeight,110)+"px";
  var has = this.value.trim().length>0;
  if(has!==typingState){ typingState=has; publishTyping(has); }
  if(typingTimer) clearTimeout(typingTimer);
  if(has){ typingTimer=setTimeout(function(){ typingState=false; publishTyping(false); }, 4000); }
});
$("replyCancel").addEventListener("click", clearReply);
$("menuBtn").addEventListener("click", function(){
  var act = prompt("Menu:\n1 = Ganti nama\n2 = Hapus riwayat di HP ini\n3 = Lihat link room ini\n4 = Keluar / ganti room\n\nKetik nomornya:");
  if(act==="3"){ prompt("Link room ini (salin & simpan baik-baik):", roomLink(ROOM)); return; }
  if(act==="4"){ if(confirm("Keluar dari room ini dan kembali ke lobi?")){ location.hash=""; location.reload(); } return; }
  if(act==="1"){
    var n = prompt("Nama baru:", me.name);
    if(n && n.trim()){ me.name=n.trim(); try{ localStorage.setItem(LS_ME, JSON.stringify(me)); }catch(e){} publishPresence(); alert("Nama diganti jadi: "+me.name); }
  } else if(act==="2"){
    if(confirm("Hapus riwayat chat di HP ini saja? (di HP dia tidak ikut terhapus)")){ messages=[]; saveLocal(); render(true); }
  }
});
document.addEventListener("visibilitychange", function(){
  if(!document.hidden && me){
    fetchHistory();
    if(!wsOpen) connectWs(); else publishPresence();
  }
});
init();
})();
