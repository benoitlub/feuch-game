import { Hono } from 'hono';
type Env = { ROOM: DurableObjectNamespace };
type Player = { id: string; name: string; ready: boolean; role?: string };
const app = new Hono<{ Bindings: Env }>();
app.get('/api/health', c => c.json({ ok: true }));
app.post('/api/rooms', c => c.json({ code: crypto.randomUUID().slice(0, 6).toUpperCase() }));
app.get('/api/rooms/:code/ws', c => {
  const code = c.req.param('code').toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(code)) return c.json({ error: 'Invalid code' }, 400);
  return c.env.ROOM.get(c.env.ROOM.idFromName(code)).fetch(c.req.raw);
});
app.get('/', c => c.html(html));
export default app;
export class GameRoom extends DurableObject {
  private players = new Map<WebSocket, Player>();
  private phase = 'lobby';
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of ctx.getWebSockets()) {
      const p = ws.deserializeAttachment() as Player | null;
      if (p) this.players.set(ws, p);
    }
  }
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: { type: string; name?: string };
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'join') {
      if (this.phase !== 'lobby' || this.players.size >= 10) return;
      const name = String(m.name ?? '').trim().slice(0, 24);
      if (!name) return;
      const p = { id: crypto.randomUUID(), name, ready: false };
      this.players.set(ws, p); ws.serializeAttachment(p);
      ws.send(JSON.stringify({ type: 'joined', id: p.id }));
    } else if (m.type === 'ready') {
      const p = this.players.get(ws); if (!p || this.phase !== 'lobby') return;
      p.ready = !p.ready; ws.serializeAttachment(p);
    } else if (m.type === 'start') {
      if (this.phase !== 'lobby' || this.players.size < 3 || [...this.players.values()].some(p => !p.ready)) return;
      const roles = ['Feuch', 'Natasha', 'Marty', 'Nikolas', 'Slobodane'];
      const shuffled = [...roles].sort(() => Math.random() - 0.5);
      let i = 0;
      for (const [socket, p] of this.players) {
        p.role = shuffled[i++ % shuffled.length]; socket.serializeAttachment(p);
        socket.send(JSON.stringify({ type: 'role', role: p.role }));
      }
      this.phase = 'night';
    }
    this.broadcast();
  }
  webSocketClose(ws: WebSocket) { this.players.delete(ws); this.broadcast(); }
  webSocketError(ws: WebSocket) { this.players.delete(ws); this.broadcast(); }
  private broadcast() {
    const players = [...this.players.values()].map(({ id, name, ready }) => ({ id, name, ready }));
    for (const ws of this.players.keys()) ws.send(JSON.stringify({ type: 'state', phase: this.phase, players }));
  }
}
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feuch Game</title><style>body{background:#1b1128;color:#fff;font:17px system-ui;margin:0;padding:24px}main{max-width:480px;margin:auto}h1{color:#ff9d29;font-size:48px}section{border:1px solid #665477;border-radius:20px;padding:20px;margin:20px 0}button,input{padding:12px;border-radius:9px;font:inherit;margin:5px}button{background:#ff9d29;border:0;font-weight:bold}input{max-width:85%}.hide{display:none}#roomcode,#role{font-size:32px;color:#ffbd65}</style><main><h1>FEUCH GAME</h1><p>Le vice est parmi nous.</p><section id="entry"><button id="create">Créer un salon</button><input id="code" placeholder="Code à 6 caractères"><button id="join">Rejoindre</button></section><section id="room" class="hide"><p>Salon</p><div id="roomcode"></div><input id="name" placeholder="Ton pseudo"><button id="enter">Entrer</button><ul id="players"></ul><button id="ready" class="hide">Prêt !</button><button id="start" class="hide">Distribuer les rôles</button><h2 id="phase"></h2><div id="secret" class="hide"><p>TA CARTE SECRÈTE</p><div id="role"></div><p>Ne montre pas cet écran !</p></div></section><small>Prototype : salon et distribution privée. Les pouvoirs et conversions arrivent ensuite.</small></main><script>let ws;const e=id=>document.getElementById(id);function connect(code){e('entry').classList.add('hide');e('room').classList.remove('hide');e('roomcode').textContent=code;ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/rooms/'+code+'/ws');ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.type==='joined'){e('enter').classList.add('hide');e('name').classList.add('hide');e('ready').classList.remove('hide')}if(m.type==='role'){e('secret').classList.remove('hide');e('role').textContent=m.role}if(m.type==='state'){e('players').replaceChildren(...m.players.map(p=>{const li=document.createElement('li');li.textContent=p.name+(p.ready?' ✓':'');return li}));e('start').classList.toggle('hide',m.phase!=='lobby');e('start').disabled=m.players.length<3||m.players.some(p=>!p.ready);e('phase').textContent=m.phase==='night'?'La nuit tombe…':'En attente des joueurs'}}}e('create').onclick=async()=>connect((await(await fetch('/api/rooms',{method:'POST'})).json()).code);e('join').onclick=()=>{const c=e('code').value.trim().toUpperCase();if(/^[A-F0-9]{6}$/.test(c))connect(c)};e('enter').onclick=()=>ws.send(JSON.stringify({type:'join',name:e('name').value}));e('ready').onclick=()=>ws.send(JSON.stringify({type:'ready'}));e('start').onclick=()=>ws.send(JSON.stringify({type:'start'}));</script></html>`;
