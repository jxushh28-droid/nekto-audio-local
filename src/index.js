import http from 'node:http';
import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits,
} from 'discord.js';
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
  NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { NektoBrowser } from './nekto.js';
import { MixQueue, RelayOpusStream } from './pcm.js';
import { TokenStore } from './token-store.js';
import { commands } from './commands.js';
import { RelaySettings, changeAutoNext } from './relay-settings.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const DATA_DIR = process.env.DATA_DIR || './data';
const store1 = new TokenStore(DATA_DIR, process.env.NEKTO_AUTH_TOKEN || '', 'nekto-token1.json');
const store2 = new TokenStore(DATA_DIR, process.env.NEKTO_AUTH_TOKEN2 || '', 'nekto-token2.json');
const settings = new RelaySettings(DATA_DIR);
let ready = false;
let busy = false;
let closing = false;
let browserLaunchError = null;
let session = null;
let ownerIds = new Set();
const queue = new MixQueue();
// Two bridged nekto windows. Each stranger's captured voice is mixed into
// Discord (so the user hears both) AND injected as the OTHER window's
// microphone (so the two strangers hear and talk to each other). The user's
// own Discord mic is never forwarded, so the strangers never hear the user.
const browserA = new NektoBrowser(b64 => { if (session) { queue.accept1(b64); browserB.injectMic(b64); } }, DATA_DIR, { label: '1', injectMic: true });
const browserB = new NektoBrowser(b64 => { if (session) { queue.accept2(b64); browserA.injectMic(b64); } }, DATA_DIR, { label: '2', injectMic: true });
const browsers = [browserA, browserB];
async function stopBrowsers() { await Promise.all(browsers.map(b => b.stop().catch(() => {}))); }
async function searchBoth() {
  const a = await browserA.search(store1.value).catch(e => `error: ${safeError(e)}`);
  const b = await browserB.search(store2.value).catch(e => `error: ${safeError(e)}`);
  return `Window 1 — ${a} || Window 2 — ${b}`;
}
const startupCategory = error => {
  const message = String(error?.message || '');
  if (/ProcessSingleton|SingletonLock|profile appears to be in use|profile.*locked/i.test(message)) return 'browser-profile-locked';
  if (/Executable doesn.t exist|browser.*executable.*not.*found/i.test(message)) return 'browser-executable-missing';
  if (/EACCES|permission denied/i.test(message)) return 'filesystem-permission';
  return 'unclassified';
};
const safeError = error => String(error?.code || error?.name || 'Error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);

async function leave() {
  const previous = session;
  session = null;
  queue.clear();
  if (previous) {
    previous.player.stop(true);
    previous.stream.destroy();
    if (previous.connection.state.status !== VoiceConnectionStatus.Destroyed) previous.connection.destroy();
  }
  await stopBrowsers();
}

async function join(interaction) {
  if (!store1.value || !store2.value) throw new Error('Set both tokens first: /token1 and /token2.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('Join a regular Discord voice channel first.');
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error('Give the bot Connect and Speak permissions in your voice channel.');
  }
  if (session?.guildId === interaction.guildId && session.channelId === channel.id &&
      session.userId === interaction.user.id && session.connection.state.status === VoiceConnectionStatus.Ready &&
      session.player.state.status === AudioPlayerStatus.Playing) {
    return searchBoth();
  }
  await leave();
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const stream = new RelayOpusStream(queue, { bitrate: channel.bitrate || 64000 });
  session = { guildId: interaction.guild.id, channelId: channel.id, userId: interaction.user.id, connection, player, stream };
  const current = session;
  connection.on('error', error => console.error(`Discord voice connection error (${safeError(error)}).`));
  player.on('error', () => { console.error('Audio playback error.'); void leave(); });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch { if (session === current) await leave(); }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    // The user may have left while the bot was connecting.
    await member.fetch();
    if (member.voice.channelId !== channel.id || session !== current) throw new Error('Join the voice channel again, then use /join.');
    connection.subscribe(player);
    player.play(createAudioResource(stream, { inputType: StreamType.Opus }));
    await entersState(player, AudioPlayerStatus.Playing, 5000);
  } catch (error) {
    await leave();
    if (/Set your|Join the|Nekto|capture/i.test(error.message)) throw error;
    throw new Error('Could not establish Discord voice. Check Connect/Speak permissions and try /join again.');
  }
  // Keep Discord voice connected if the website search fails.
  return searchBoth();
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !commands.some(c => c.name === interaction.commandName)) return;
  if (!ownerIds.has(interaction.user.id)) {
    await interaction.reply({ content: 'This bot is restricted to its owner.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this command in your Discord server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (busy) {
    await interaction.reply({ content: 'Another relay command is still running. Try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  busy = true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let message, privateStatus;
    switch (interaction.commandName) {
      case 'token1': case 'token2': {
        const n = interaction.commandName === 'token1' ? 1 : 2;
        const store = n === 1 ? store1 : store2;
        const br = n === 1 ? browserA : browserB;
        await store.set(interaction.options.getString('token', true));
        await br.stop(); queue.clear();
        message = `Window ${n} token saved. Use /join to open both windows once both tokens are set.`;
        if (session?.guildId === interaction.guildId) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          if (member.voice.channelId === session?.channelId) message = `Window ${n} token saved. ${await br.search(store.value)}`;
        }
        break;
      }
      case 'join': message = await join(interaction); break;
      case 'autonext': {
        const val = interaction.options.getBoolean('enabled');
        message = await changeAutoNext(browserA, settings, val);
        browserB.setAutoNext(browserA.autoNext);
        break;
      }
      case 'next': {
        if (!session || session.guildId !== interaction.guildId) throw new Error('Use /join first.');
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.voice.channelId !== session.channelId) throw new Error('Join my voice channel first.');
        console.log(JSON.stringify({ event: 'nekto_next_requested', source: 'discord-command' }));
        queue.clear();
        const a = await browserA.next(store1.value).catch(e => `error: ${safeError(e)}`);
        const b = await browserB.next(store2.value).catch(e => `error: ${safeError(e)}`);
        message = `Window 1 — ${a} || Window 2 — ${b}`;
        break;
      }
      case 'proxy': {
        const raw = interaction.options.getString('url') || '';
        const server = browserA.setProxy(raw); browserB.setProxy(raw);
        await settings.setProxy(raw);
        // Restart both browsers so the new proxy takes effect, then re-search if
        // we were already in a voice channel.
        await stopBrowsers(); queue.clear();
        const tail = session?.guildId === interaction.guildId ? `Reconnecting… ${await searchBoth()}` : 'Use /join to start through it.';
        message = (server ? `Proxy set to ${server}. ` : 'Proxy cleared — using your direct connection. ') + tail;
        break;
      }
      case 'stop': await stopBrowsers(); queue.clear(); message = 'Both windows stopped.'; break;
      case 'leave': await leave(); message = 'Stopped both windows and left voice.'; break;
      case 'status': {
        const [sa, sb] = await Promise.all([browserA.status(store1.value), browserB.status(store2.value)]);
        const voice = session?.connection.state.status || 'disconnected';
        console.log(JSON.stringify({ event: 'discord_audio_status', voice,
          framesReceived: queue.received, nonSilentFrames: queue.nonSilent,
          bufferedFrames: queue.frames.length, droppedFrames: queue.dropped, bufferUnderruns: queue.underruns }));
        const line = (n, s) => `Window ${n}: ${s.active ? (s.callState?.phase || 'open') : 'stopped'}` +
          `; auth=${s.authorization || 'unconfirmed'}; captcha=${!!(s.authorizationDiagnostics?.captcha || s.authorizationDiagnostics?.hcaptcha)}` +
          `; restricted=${!!s.authorizationDiagnostics?.restricted}; lastFail=${s.lastFailure ? s.lastFailure.code : 'none'}`;
        message = `Discord voice: ${voice}\n${line(1, sa)}\n${line(2, sb)}\n` +
          `Audio (mixed): frames=${queue.received}, with-sound=${queue.nonSilent}\n` +
          `Live view + captcha solving for both windows: http://localhost:${PANEL_PORT}`;
        break;
      }
    }
    await interaction.editReply(privateStatus || { content: message, allowedMentions: { parse: [] } });
  } catch (error) {
    // Full message + stack to the local console (not to Discord) so failures are
    // diagnosable; safeError stays for the structured category.
    console.error(`Relay command /${interaction.commandName} failed (${safeError(error)}): ${error?.message || error}`);
    if (error?.stack) console.error(error.stack);
    const publicMessages = /^(Set your Nekto|Set both tokens|Join a regular|Give the bot|Nekto |Remote audio|Audio capture|Could not establish|Could not read|Token must|Use \/join|Join my voice|Join the voice)/;
    const message = publicMessages.test(error.message) ? error.message : `The relay operation failed: ${String(error?.message || 'unknown error').slice(0, 300)}`;
    if (interaction.deferred) await interaction.editReply({ content: message }).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  } finally { busy = false; }
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const current = session;
  if (!current || before.guild.id !== current.guildId) return;
  if ((after.id === current.userId || after.id === client.user?.id) && after.channelId !== current.channelId) {
    void leave();
  }
});
client.on(Events.Error, error => console.error(`Discord gateway error (${safeError(error)}).`));
client.on(Events.ShardDisconnect, () => { ready = false; void leave(); });
client.on(Events.ShardResume, () => { ready = true; });

const PANEL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nekto-audio panel</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0f;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;padding:20px;min-height:100vh}
h1{font-size:18px;font-weight:600;color:#fff;margin-bottom:16px;letter-spacing:.5px}h1 span{font-size:11px;font-weight:400;color:#555;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:#16161a;border:1px solid #222;border-radius:8px;padding:14px}
.card-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:10px}
.row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1c1c22}
.row:last-child{border-bottom:none}.label{color:#888;font-size:12px}.val{font-size:12px;font-weight:500;color:#ccc;max-width:180px;text-align:right;word-break:break-all}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.ok{color:#4ade80}.ok .dot{background:#4ade80}.warn{color:#facc15}.warn .dot{background:#facc15}.bad{color:#f87171}.bad .dot{background:#f87171}.dim{color:#555}
.badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600}
.badge-ok{background:#052e16;color:#4ade80}.badge-warn{background:#2d2000;color:#facc15}.badge-bad{background:#2d0f0f;color:#f87171}.badge-dim{background:#1c1c22;color:#555}
#err{display:none;background:#2d0f0f;border:1px solid #f87171;border-radius:6px;padding:10px;margin-bottom:12px;color:#f87171;font-size:12px}
.ts{font-size:10px;color:#333;margin-top:14px;text-align:right}
</style></head><body>
<h1>nekto-audio <span style="font-size:11px;font-weight:400;color:#888">two-window bridge</span> <span id="ts">—</span></h1>
<div id="err"></div>
<div class="grid" id="grid"></div>
<div style="margin-top:16px;display:flex;gap:14px;flex-wrap:wrap">
  <div style="flex:1 1 440px;min-width:340px">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:8px">Window 1 — stranger A <span id="livestate1" style="color:#4ade80;font-weight:400">● click to interact</span></div>
    <div id="shotwrap1" data-w="1" tabindex="0" style="position:relative;width:100%;aspect-ratio:1920/985;background:#0a0a0c;border-radius:6px;border:1px solid #222;outline:none;overflow:hidden;cursor:crosshair">
      <img id="shot1" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none" alt="">
      <div id="shotmsg1" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#666;font-size:13px;text-align:center;padding:20px">Window 1 — use /join to start.</div>
    </div>
  </div>
  <div style="flex:1 1 440px;min-width:340px">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:8px">Window 2 — stranger B <span id="livestate2" style="color:#4ade80;font-weight:400">● click to interact</span></div>
    <div id="shotwrap2" data-w="2" tabindex="0" style="position:relative;width:100%;aspect-ratio:1920/985;background:#0a0a0c;border-radius:6px;border:1px solid #222;outline:none;overflow:hidden;cursor:crosshair">
      <img id="shot2" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none" alt="">
      <div id="shotmsg2" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#666;font-size:13px;text-align:center;padding:20px">Window 2 — use /join to start.</div>
    </div>
  </div>
</div>
<script>
const dot=c=>'<span class="dot"></span>';
const badge=(v,cls)=>'<span class="badge badge-'+cls+'">'+v+'</span>';
const cls=(ok,warn)=>ok?'ok':warn?'warn':'bad';
function row(label,val,colorCls){return'<div class="row"><span class="label">'+label+'</span><span class="val '+(colorCls||'')+'">'+(colorCls?dot():'')+val+'</span></div>';}
function card(title,rows){return'<div class="card"><div class="card-title">'+title+'</div>'+rows+'</div>';}
async function poll(){
  try{
    const r=await fetch('/status');
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    window.__lastStatus=d;
    document.getElementById('err').style.display='none';
    render(d);
    document.getElementById('ts').textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){
    const el=document.getElementById('err');
    el.style.display='block';el.textContent='⚠ Cannot reach bot: '+e.message;
  }
}
function render(d){
  const voice=d.voice||'disconnected';
  const nekto=d.nekto||'stopped';
  const auth=d.authorization||'unconfirmed';
  const captcha=d.captcha;
  const restricted=d.restricted;
  const failure=d.lastFailure;
  const frames=d.framesReceived||0;
  const sound=d.nonSilentFrames||0;
  const peers=d.peers||0;
  const packets=d.inboundPackets||0;
  const bytes=d.inboundBytes||0;
  const tracks=d.tracks||0;
  const p=d.protocol||{};
  const reg=d.registration||{};
  const obs=d.observed||{};
  const ctl=d.controls||{};
  const mic=d.microphone||{};

  const voiceCls=voice==='ready'?'ok':voice==='disconnected'?'bad':'warn';
  const nektoCls=nekto.includes('search')||nekto.includes('open')?'warn':nekto.includes('call')||nekto.includes('confirm')?'ok':nekto==='stopped'?'dim':'warn';
  const captchaCls=captcha?'bad':'ok';

  const cards=[
    card('Status',[
      row('Discord voice',voice,voiceCls),
      row('Nekto',nekto,nektoCls),
      row('Automatic next',d.autoNext?badge('ON','ok'):badge('OFF','dim')),
      row('Browser IP',(d.browserIp||'unknown')+(d.proxy?' (proxy)':' (direct)'),d.browserIp?'ok':'dim'),
      row('Authorization',auth,auth.includes('confirm')?'ok':'warn'),
      row('Captcha',captcha?badge('REQUIRED','bad'):badge('clear','ok')),
      row('Restricted',restricted?badge('YES','bad'):badge('no','ok')),
      row('Last failure',failure?badge(failure,'bad'):badge('none','ok')),
    ].join('')),
    card('Audio',[
      row('Frames received',frames,frames>0?'ok':'dim'),
      row('Frames with sound',sound,sound>0?'ok':'dim'),
      row('WebRTC peers',peers,peers>0?'ok':'dim'),
      row('Remote tracks',tracks,tracks>0?'ok':'dim'),
      row('Packets in',packets,packets>0?'ok':'dim'),
      row('Bytes in',bytes>1024?(bytes/1024).toFixed(1)+'KB':bytes+'B',bytes>0?'ok':'dim'),
    ].join('')),
    card('Token / Protocol',[
      row('Storage token',reg.savedTokenMatches!=null?(reg.savedTokenMatches?badge('match','ok'):badge('MISMATCH','bad')):'—'),
      row('Live token',reg.liveTokenMatches!=null?(reg.liveTokenMatches?badge('match','ok'):badge('MISMATCH','bad')):'—'),
      row('Socket connected',reg.socketConnected!=null?(reg.socketConnected?badge('yes','ok'):badge('no','bad')):'—'),
      row('Authenticated',reg.authenticated!=null?(reg.authenticated?badge('yes','ok'):badge('no','bad')):'—'),
      row('captcha-request',p.captchaRequested?badge('received','bad'):badge('none','ok')),
      row('Reg reply',p.registrationReplyObserved!=null?(p.registrationSuccess?badge('ok','ok'):badge('fail','bad')):'—'),
    ].join('')),
    card('Browser / Controls',[
      row('Observed stage',obs.stage||'—'),
      row('Start button',ctl.startVisible!=null?(ctl.startEnabled?badge('enabled','ok'):(ctl.startVisible?badge('visible','warn'):badge('hidden','dim'))):'—'),
      row('Cookies btn',ctl.cookiesVisible?badge('visible','warn'):badge('gone','ok')),
      row('Mic permission',mic.permission||'—',mic.permission==='granted'?'ok':'bad'),
      row('Mic inputs',mic.inputs!=null?mic.inputs:'-'),
      row('Browser audio',d.audioState||'—',d.audioState==='running'?'ok':'warn'),
    ].join('')),
  ];
  const w2=d.w2||{};
  cards.splice(1,0,card('Window 2 (stranger B)',[
    row('Nekto',w2.nekto||'stopped',(w2.nekto&&w2.nekto!=='stopped')?'ok':'dim'),
    row('Authorization',w2.authorization||'unconfirmed',(w2.authorization||'').includes('confirm')?'ok':'warn'),
    row('Captcha',w2.captcha?badge('REQUIRED','bad'):badge('clear','ok')),
    row('Restricted',w2.restricted?badge('YES','bad'):badge('no','ok')),
    row('Browser IP',w2.browserIp||'unknown',w2.browserIp?'ok':'dim'),
    row('Last failure',w2.lastFailure?badge(w2.lastFailure,'bad'):badge('none','ok')),
  ].join('')));
  document.getElementById('grid').innerHTML=cards.join('');
}
// One interactive live view per window. w is '1' or '2'; screenshots and input
// are routed to the matching browser via ?w=.
function setupView(w){
  const shot=document.getElementById('shot'+w);
  const wrap=document.getElementById('shotwrap'+w);
  const msg=document.getElementById('shotmsg'+w);
  const live=document.getElementById('livestate'+w);
  let busy=false;
  function refresh(){
    if(busy)return;busy=true;
    const img=new Image();
    img.onload=()=>{shot.src=img.src;shot.style.display='block';msg.style.display='none';busy=false;};
    img.onerror=()=>{
      shot.style.display='none';msg.style.display='flex';busy=false;
      const d=window.__lastStatus||{};
      const st=w==='1'?d:(d.w2||{});
      if(w==='1'&&d.browserLaunchError){msg.textContent='Browser failed to start: '+d.browserLaunchError+'. Use /join to retry.';}
      else if(st.nekto&&st.nekto!=='stopped'){msg.textContent='Window '+w+' active ('+st.nekto+') — waiting for a frame…';}
      else{msg.textContent='Window '+w+' — set /token'+w+' and /join to start.';}
    };
    img.src='/screenshot?w='+w+'&t='+Date.now();
  }
  function coords(e){
    const r=wrap.getBoundingClientRect();
    const nw=shot.naturalWidth||1920,nh=shot.naturalHeight||985;
    const scale=Math.min(r.width/nw,r.height/nh);
    const dw=nw*scale,dh=nh*scale,ox=(r.width-dw)/2,oy=(r.height-dh)/2;
    const x=Math.round((e.clientX-r.left-ox)/scale),y=Math.round((e.clientY-r.top-oy)/scale);
    return {x:Math.max(0,Math.min(nw,x)),y:Math.max(0,Math.min(nh,y))};
  }
  function send(params){
    const q=new URLSearchParams(Object.assign({w},params));
    return fetch('/input?'+q.toString()).then(r=>r.json()).then(d=>{
      if(live)live.textContent=d.ok?('● sent '+params.type):'● input failed (no page)';
      setTimeout(refresh,150);setTimeout(refresh,500);return d.ok;
    }).catch(()=>{if(live)live.textContent='● input error';});
  }
  function flash(e){
    const d=document.createElement('div');
    d.style.cssText='position:fixed;left:'+(e.clientX-8)+'px;top:'+(e.clientY-8)+'px;width:16px;height:16px;border:2px solid #4ade80;border-radius:50%;pointer-events:none;z-index:9999;transition:all .4s;opacity:1';
    document.body.appendChild(d);requestAnimationFrame(()=>{d.style.transform='scale(2)';d.style.opacity='0';});
    setTimeout(()=>d.remove(),450);
  }
  wrap.addEventListener('click',e=>{flash(e);const{x,y}=coords(e);send({type:'click',x,y});wrap.focus();});
  wrap.addEventListener('wheel',e=>{e.preventDefault();send({type:'scroll',dy:Math.round(e.deltaY)});},{passive:false});
  wrap.addEventListener('keydown',e=>{
    const named=['Enter','Backspace','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Home','End'];
    if(named.includes(e.key)){e.preventDefault();send({type:'key',key:e.key});}
    else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();send({type:'text',text:e.key});}
  });
  return refresh;
}
const refresh1=setupView('1'),refresh2=setupView('2');
poll();setInterval(poll,1500);
setInterval(()=>{refresh1();refresh2();},700);
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  // Match on the path only: requests carry a query string (e.g. /screenshot?t=
  // cache-buster), so a strict request.url === '/screenshot' never matched and
  // fell through to 404 — which blanked the live view.
  const pathname = (request.url || '').split('?')[0];
  if (pathname === '/health') {
    response.writeHead(ready && client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready: ready && client.isReady() }));
    return;
  }
  const pickBrowser = () => {
    const w = new URL(request.url, 'http://x').searchParams.get('w');
    return w === '2' ? browserB : browserA;
  };
  if (pathname === '/status') {
    try {
      const [status, statusB] = await Promise.all([browserA.status(store1.value), browserB.status(store2.value)]);
      const d = status.authorizationDiagnostics || {};
      const p = status.protocolDiagnostics || {};
      const c = status.controlDiagnostics || {};
      const obs = status.observedStage ? { stage: `${status.observedStage}; captcha=${!!d.captcha}; hcaptcha=${!!d.hcaptcha}` } : {};
      const db = statusB.authorizationDiagnostics || {};
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify({
        voice: session?.connection.state.status || 'disconnected',
        nekto: status.active ? (status.callState?.phase || 'open') : 'stopped',
        autoNext: status.autoNext,
        browserLaunchError,
        browserIp: status.browserIp || null,
        proxy: status.proxy || null,
        authorization: status.authorization || 'unconfirmed',
        captcha: !!(d.captcha || d.hcaptcha),
        restricted: !!d.restricted,
        lastFailure: status.lastFailure ? `${status.lastFailure.code}: ${status.lastFailure.message}` : null,
        framesReceived: queue.received,
        nonSilentFrames: queue.nonSilent,
        peers: status.peers || 0,
        tracks: status.tracks || 0,
        inboundPackets: status.inboundPackets || 0,
        inboundBytes: status.inboundBytes || 0,
        audioState: status.audioState || null,
        registration: { authenticated: d.authenticated, socketConnected: d.socketConnected, savedTokenMatches: d.savedTokenMatches, liveTokenMatches: d.liveTokenMatches },
        protocol: { captchaRequested: !!p.captchaRequested, registrationReplyObserved: p.registrationReplyObserved, registrationSuccess: p.registrationSuccess },
        controls: c,
        observed: obs,
        microphone: status.microphone || null,
        w2: {
          nekto: statusB.active ? (statusB.callState?.phase || 'open') : 'stopped',
          browserIp: statusB.browserIp || null,
          authorization: statusB.authorization || 'unconfirmed',
          captcha: !!(db.captcha || db.hcaptcha),
          restricted: !!db.restricted,
          lastFailure: statusB.lastFailure ? `${statusB.lastFailure.code}: ${statusB.lastFailure.message}` : null,
        },
      }));
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'status unavailable' }));
    }
    return;
  }
  if (pathname === '/screenshot') {
    try {
      const img = await pickBrowser().screenshot();
      if (!img) { response.writeHead(503); response.end('no page'); return; }
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      response.end(img);
    } catch { response.writeHead(503); response.end('screenshot failed'); }
    return;
  }
  if (pathname === '/input') {
    try {
      const q = new URL(request.url, 'http://x').searchParams;
      const ev = { type: q.get('type') };
      if (q.get('x') != null) ev.x = Number(q.get('x'));
      if (q.get('y') != null) ev.y = Number(q.get('y'));
      if (q.get('dy') != null) ev.dy = Number(q.get('dy'));
      if (q.get('text') != null) ev.text = q.get('text');
      if (q.get('key') != null) ev.key = q.get('key');
      const ok = await pickBrowser().input(ev);
      response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok }));
    } catch { response.writeHead(400); response.end('bad input'); }
    return;
  }
  if (pathname === '/' || pathname === '/panel') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(PANEL_HTML);
    return;
  }
  response.writeHead(404); response.end();
});
// Railway's HTTP edge reaches the container over IPv6, so bind the IPv6 wildcard
// (::) — dual-stack, so it also accepts IPv4 and still serves localhost:PORT.
// Binding '0.0.0.0' (IPv4 only) makes the edge refuse the connection (502).
// If the host has no IPv6, fall back to 0.0.0.0 so local runs still work.
const PANEL_PORT = Number(process.env.PORT || 3000) || 3000;
let listenFellBack = false;
server.on('error', error => {
  if (!listenFellBack && (error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT' || error?.code === 'EINVAL')) {
    listenFellBack = true;
    console.warn(JSON.stringify({ event: 'http_listen_ipv6_unavailable', fallback: '0.0.0.0' }));
    server.listen(PANEL_PORT, '0.0.0.0');
    return;
  }
  console.error(JSON.stringify({ event: 'http_listen_error', errorType: String(error?.code || error?.message || error) }));
});
server.on('listening', () => {
  const a = server.address();
  console.log(JSON.stringify({ event: 'http_listening', address: a?.address, port: a?.port, family: a?.family }));
});
server.listen(PANEL_PORT, '::');

async function shutdown() {
  if (closing) return;
  closing = true; ready = false;
  const force = setTimeout(() => process.exit(1), 10000); force.unref();
  await leave(); await Promise.all(browsers.map(b => b.close().catch(() => {}))); client.destroy(); server.close();
  clearTimeout(force);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

let startupStage = 'configuration';
try {
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required.');
  startupStage = 'token-store';
  await store1.load(); await store2.load();
  startupStage = 'relay-settings';
  const auto = await settings.load();
  browserA.setAutoNext(auto); browserB.setAutoNext(auto);
  if (settings.proxy) { browserA.setProxy(settings.proxy); browserB.setProxy(settings.proxy); }
  // Both nekto windows launch on /join (fresh extension profiles), so there is
  // no eager browser warm-up here — nothing to open before the user asks.
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.fetch();
      const configured = (process.env.BOT_OWNER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      const owner = client.application.owner;
      ownerIds = new Set(configured.length ? configured : [owner?.ownerId || owner?.id].filter(Boolean));
      if (!ownerIds.size || [...ownerIds].some(id => !/^\d{17,20}$/.test(id))) throw new Error('Invalid bot owner configuration.');
      const manager = process.env.DISCORD_GUILD_ID
        ? (await client.guilds.fetch(process.env.DISCORD_GUILD_ID)).commands : client.application.commands;
      // Delete the retired popup commands without replacing unrelated commands.
      for (const existingManager of [client.application.commands, manager].filter((value, index, list) => list.indexOf(value) === index)) {
        const registered = await existingManager.fetch();
        for (const command of registered.values()) {
          if (['answer', 'prompt'].includes(command.name)) await existingManager.delete(command.id);
        }
      }
      for (const command of commands) await manager.create(command);
      ready = true;
      console.log('Discord bot online; slash commands registered; browser ready.');
    } catch (error) {
      console.error(`Bot setup failed (${safeError(error)}).`);
      await shutdown(); process.exitCode = 1;
    }
  });
  startupStage = 'discord-login';
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  console.error(JSON.stringify({ event: 'bot_startup_failed', stage: startupStage, category: startupCategory(error), errorType: safeError(error) }));
  await shutdown(); process.exitCode = 1;
}

