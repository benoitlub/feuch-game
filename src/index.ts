import { Hono } from 'hono';
type Env = { ROOM: DurableObjectNamespace };
type Role = 'Feuch' | 'Natasha' | 'Marty' | 'Nikolas' | 'Slobodane';
type Phase = 'lobby' | 'night' | 'day' | 'finished';
type Player = { id: string; name: string; ready: boolean; role?: Role; camp?: 'feuch' | 'neutral' };
type Saved = { players: Player[]; hostId: string | null; phase: Phase; round: number; nightTarget: string | null; linked: string[]; natashaUsed: boolean; dayVotes: Record<string,string>; conversionUsed: boolean; winner: string | null };
const initial = (): Saved => ({ players: [], hostId: null, phase: 'lobby', round: 0, nightTarget: null, linked: [], natashaUsed: false, dayVotes: {}, conversionUsed: false, winner: null });
const app = new Hono<{ Bindings: Env }>();
app.get('/api/health', c => c.json({ ok: true, version: 'v0.3' }));
app.post('/api/rooms', c => c.json({ code: crypto.randomUUID().slice(0, 6).toUpperCase() }));
app.get('/api/rooms/:code/ws', c => {
  const code = c.req.param('code').toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(code)) return c.json({ error: 'Invalid code' }, 400);
  return c.env.ROOM.get(c.env.ROOM.idFromName(code)).fetch(c.req.raw);
});
app.get('/', c => c.html(html));
export default app;

export class GameRoom extends DurableObject {
  private state: Saved = initial();
  private sockets = new Map<WebSocket, string>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<Saved>('game')) ?? initial();
      for (const ws of ctx.getWebSockets()) {
        const id = ws.deserializeAttachment() as string | null;
        if (id) this.sockets.set(ws, id);
      }
    });
  }
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  private send(ws: WebSocket, message: unknown) { try { ws.send(JSON.stringify(message)); } catch {} }
  private error(ws: WebSocket, message: string) { this.send(ws, { type: 'error', message }); }
  private persist() { return this.ctx.storage.put('game', this.state); }
  private broadcast() {
    const s = this.state;
    const players = s.players.map(({ id, name, ready }) => ({ id, name, ready }));
    for (const [ws, id] of this.sockets) {
      const me = s.players.find(p => p.id === id);
      this.send(ws, { type: 'state', phase: s.phase, round: s.round, players, hostId: s.hostId, me: me ? { id: me.id, role: me.role, camp: me.camp } : null, linked: me && s.linked.includes(me.id) ? s.linked : [], natashaUsed: me?.role === 'Natasha' ? s.natashaUsed : undefined, voted: Boolean(s.dayVotes[id]), conversionUsed: me?.role === 'Feuch' ? s.conversionUsed : undefined, eligibleTarget: me?.role === 'Feuch' && s.phase === 'day' ? s.nightTarget : undefined, winner: s.winner });
    }
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: { type: string; name?: string; target?: string; other?: string; question?: string };
    try { m = JSON.parse(String(raw)); } catch { return this.error(ws, 'Message invalide'); }
    const s = this.state;
    if (m.type === 'join') {
      if (this.sockets.has(ws)) return;
      if (s.phase !== 'lobby' || s.players.length >= 10) return this.error(ws, 'Salon indisponible');
      const name = String(m.name ?? '').trim().slice(0, 24);
      if (!name) return this.error(ws, 'Pseudo requis');
      const p: Player = { id: crypto.randomUUID(), name, ready: false };
      s.players.push(p); s.hostId ??= p.id; this.sockets.set(ws, p.id); ws.serializeAttachment(p.id);
      this.send(ws, { type: 'joined', id: p.id });
    } else {
      const id = this.sockets.get(ws);
      const me = s.players.find(p => p.id === id);
      if (!me) return this.error(ws, 'Rejoins le salon avant de jouer');
      if (m.type === 'ready' && s.phase === 'lobby') me.ready = !me.ready;
      else if (m.type === 'start') {
        if (me.id !== s.hostId) return this.error(ws, 'Réservé à l’hôte');
        if (s.phase !== 'lobby' || s.players.length < 3 || s.players.some(p => !p.ready) || s.players.length > 5) return this.error(ws, 'Il faut 3 à 5 joueurs prêts');
        const roles: Role[] = ['Feuch', 'Natasha', 'Marty', 'Nikolas', 'Slobodane'];
        for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [roles[i], roles[j]] = [roles[j], roles[i]]; }
        s.players.forEach((p, i) => { p.role = roles[i]; p.camp = p.role === 'Feuch' || p.role === 'Slobodane' ? 'feuch' : 'neutral'; });
        s.phase = 'night'; s.round = 1; s.conversionUsed = false;
      } else if (m.type === 'target' && s.phase === 'night' && me.role === 'Feuch') {
        if (!s.players.some(p => p.id === m.target && p.id !== me.id)) return this.error(ws, 'Cible invalide');
        s.nightTarget = m.target!;
        this.send(ws, { type: 'notice', message: 'Cible nocturne enregistrée' });
      } else if (m.type === 'link' && s.phase === 'night' && me.role === 'Natasha' && !s.natashaUsed) {
        if (!m.target || !m.other || m.target === m.other || !s.players.some(p => p.id === m.target) || !s.players.some(p => p.id === m.other)) return this.error(ws, 'Choisis deux joueurs distincts');
        s.linked = [m.target, m.other]; s.natashaUsed = true;
        this.send(ws, { type: 'notice', message: 'Deux joueurs sont liés' });
      } else if (m.type === 'question' && s.phase === 'day' && me.role === 'Marty') {
        if (!s.players.some(p => p.id === m.target)) return this.error(ws, 'Cible invalide');
        const key = 'question:' + s.round + ':' + me.id;
        if (await this.ctx.storage.get(key)) return this.error(ws, 'Question déjà posée ce jour');
        await this.ctx.storage.put(key, true);
        const target = s.players.find(p => p.id === m.target)!;
        this.send(ws, { type: 'answer', message: target.camp === 'feuch' ? 'OUI' : 'NON' });
      } else if (m.type === 'convert' && s.phase === 'day' && me.role === 'Feuch' && me.camp === 'feuch') {
        if (s.conversionUsed || !s.nightTarget || m.target !== s.nightTarget) return this.error(ws, 'Cible nocturne requise ou conversion déjà tentée');
        s.conversionUsed = true;
        const target = s.players.find(p => p.id === m.target);
        if (!target || s.linked.includes(target.id)) return this.error(ws, 'La cible est protégée');
        target.camp = 'feuch';
        this.send(ws, { type: 'notice', message: 'Conversion réussie : ' + target.name });
        if (s.players.every(p => p.camp === 'feuch')) { s.phase = 'finished'; s.winner = 'feuch'; }
      } else if (m.type === 'vote' && s.phase === 'day') {
        if (!s.players.some(p => p.id === m.target)) return this.error(ws, 'Cible invalide');
        if (s.dayVotes[me.id]) return this.error(ws, 'Vote déjà enregistré');
        s.dayVotes[me.id] = m.target!;
      } else if (m.type === 'next' && me.id === s.hostId) {
        if (s.phase === 'night') {
          s.phase = 'day';
          const target = s.players.find(p => p.id === s.nightTarget);
          if (target && !s.linked.includes(target.id)) {
            this.send(ws, { type: 'notice', message: 'La cible nocturne est exposée à une conversion durant le jour (résolution à venir).' });
          }
        } else if (s.phase === 'day') {
          s.dayVotes = {};
          s.nightTarget = null;
          s.conversionUsed = false;
          s.phase = 'night';
          s.round++;
        }
      } else return this.error(ws, 'Action indisponible pour ce rôle ou cette phase');
    }
    await this.persist(); this.broadcast();
  }
  webSocketClose(ws: WebSocket) { this.sockets.delete(ws); }
  webSocketError(ws: WebSocket) { this.sockets.delete(ws); }
}
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feuch Game</title><style>body{background:#1b1128;color:white;font:17px system-ui;margin:0;padding:24px}main{max-width:480px;margin:auto}h1{color:#ff9d29;font-size:44px}section{border:1px solid #665477;border-radius:20px;padding:20px;margin:20px 0}button,input,select{padding:12px;border-radius:9px;font:inherit;margin:5px;max-width:95%}button{background:#ff9d29;border:0;font-weight:bold}button:disabled{opacity:.4}.hide{display:none}#roomcode,#role{font-size:30px;color:#ffbd65}small{color:#cbb6db}</style><main><h1>FEUCH GAME</h1><p>Le vice est parmi nous.</p><section id="entry"><button id="create">Créer un salon</button><input id="code" placeholder="Code à 6 caractères"><button id="join">Rejoindre</button></section><section id="room" class="hide"><p>Salon <strong id="roomcode"></strong></p><input id="name" placeholder="Ton pseudo"><button id="enter">Entrer</button><p id="notice"></p><ul id="players"></ul><button id="ready" class="hide">Prêt !</button><button id="start" class="hide">Distribuer les rôles</button><h2 id="phase"></h2><div id="secret" class="hide"><p>TA CARTE SECRÈTE</p><div id="role"></div><p id="camp"></p><small>Ne montre pas cet écran !</small></div><div id="actions" class="hide"><select id="target"></select><select id="other" class="hide"></select><button id="act"></button><button id="link" class="hide">Lier ces deux joueurs</button><button id="vote" class="hide">Voter</button><button id="convert" class="hide">Convertir la cible nocturne</button></div><button id="next" class="hide">Phase suivante (hôte)</button></section><small>V0.3 expérimentale : conversion ciblée par Feuch et victoire Feuchienne. Votes sans élimination, défis et victoire adverse à venir.</small></main><script>let ws,myId,state;const e=id=>document.getElementById(id);function send(type,extra={}){ws.send(JSON.stringify({type,...extra}))}function connect(code){e('entry').classList.add('hide');e('room').classList.remove('hide');e('roomcode').textContent=code;ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/rooms/'+code+'/ws');ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.type==='joined'){myId=m.id;e('enter').classList.add('hide');e('name').classList.add('hide');e('ready').classList.remove('hide')}if(m.type==='error'||m.type==='notice'||m.type==='answer')e('notice').textContent=m.message;if(m.type==='state'){state=m;e('players').replaceChildren(...m.players.map(p=>{const li=document.createElement('li');li.textContent=p.name+(p.ready?' ✓':'');return li}));e('start').classList.toggle('hide',m.phase!=='lobby'||m.hostId!==myId);e('start').disabled=m.players.length<3||m.players.length>5||m.players.some(p=>!p.ready);e('next').classList.toggle('hide',m.phase==='lobby'||m.hostId!==myId);e('phase').textContent=m.phase==='night'?'🌙 Nuit '+m.round:m.phase==='day'?'☀️ Jour '+m.round:m.phase==='finished'?'🏆 Victoire du camp Feuchien':'En attente';e('secret').classList.toggle('hide',!m.me?.role);e('role').textContent=m.me?.role||'';e('camp').textContent=m.me?.camp==='feuch'?'Camp Feuchiens':'Camp neutre';const action=m.phase==='night'&&(m.me?.role==='Feuch'||m.me?.role==='Natasha'&&!m.natashaUsed)||m.phase==='day';e('actions').classList.toggle('hide',!action);for(const id of ['target','other']){const select=e(id),old=select.value;select.replaceChildren(...m.players.filter(p=>id==='other'||p.id!==myId).map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;return o}));select.value=old||select.value}e('other').classList.toggle('hide',!(m.phase==='night'&&m.me?.role==='Natasha'));e('act').classList.toggle('hide',!(m.phase==='night'&&m.me?.role==='Feuch'||m.phase==='day'&&m.me?.role==='Marty'));e('act').textContent=m.phase==='night'?'Choisir la cible':'Demander : est-il Feuchien ?';e('link').classList.toggle('hide',!(m.phase==='night'&&m.me?.role==='Natasha'&&!m.natashaUsed));e('vote').classList.toggle('hide',m.phase!=='day'||m.voted);e('convert').classList.toggle('hide',!(m.phase==='day'&&m.me?.role==='Feuch'&&m.eligibleTarget&&!m.conversionUsed));e('convert').disabled=e('target').value!==m.eligibleTarget}};ws.onclose=()=>e('notice').textContent='Connexion interrompue : recharge la page.'}e('create').onclick=async()=>connect((await(await fetch('/api/rooms',{method:'POST'})).json()).code);e('join').onclick=()=>{const c=e('code').value.trim().toUpperCase();if(/^[A-F0-9]{6}$/.test(c))connect(c)};e('enter').onclick=()=>send('join',{name:e('name').value});e('ready').onclick=()=>send('ready');e('start').onclick=()=>send('start');e('next').onclick=()=>send('next');e('act').onclick=()=>send(state.phase==='night'?'target':'question',{target:e('target').value});e('link').onclick=()=>send('link',{target:e('target').value,other:e('other').value});e('vote').onclick=()=>send('vote',{target:e('target').value});e('target').onchange=()=>{if(state)e('convert').disabled=e('target').value!==state.eligibleTarget};e('convert').onclick=()=>send('convert',{target:e('target').value});</script></html>`;
