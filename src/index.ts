import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
type Env = { ROOM: DurableObjectNamespace; OCTOPUS_ENGINE_URL?: string };
type Role = 'Feuch' | 'Natasha' | 'Marty' | 'Nikolas' | 'Slobodane';
type Phase = 'lobby' | 'night' | 'day' | 'finished';
type Player = { id: string; name: string; ready: boolean; role?: Role; camp?: 'feuch' | 'neutral' };
type Challenge = { from: string; to: string; prompt: string; index: number; source: 'octopus' | 'local'; status: 'pending' | 'accepted' };
const challenges = ['Défends une théorie absurde pendant 20 secondes sans rire.', 'Invente un slogan pour le Feuch Institute en dix secondes.', 'Imite un présentateur annonçant une catastrophe ridicule à Blacklace.', 'Convaincs la table qu’un objet ordinaire est un artefact SATOR.', 'Fais une déclaration solennelle à la Fée Belette en une phrase.', 'Propose un alibi impossible pour la disparition du dernier cookie.', 'Décris Feuch comme si tu vendais une assurance habitation.', 'Invente un nouveau règlement municipal de Blacklace.', 'Fais la publicité d’un produit totalement inutile.', 'Résume ta journée comme une bande-annonce dramatique.'];
type Saved = { players: Player[]; hostId: string | null; phase: Phase; round: number; nightTarget: string | null; linked: string[]; natashaUsed: boolean; dayVotes: Record<string,string>; conversionUsed: boolean; challenge: Challenge | null; challengeUsed: string[]; vice: Record<string,number>; shields: string[]; winner: string | null };
const initial = (): Saved => ({ players: [], hostId: null, phase: 'lobby', round: 0, nightTarget: null, linked: [], natashaUsed: false, dayVotes: {}, conversionUsed: false, challenge: null, challengeUsed: [], vice: {}, shields: [], winner: null });
const app = new Hono<{ Bindings: Env }>();
app.get('/api/health', c => c.json({ ok: true, version: 'v0.7' }));
app.post('/api/rooms', c => c.json({ code: crypto.randomUUID().slice(0, 6).toUpperCase() }));
app.get('/api/rooms/:code/ws', c => {
  const code = c.req.param('code').toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(code)) return c.json({ error: 'Invalid code' }, 400);
  return c.env.ROOM.get(c.env.ROOM.idFromName(code)).fetch(c.req.raw);
});
app.get('/', c => c.html(html));
export default app;

export class GameRoom extends DurableObject {
  private octopusUrl: string;

  private state: Saved = initial();
  private sockets = new Map<WebSocket, string>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.octopusUrl = env.OCTOPUS_ENGINE_URL ?? 'https://octopus-engine-app.benoitlubert.workers.dev';
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
  private async suggestChallenge(): Promise<{ prompt: string; source: 'octopus' | 'local'; index: number }> {
    const fallback = () => { const index = Math.floor(Math.random() * challenges.length); return { prompt: challenges[index], source: 'local' as const, index }; };
    try {
      const response = await fetch(this.octopusUrl.replace(/\/$/, '') + '/mission', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ operationId: crypto.randomUUID(), title: 'Feuch Game — défi', objective: 'Proposer un défi humoristique oral, court et convivial pour deux joueurs.', requiredCapabilities: ['game.challenge.suggest'], authorizedResources: ['mistral'], context: { id: 'feuch-game', label: 'Feuch Game', metadata: { kind: 'party-game-challenge' } }, prompt: 'Réponds uniquement avec UNE phrase en français : un défi amusant réalisable à voix haute en moins de 30 secondes, sans matériel, sans danger, sans humiliation, sans alcool ni contenu sexuel. Univers absurde de Blacklace Island et Feuch Institute. Ne fournis ni titre, ni markdown, ni explication.' })
      });
      if (!response.ok) return fallback();
      const result = await response.json() as { status?: string; output?: { text?: unknown } };
      if (result.status !== 'completed' || typeof result.output?.text !== 'string') return fallback();
      const prompt = result.output.text.trim().replace(/^[`"']+|[`"']+$/g, '').trim();
      if (!prompt || prompt.length > 240 || prompt.length < 12) return fallback();
      return { prompt, source: 'octopus', index: -1 };
    } catch { return fallback(); }
  }
  private persist() { return this.ctx.storage.put('game', this.state); }
  private broadcast() {
    const s = this.state;
    const players = s.players.map(({ id, name, ready }) => ({ id, name, ready }));
    for (const [ws, id] of this.sockets) {
      const me = s.players.find(p => p.id === id);
      this.send(ws, { type: 'state', phase: s.phase, round: s.round, players, hostId: s.hostId, me: me ? { id: me.id, role: me.role, camp: me.camp } : null, linked: me && s.linked.includes(me.id) ? s.linked : [], natashaUsed: me?.role === 'Natasha' ? s.natashaUsed : undefined, voted: Boolean(s.dayVotes[id]), conversionUsed: me?.role === 'Feuch' ? s.conversionUsed : undefined, eligibleTarget: me?.role === 'Feuch' && s.phase === 'day' ? s.nightTarget : undefined, winner: s.winner, shielded: s.shields.includes(id), vice: s.vice, challenge: s.challenge, challenged: s.challengeUsed.includes(id) });
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
        const roles: Role[] = (['Feuch', 'Natasha', 'Marty', 'Slobodane', 'Nikolas'] as Role[]).slice(0, s.players.length);
        for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [roles[i], roles[j]] = [roles[j], roles[i]]; }
        s.players.forEach((p, i) => { p.role = roles[i]; p.camp = p.role === 'Feuch' || p.role === 'Slobodane' ? 'feuch' : 'neutral'; });
        s.phase = 'night'; s.round = 1; s.conversionUsed = false; s.challenge = null; s.challengeUsed = []; s.vice = {}; s.shields = [];
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
      } else if (m.type === 'shield' && s.phase === 'day' && me.camp === 'neutral') {
        if (s.shields.includes(me.id)) return this.error(ws, 'Bouclier déjà actif');
        if ((s.vice[me.id] ?? 0) < 2) return this.error(ws, 'Deux points de Vice nécessaires');
        s.vice[me.id] -= 2;
        s.shields.push(me.id);
        this.send(ws, { type: 'notice', message: 'Bouclier acheté pour cette journée.' });
      } else if (m.type === 'convert' && s.phase === 'day' && me.role === 'Feuch' && me.camp === 'feuch') {
        if (s.conversionUsed || !s.nightTarget || m.target !== s.nightTarget) return this.error(ws, 'Cible nocturne requise ou conversion déjà tentée');
        const target = s.players.find(p => p.id === m.target);
        if (!target) return this.error(ws, 'Cible introuvable');
        if (target.camp === 'feuch') return this.error(ws, 'Cette cible est déjà Feuchienne');
        s.conversionUsed = true;
        if (s.linked.includes(target.id) || s.shields.includes(target.id)) {
          this.send(ws, { type: 'notice', message: 'Conversion bloquée par une protection.' });
          return void (await this.persist(), this.broadcast());
        }
        target.camp = 'feuch';
        this.send(ws, { type: 'notice', message: 'Conversion réussie : ' + target.name });
        if (s.players.every(p => p.camp === 'feuch')) { s.phase = 'finished'; s.winner = 'feuch'; }
      } else if (m.type === 'challenge' && s.phase === 'day') {
        if (s.challenge || s.challengeUsed.includes(me.id)) return this.error(ws, 'Défi déjà lancé ou en cours');
        if (!m.target || m.target === me.id || !s.players.some(p => p.id === m.target)) return this.error(ws, 'Adversaire invalide');
        const suggestion = await this.suggestChallenge();
        s.challenge = { from: me.id, to: m.target, ...suggestion, status: 'pending' };
        s.challengeUsed.push(me.id);
      } else if (m.type === 'respond' && s.phase === 'day') {
        if (!s.challenge || s.challenge.to !== me.id || (m.other !== 'accept' && m.other !== 'decline')) return this.error(ws, 'Réponse non autorisée');
        if (s.challenge.status !== 'pending') return this.error(ws, 'Défi déjà accepté');
        if (m.other === 'accept') {
          s.challenge.status = 'accepted';
          for (const socket of this.sockets.keys()) this.send(socket, { type: 'notice', message: 'Défi accepté : réalisez-le, puis l’hôte valide le résultat.' });
        } else {
          const winner = s.challenge.from;
          s.vice[winner] = (s.vice[winner] ?? 0) + 1;
          s.challenge = null;
          for (const socket of this.sockets.keys()) this.send(socket, { type: 'notice', message: 'Défi refusé : +1 Vice au provocateur.' });
        }
      } else if (m.type === 'resolve' && s.phase === 'day') {
        if (me.id !== s.hostId || !s.challenge || s.challenge.status !== 'accepted') return this.error(ws, 'Résolution réservée à l’hôte après acceptation');
        if (m.other !== 'success' && m.other !== 'failure') return this.error(ws, 'Résultat invalide');
        const winner = m.other === 'success' ? s.challenge.to : s.challenge.from;
        s.vice[winner] = (s.vice[winner] ?? 0) + 1;
        const result = m.other === 'success' ? 'Défi réussi : +1 Vice au joueur défié.' : 'Défi raté : +1 Vice au provocateur.';
        s.challenge = null;
        for (const socket of this.sockets.keys()) this.send(socket, { type: 'notice', message: result });
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
          if (s.challenge) return this.error(ws, 'Résous le défi avant la nuit');
          if (s.round >= 5) {
            s.phase = 'finished';
            s.winner = s.players.every(p => p.camp === 'feuch') ? 'feuch' : 'neutral';
            await this.persist(); this.broadcast(); return;
          }
          s.dayVotes = {};
          s.challenge = null;
          s.challengeUsed = [];
          s.nightTarget = null;
          s.conversionUsed = false;
          s.shields = [];
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
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feuch Game</title><style>body{background:#1b1128;color:white;font:17px system-ui;margin:0;padding:24px}main{max-width:480px;margin:auto}h1{color:#ff9d29;font-size:44px}section{border:1px solid #665477;border-radius:20px;padding:20px;margin:20px 0}button,input,select{padding:12px;border-radius:9px;font:inherit;margin:5px;max-width:95%}button{background:#ff9d29;border:0;font-weight:bold}button:disabled{opacity:.4}.hide{display:none}#roomcode,#role{font-size:30px;color:#ffbd65}small{color:#cbb6db}</style><main><h1>FEUCH GAME</h1><p>Le vice est parmi nous.</p><section id="entry"><button id="create">Créer un salon</button><input id="code" placeholder="Code à 6 caractères"><button id="join">Rejoindre</button></section><section id="room" class="hide"><p>Salon <strong id="roomcode"></strong></p><input id="name" placeholder="Ton pseudo"><button id="enter">Entrer</button><p id="notice"></p><ul id="players"></ul><button id="ready" class="hide">Prêt !</button><button id="start" class="hide">Distribuer les rôles</button><h2 id="phase"></h2><div id="secret" class="hide"><p>TA CARTE SECRÈTE</p><div id="role"></div><p id="camp"></p><small>Ne montre pas cet écran !</small></div><div id="actions" class="hide"><select id="target"></select><select id="other" class="hide"></select><button id="act"></button><button id="link" class="hide">Lier ces deux joueurs</button><button id="vote" class="hide">Voter</button><button id="convert" class="hide">Convertir la cible nocturne</button><button id="challenge" class="hide">Défier ce joueur</button><button id="shield" class="hide">Bouclier personnel · 2 Vice</button><div id="challengebox" class="hide"><p id="challengeprompt"></p><button id="accept" class="hide">Accepter</button><button id="decline" class="hide">Refuser</button><button id="success" class="hide">Défi réussi (hôte)</button><button id="failure" class="hide">Défi raté (hôte)</button></div><p id="vice"></p></div><button id="next" class="hide">Phase suivante (hôte)</button></section><small>V0.7 : défis générés par Octopus Engine, avec secours local si le service est indisponible.</small></main><script>let ws,myId,state;const e=id=>document.getElementById(id);function send(type,extra={}){ws.send(JSON.stringify({type,...extra}))}function connect(code){e('entry').classList.add('hide');e('room').classList.remove('hide');e('roomcode').textContent=code;ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/rooms/'+code+'/ws');ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.type==='joined'){myId=m.id;e('enter').classList.add('hide');e('name').classList.add('hide');e('ready').classList.remove('hide')}if(m.type==='error'||m.type==='notice'||m.type==='answer')e('notice').textContent=m.message;if(m.type==='state'){state=m;e('players').replaceChildren(...m.players.map(p=>{const li=document.createElement('li');li.textContent=p.name+(p.ready?' ✓':'');return li}));e('start').classList.toggle('hide',m.phase!=='lobby'||m.hostId!==myId);e('start').disabled=m.players.length<3||m.players.length>5||m.players.some(p=>!p.ready);e('next').classList.toggle('hide',m.phase==='lobby'||m.hostId!==myId);e('phase').textContent=m.phase==='night'?'🌙 Nuit '+m.round:m.phase==='day'?'☀️ Jour '+m.round:m.phase==='finished'?(m.winner==='feuch'?'🏆 Victoire des Feuchiens':'🏆 Résistance des non-Feuchiens'):'En attente';e('secret').classList.toggle('hide',!m.me?.role);e('role').textContent=m.me?.role||'';e('camp').textContent=m.me?.camp==='feuch'?'Camp Feuchiens':'Camp neutre';const action=m.phase==='night'&&(m.me?.role==='Feuch'||m.me?.role==='Natasha'&&!m.natashaUsed)||m.phase==='day';e('actions').classList.toggle('hide',!action);for(const id of ['target','other']){const select=e(id),old=select.value;select.replaceChildren(...m.players.filter(p=>id==='other'||p.id!==myId).map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;return o}));select.value=old||select.value}e('other').classList.toggle('hide',!(m.phase==='night'&&m.me?.role==='Natasha'));e('act').classList.toggle('hide',!(m.phase==='night'&&m.me?.role==='Feuch'||m.phase==='day'&&m.me?.role==='Marty'));e('act').textContent=m.phase==='night'?'Choisir la cible':'Demander : est-il Feuchien ?';e('link').classList.toggle('hide',!(m.phase==='night'&&m.me?.role==='Natasha'&&!m.natashaUsed));e('vote').classList.toggle('hide',m.phase!=='day'||m.voted);e('convert').classList.toggle('hide',!(m.phase==='day'&&m.me?.role==='Feuch'&&m.eligibleTarget&&!m.conversionUsed));e('convert').disabled=e('target').value!==m.eligibleTarget;e('challenge').classList.toggle('hide',m.phase!=='day'||m.challenged||!!m.challenge);e('shield').classList.toggle('hide',m.phase!=='day'||m.me?.camp!=='neutral'||m.shielded);e('shield').disabled=(m.vice[myId]||0)<2;e('challengebox').classList.toggle('hide',!m.challenge);e('challengeprompt').textContent=m.challenge?m.players.find(p=>p.id===m.challenge.from)?.name+' défie '+m.players.find(p=>p.id===m.challenge.to)?.name+' : '+m.challenge.prompt:'';e('accept').classList.toggle('hide',!m.challenge||m.challenge.to!==myId||m.challenge.status!=='pending');e('decline').classList.toggle('hide',!m.challenge||m.challenge.to!==myId||m.challenge.status!=='pending');e('success').classList.toggle('hide',!m.challenge||m.challenge.status!=='accepted'||m.hostId!==myId);e('failure').classList.toggle('hide',!m.challenge||m.challenge.status!=='accepted'||m.hostId!==myId);e('vice').textContent='Vice : '+m.players.map(p=>p.name+' '+(m.vice[p.id]||0)).join(' · ')}};ws.onclose=()=>e('notice').textContent='Connexion interrompue : recharge la page.'}e('create').onclick=async()=>connect((await(await fetch('/api/rooms',{method:'POST'})).json()).code);e('join').onclick=()=>{const c=e('code').value.trim().toUpperCase();if(/^[A-F0-9]{6}$/.test(c))connect(c)};e('enter').onclick=()=>send('join',{name:e('name').value});e('ready').onclick=()=>send('ready');e('start').onclick=()=>send('start');e('next').onclick=()=>send('next');e('act').onclick=()=>send(state.phase==='night'?'target':'question',{target:e('target').value});e('link').onclick=()=>send('link',{target:e('target').value,other:e('other').value});e('vote').onclick=()=>send('vote',{target:e('target').value});e('target').onchange=()=>{if(state)e('convert').disabled=e('target').value!==state.eligibleTarget};e('convert').onclick=()=>send('convert',{target:e('target').value});e('challenge').onclick=()=>send('challenge',{target:e('target').value});e('shield').onclick=()=>send('shield');e('accept').onclick=()=>send('respond',{other:'accept'});e('decline').onclick=()=>send('respond',{other:'decline'});e('success').onclick=()=>send('resolve',{other:'success'});e('failure').onclick=()=>send('resolve',{other:'failure'});</script></html>`;
