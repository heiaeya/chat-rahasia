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
/* ---------- Foto ---------- */
function isImg(text){ return typeof text==="string" && text.indexOf("img::")===0; }
function imgUrl(text){ return text.slice(5); }
function qText(s){ return isImg(s) ? "\uD83D\uDCF7 Foto" : String(s||"").slice(0,90); }
function findMsg(id){ for(var i=0;i<messages.length;i++) if(messages[i].id===id) return messages[i]; return null; }
function bodyHTML(m){
  if(m.pending) return '<div class="bimg sending">Mengirim foto...</div>';
  if(m.text==="img::failed") return '<div class="bimg failed">Foto gagal terkirim</div>';
  if(isImg(m.text)) return '<div class="bimg"><img class="photoimg" data-url="'+esc(imgUrl(m.text))+'" src="'+esc(imgUrl(m.text))+'" alt="foto" loading="lazy"></div>';
  return '<div class="btext">'+esc(m.text)+'</div>';
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
  fetch(SUPA_URL + "/rest/v1/rpc/get_messages", { method: "POST", headers: headers(), body: JSON.stringify({ p_room: ROOM }) })
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
    else { broadcast("msg", m); }
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
  wsSend({ topic: ROOM_TOPIC, event: "phx_join",
    payload: { config: { broadcast: { ack:false, self:false }, presence: { key: me.id } }, access_token: SUPA_KEY },
    ref: String(refCounter++) });
}
function onWsMessage(evt){
  var d = null;
  try{ d = JSON.parse(evt.data); }catch(e){ return; }
  if(!d || !d.topic) return;
  if(d.topic === ROOM_TOPIC && d.event === "broadcast"){
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
    } else if(d.payload.event === "msg"){
      if(mergeMessages([p])) render(false);
      renderStatus();
    }
  } else if(d.event === "phx_reply" && d.payload && d.payload.status==="ok"){
    if(d.topic===ROOM_TOPIC){ joinedRoom = true; publishPresence(); fetchHistory(); }
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
    box.innerHTML = '<div class="empty">Belum ada pesan.</div>';
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
      if(m.replayMsg) html += '<div class="quote"><b>'+esc(m.replayName||"")+'</b>'+esc(qText(m.replayMsg))+'</div>';
      html += bodyHTML(m)+'</div>';
      html += '<div class="bunder"><button class="replybtn" data-mid="'+esc(m.id)+'">&#8617; Balas</button><span>'+fmtTime(m.ts)+'</span><span class="checks '+(read?"":"grey")+'">&#10003;&#10003;</span></div>';
      html += '</div></div>';
    } else {
      html += '<div class="row her"><div class="mavatar">'+esc((m.name||"?").charAt(0).toUpperCase())+'</div><div class="mcol">';
      html += '<div class="bname">'+esc(m.name)+'</div>';
      html += '<div class="bubble" data-mid="'+esc(m.id)+'">';
      if(m.replayMsg) html += '<div class="quote"><b>'+esc(m.replayName||"")+'</b>'+esc(qText(m.replayMsg))+'</div>';
      html += bodyHTML(m)+'</div>';
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
  var photoImgs = box.querySelectorAll(".photoimg");
  for(var q=0;q<photoImgs.length;q++){
    photoImgs[q].addEventListener("click", function(e){
      e.stopPropagation();
      window.open(this.getAttribute("data-url"), "_blank");
    });
  }
  if(forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}
function renderStatus(){
  var p = partner();
  if(p){
    $("partnerName").textContent = p.name || "Chat6";
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
    $("partnerName").textContent = "Chat6";
    $("partnerStatus").textContent = wsOpen ? "menunggu dia online..." : "menghubungkan...";
    $("typingBar").style.display = "none";
  }
}
function setReply(m){
  replyTo = m;
  $("replyBar").style.display="block";
  $("replyName").textContent = (m.cid===me.id ? "Kamu" : m.name);
  $("replyText").textContent = qText(m.text);
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

/* ---------- Kirim foto ---------- */
function compressImage(file, cb){
  var url = URL.createObjectURL(file);
  var img = new Image();
  img.onload = function(){
    try{
      var max = 1280, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      var scale = Math.min(1, max / Math.max(w, h));
      var cw = Math.max(1, Math.round(w*scale)), ch = Math.max(1, Math.round(h*scale));
      var c = document.createElement("canvas"); c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      if(c.toBlob){ c.toBlob(function(b){ cb(b); }, "image/jpeg", 0.82); }
      else {
        var du = c.toDataURL("image/jpeg", 0.82);
        var bin = atob(du.split(",")[1]); var arr = new Uint8Array(bin.length);
        for(var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
        cb(new Blob([arr], { type:"image/jpeg" }));
      }
    }catch(e){ cb(null); }
  };
  img.onerror = function(){ URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}
function uploadPhoto(blob, id, cb){
  var path = ROOM + "/" + id + ".jpg";
  var xhr = new XMLHttpRequest();
  xhr.open("POST", SUPA_URL + "/storage/v1/object/photos/" + path, true);
  xhr.setRequestHeader("apikey", SUPA_KEY);
  xhr.setRequestHeader("Authorization", "Bearer " + SUPA_KEY);
  xhr.setRequestHeader("Content-Type", "image/jpeg");
  xhr.setRequestHeader("x-upsert", "true");
  xhr.onload = function(){
    if(xhr.status>=200 && xhr.status<300) cb(SUPA_URL + "/storage/v1/object/public/photos/" + path);
    else cb(null);
  };
  xhr.onerror = function(){ cb(null); };
  xhr.send(blob);
}
function sendPhoto(file){
  if(!file || (file.type||"").indexOf("image/")!==0){ alert("Itu bukan file gambar"); return; }
  compressImage(file, function(blob){
    if(!blob){ alert("Gagal memproses foto"); return; }
    var m = { id: uid(), cid: me.id, name: me.name, text: "img::pending", ts: Date.now(), pending: true };
    if(replyTo){ m.replayMsg = replyTo.text; m.replayName = replyTo.name; clearReply(); }
    messages.push(m); saveLocal(); render(true);
    uploadPhoto(blob, m.id, function(url){
      var mm = findMsg(m.id); if(!mm) return;
      delete mm.pending;
      if(url){ mm.text = "img::" + url; saveLocal(); render(false); postMessage(mm); publishPresence(); }
      else { mm.text = "img::failed"; saveLocal(); render(false); alert("Upload foto gagal - cek koneksi, coba lagi"); }
    });
  });
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
  loadLocal();
  for(var pi=0; pi<messages.length; pi++){ if(messages[pi].pending){ delete messages[pi].pending; messages[pi].text = "img::failed"; } }
  render(true); renderStatus();
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
$("photoBtn").addEventListener("click", function(){ $("photoInput").click(); });
$("photoInput").addEventListener("change", function(){
  var f = this.files && this.files[0];
  this.value = "";
  if(f) sendPhoto(f);
});
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
$("menuBtn").addEventListener("click", function(e){
  e.stopPropagation();
  var d = $("menuDrop");
  d.style.display = (d.style.display==="block") ? "none" : "block";
});
document.addEventListener("click", function(e){
  var d = $("menuDrop");
  if(d && d.style.display==="block" && !d.contains(e.target)) d.style.display="none";
});
function menuAction(act){
  if(act==="3"){ prompt("Link room ini (salin & simpan baik-baik):", roomLink(ROOM)); return; }
  if(act==="4"){ if(confirm("Keluar dari room ini dan kembali ke lobi?")){ location.hash=""; location.reload(); } return; }
  if(act==="1"){
    var n = prompt("Nama baru:", me.name);
    if(n && n.trim()){ me.name=n.trim(); try{ localStorage.setItem(LS_ME, JSON.stringify(me)); }catch(e){} publishPresence(); alert("Nama diganti jadi: "+me.name); }
  } else if(act==="2"){
    if(confirm("Hapus riwayat chat di HP ini saja? (di HP dia tidak ikut terhapus)")){ messages=[]; saveLocal(); render(true); }
  }
}
var menuItems = document.querySelectorAll("#menuDrop .mi");
for(var miIdx=0; miIdx<menuItems.length; miIdx++){
  menuItems[miIdx].addEventListener("click", function(){
    $("menuDrop").style.display="none";
    menuAction(this.getAttribute("data-act"));
  });
}
document.addEventListener("visibilitychange", function(){
  if(!document.hidden && me){
    fetchHistory();
    if(!wsOpen) connectWs(); else publishPresence();
  }
});
init();
})();
