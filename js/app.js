/**
 * app.js — LILA BLACK Telemetry Tool
 * Application state, UI wiring, render loop.
 * Features: Zone Painter, Match Replay, Compare Two Matches.
 */

import { parseParquet }            from './parser.js';
import { MapRenderer, MAP_CONFIGS, EVENT_META, PLAYER_COLORS } from './canvas.js';
import { Timeline, formatMs }      from './timeline.js';
import { ZonePainter }             from './zonepaint.js';

// ─── State ─────────────────────────────────────────────────────────────────────
let sessions      = [];
let playerMap     = {};
let activeMap     = 'AmbroseValley';
let activeMatch   = null;
let matchB        = null;       // compare mode: second match
let playerFilter  = 'all';
let activeEvTypes = new Set(Object.keys(EVENT_META));
let heatmapMode   = 'off';
let toolMode      = 'normal';   // 'normal' | 'paint' | 'compare'

let renderer  = null;
let tl        = null;
let painter   = new ZonePainter();
let zoneStats = null;

// Replay HUD state
let replayHUD = { ev: null, uid: null, color: null };

// ─── Boot ──────────────────────────────────────────────────────────────────────
export async function init() {
  const mainCv = document.getElementById('main-canvas');
  renderer = new MapRenderer(mainCv);

  tl = new Timeline(timeMs => {
    updatePlayhead(timeMs);
    updateReplayHUD(timeMs);
    renderFrame();
  });

  window.App = buildPublicAPI();

  const cfg = MAP_CONFIGS[activeMap];
  renderer.loadMapImage(cfg.img).catch(() => {});

  try {
    const r = await fetch('data/sessions.json');
    if (r.ok) ingestSessions(await r.json());
  } catch (e) { console.warn('sessions.json:', e); }

  wireCanvasInteraction();
  resizeCanvases();
  window.addEventListener('resize', debounce(() => { resizeCanvases(); fullRender(); }, 120));

  document.getElementById('empty-state').style.display = 'none';
  fullRender();
}

// ─── Session management ────────────────────────────────────────────────────────
function ingestSessions(raw) {
  raw.forEach(s => {
    if (sessions.find(x => x.uid === s.uid && x.mid === s.mid)) return;
    sessions.push(s);
    if (!playerMap[s.uid]) {
      const idx = Object.keys(playerMap).length;
      playerMap[s.uid] = {
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
        on: true, isBot: s.is_bot,
      };
    }
    s._color = playerMap[s.uid].color;
  });
  rebuildUI();
}

// ─── Filtering ─────────────────────────────────────────────────────────────────
function activeSessions(matchOverride) {
  const match = matchOverride !== undefined ? matchOverride : activeMatch;
  return sessions.filter(s => {
    if (s.map_id !== activeMap) return false;
    if (match && s.mid !== match) return false;
    if (window._hiddenMids && window._hiddenMids.has(s.mid)) return false;
    if (playerFilter === 'human' && s.is_bot) return false;
    if (playerFilter === 'bot'   && !s.is_bot) return false;
    return playerMap[s.uid]?.on !== false;
  });
}

function visibleUids(matchOverride) {
  return new Set(activeSessions(matchOverride).map(s => s.uid));
}

// ─── Render ────────────────────────────────────────────────────────────────────
function renderFrame() {
  const ssA = activeSessions();
  const timeMs = (tl && tl.totalMs > 0) ? tl.timeMs : null;

  if (toolMode === 'compare' && matchB) {
    const ssB = activeSessions(matchB);
    renderer.renderCompare(ssA, ssB, activeEvTypes, visibleUids(), timeMs);
  } else {
    renderer.render(ssA, activeEvTypes, visibleUids(), timeMs);
  }

  // Draw zone painter overlay
  if (toolMode === 'paint' && painter.points.length) {
    painter.draw(renderer.ctx, renderer);
  }

  updateStats(ssA);
  updateCompareStats(ssA);
}

function fullRender() {
  const ss = activeSessions();
  const cfg = MAP_CONFIGS[activeMap];
  if (cfg) {
    const wantSrc = cfg.img;
    const haveSrc = renderer.mapImage ? renderer.mapImage.src : '';
    if (!haveSrc.includes(wantSrc)) {
      renderer.mapImage = null;
      renderer.loadMapImage(wantSrc).then(() => {
        if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
        renderFrame();
      }).catch(() => {});
    }
  }

  renderer.layers.heatmap = heatmapMode !== 'off';
  if (heatmapMode !== 'off') renderer.buildHeatmap(ss, heatmapMode);

  const tsSessions = ss.filter(s => s.hasTs);
  tl.load(tsSessions);
  updateTimelineUI(tl.totalMs, tsSessions.length);

  renderFrame();
}

// ─── Canvas resize ─────────────────────────────────────────────────────────────
function resizeCanvases() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth, h = vp.clientHeight;
  const mc = document.getElementById('main-canvas');
  mc.width = w; mc.height = h;
  // Keep offscreen heatmap canvas in sync
  if (renderer) {
    renderer.heatCv.width  = w;
    renderer.heatCv.height = h;
  }
}

// ─── Replay HUD ────────────────────────────────────────────────────────────────
function updateReplayHUD(timeMs) {
  const hud = document.getElementById('replay-hud');
  if (!hud || !tl.totalMs) return;

  const ss = activeSessions();
  let lastEv = null, lastDelta = Infinity;
  ss.forEach(s => {
    s.events.forEach(e => {
      if (e.ts_rel == null) return;
      const d = timeMs - e.ts_rel / 1000;
      if (d >= 0 && d < lastDelta) { lastDelta = d; lastEv = { e, s }; }
    });
  });

  if (lastEv && lastDelta < 3000) {
    const m = EVENT_META[lastEv.e.ev] || {};
    const p = playerMap[lastEv.s.uid] || {};
    hud.innerHTML = `
      <span class="rh-ev" style="color:${m.color}">${m.label || lastEv.e.ev}</span>
      <span class="rh-uid" style="color:${p.color||'#aaa'}">${lastEv.s.uid.slice(0,10)}</span>
      <span class="rh-time">${formatMs(timeMs)}</span>`;
    hud.style.opacity = Math.max(0, 1 - lastDelta / 3000);
  } else {
    hud.style.opacity = 0;
  }
}

// ─── UI builders ───────────────────────────────────────────────────────────────
function rebuildUI() {
  buildMapTabs();
  buildMatchSelector();
  buildPlayerList();
  buildEventFilters();
  buildLegend();
  syncHeatmapButtons();
  updateMapInfo();
  buildMatchFilter();
  buildCompareSelectorB();
  fullRender();
}

function buildMapTabs() {
  const maps = [...new Set(sessions.map(s => s.map_id))].sort();
  if (maps.length && !maps.includes(activeMap)) activeMap = maps[0];
  const el = document.getElementById('map-tabs');
  if (!el) return;
  el.innerHTML = maps.map(m => `
    <button class="map-tab${m === activeMap ? ' active' : ''}"
      onclick="App.setMap('${m}')">${m}</button>`).join('');
}

function buildMatchSelector() {
  const sel = document.getElementById('match-select');
  if (!sel) return;
  const matches = [...new Set(sessions.filter(s => s.map_id === activeMap).map(s => s.mid))];
  sel.innerHTML = `<option value="">All Matches (${matches.length})</option>` +
    matches.map(m => `<option value="${m}"${m === activeMatch ? ' selected' : ''}>${m.slice(0,12)}…</option>`).join('');
}

function buildCompareSelectorB() {
  const sel = document.getElementById('match-select-b');
  if (!sel) return;
  const matches = [...new Set(sessions.filter(s => s.map_id === activeMap).map(s => s.mid))];
  sel.innerHTML = `<option value="">Pick Match B</option>` +
    matches.map(m => `<option value="${m}"${m === matchB ? ' selected' : ''}>${m.slice(0,12)}…</option>`).join('');
}

function buildPlayerList() {
  const el = document.getElementById('player-list');
  if (!el) return;
  const entries = Object.entries(playerMap).filter(([uid]) =>
    sessions.some(s => s.uid === uid && s.map_id === activeMap)
  ).filter(([, p]) => {
    if (playerFilter === 'human') return !p.isBot;
    if (playerFilter === 'bot')   return  p.isBot;
    return true;
  });
  if (!entries.length) { el.innerHTML = '<div class="nd">No players on this map</div>'; return; }
  el.innerHTML = entries.map(([uid, p]) => {
    const ss  = sessions.filter(s => s.uid === uid && s.map_id === activeMap);
    const evs = ss.flatMap(s => s.events);
    const k = evs.filter(e => e.ev === 'Kill' || e.ev === 'BotKill').length;
    const d = evs.filter(e => ['Killed','BotKilled','KilledByStorm'].includes(e.ev)).length;
    const l = evs.filter(e => e.ev === 'Loot').length;
    return `
      <div class="pitem${p.on ? '' : ' off'}" onclick="App.togglePlayer('${uid}')">
        <div class="pswatch" style="background:${p.color}"></div>
        <div class="pinfo">
          <div class="pid">${uid.slice(0,13)}</div>
          <div class="psub">${ss.length} session${ss.length!==1?'s':''} · ${p.isBot?'🤖 bot':'👤 human'}</div>
        </div>
        <div class="pstats">
          ${k?`<span class="pk">✕${k}</span>`:''}
          ${d?`<span class="pd">☠${d}</span>`:''}
          ${l?`<span class="pl">◆${l}</span>`:''}
        </div>
      </div>`;
  }).join('');
}

function buildEventFilters() {
  const el = document.getElementById('ev-filters');
  if (!el) return;
  el.innerHTML = Object.entries(EVENT_META).map(([key, m]) => {
    const on = activeEvTypes.has(key);
    return `<div class="evpill${on?' on':''}" style="--ec:${m.color}"
      onclick="App.toggleEvType('${key}')">${m.label}</div>`;
  }).join('');
}

function buildLegend() {
  const el = document.getElementById('legend');
  if (!el) return;
  el.innerHTML = Object.entries(EVENT_META).map(([,m]) => `
    <div class="lgrow">
      <div class="lgdot" style="background:${m.color}"></div>
      <span style="color:${m.color}">${m.label}</span>
      <span class="lgcat">${m.category}</span>
    </div>`).join('');
}

function syncHeatmapButtons() {
  ['off','traffic','kills','deaths'].forEach(mode => {
    const btn = document.getElementById(`hm-${mode}`);
    if (btn) btn.classList.toggle('active', heatmapMode === mode);
  });
}

function buildMatchFilter() {
  const el = document.getElementById('match-filter-list');
  if (!el) return;

  // Get unique match IDs for current map, sorted
  const mapMatches = [...new Set(
    sessions.filter(s => s.map_id === activeMap).map(s => s.mid)
  )].sort();

  if (!mapMatches.length) {
    el.innerHTML = '<div style="font-size:8px;color:var(--muted);padding:4px 12px">No matches loaded</div>';
    return;
  }

  if (!window._hiddenMids) window._hiddenMids = new Set();

  el.innerHTML = mapMatches.map(mid => {
    const sessionCount = sessions.filter(s => s.map_id === activeMap && s.mid === mid).length;
    const isOff = window._hiddenMids.has(mid);
    const short = mid.length > 14 ? mid.slice(0, 14) + '…' : mid;
    return `<div class="mfpill${isOff ? ' off' : ''}" onclick="App.toggleMatchFilter('${mid}')" title="${mid}">
      <div class="mf-dot"></div>
      <span class="mf-label">${short}</span>
      <span class="mf-count">${sessionCount}s</span>
    </div>`;
  }).join('');
}

function updateMapInfo() {
  const el = document.getElementById('map-info');
  if (!el) return;
  const cfg = MAP_CONFIGS[activeMap];
  const ss = sessions.filter(s => s.map_id === activeMap);
  if (!cfg || !ss.length) { el.innerHTML = '<div>No data for this map</div>'; return; }
  el.innerHTML = `
    <div>Scale: <span style="color:var(--acc)">${cfg.scale}</span></div>
    <div>Origin X: <span style="color:var(--acc)">${cfg.ox}</span></div>
    <div>Origin Z: <span style="color:var(--acc)">${cfg.oz}</span></div>
    <div>Sessions: <span style="color:var(--acc)">${ss.length}</span></div>
    <div>With coords: <span style="color:var(--acc)">${ss.filter(s=>s.hasCoords).length}</span></div>
    <div>Timed: <span style="color:var(--acc)">${ss.filter(s=>s.hasTs).length}</span></div>`;
}

// ─── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(ss) {
  const evs = ss.flatMap(s => s.events);
  const k = evs.filter(e => e.ev==='Kill'||e.ev==='BotKill').length;
  const d = evs.filter(e => ['Killed','BotKilled','KilledByStorm'].includes(e.ev)).length;
  const l = evs.filter(e => e.ev==='Loot').length;
  const p = evs.filter(e => e.ev==='Position'||e.ev==='BotPosition').length;
  const u = new Set(ss.map(s => s.uid)).size;
  setText('stat-h-sessions', ss.length); setText('stat-h-players', u);
  setText('stat-h-events', evs.length);  setText('stat-h-kills', k);
  setText('stat-h-deaths', d);
  setText('stat-sessions', ss.length);   setText('stat-players', u);
  setText('stat-kills', k);              setText('stat-loot', l);
  setText('stat-deaths', d);             setText('stat-pos', p);

  const ec = {};
  evs.forEach(e => { ec[e.ev] = (ec[e.ev]||0)+1; });
  const maxC = Math.max(...Object.values(ec), 1);
  const barsEl = document.getElementById('ev-bars');
  if (barsEl) {
    barsEl.innerHTML = Object.entries(ec).sort(([,a],[,b])=>b-a).map(([ev,cnt]) => {
      const m = EVENT_META[ev] || { color:'#888', label:ev };
      return `<div class="evbar">
        <span class="evbar-label" style="color:${m.color}">${m.label.slice(0,9)}</span>
        <div class="evbar-track"><div class="evbar-fill" style="background:${m.color};width:${cnt/maxC*100}%"></div></div>
        <span class="evbar-count">${cnt}</span>
      </div>`;
    }).join('');
  }
  buildHotzones(ss);
}

function buildHotzones(ss) {
  const el = document.getElementById('hotzones');
  if (!el) return;
  const G = 60, cells = {};
  ss.forEach(s => s.events.forEach(e => {
    if (!e.x||!e.z||!(e.ev==='Kill'||e.ev==='BotKill')) return;
    const key = `${Math.floor(e.x/G)},${Math.floor(e.z/G)}`;
    if (!cells[key]) cells[key] = { n:0, cx:(Math.floor(e.x/G)+.5)*G, cz:(Math.floor(e.z/G)+.5)*G };
    cells[key].n++;
  }));
  const top = Object.values(cells).sort((a,b)=>b.n-a.n).slice(0,5);
  if (!top.length) { el.innerHTML = '<div class="nd">No kill data</div>'; return; }
  el.innerHTML = top.map((z,i) => `
    <div class="hzrow" onclick="App.panToWorld(${z.cx},${z.cz},'${activeMap}')">
      <span class="hzrank">#${i+1}</span>
      <span class="hzloc">X:${z.cx.toFixed(0)} Z:${z.cz.toFixed(0)}</span>
      <span class="hzcnt">✕${z.n}</span>
    </div>`).join('');
}

// ─── Compare stats ─────────────────────────────────────────────────────────────
function updateCompareStats(ssA) {
  const panel = document.getElementById('compare-stats');
  if (!panel) return;
  panel.style.display = (toolMode === 'compare' && matchB) ? 'grid' : 'none';
  if (toolMode !== 'compare' || !matchB) return;

  const ssB = activeSessions(matchB);
  renderMatchStats('cmp-a', ssA, activeMatch);
  renderMatchStats('cmp-b', ssB, matchB);
}

function renderMatchStats(prefix, ss, mid) {
  const evs = ss.flatMap(s => s.events);
  const k = evs.filter(e => e.ev==='Kill'||e.ev==='BotKill').length;
  const d = evs.filter(e => ['Killed','BotKilled','KilledByStorm'].includes(e.ev)).length;
  const l = evs.filter(e => e.ev==='Loot').length;
  const u = new Set(ss.map(s => s.uid)).size;
  const label = mid ? mid.slice(0,10)+'…' : 'All matches';
  setText(`${prefix}-label`, label);
  setText(`${prefix}-players`, u);
  setText(`${prefix}-kills`,   k);
  setText(`${prefix}-deaths`,  d);
  setText(`${prefix}-loot`,    l);
  setText(`${prefix}-events`,  evs.length);
}

// ─── Zone Painter stats panel ───────────────────────────────────────────────────
function showZoneStats(stats) {
  const el = document.getElementById('zone-stats-panel');
  if (!el) return;
  if (!stats || stats.total === 0) {
    el.innerHTML = '<div class="nd" style="color:var(--muted)">No events inside zone</div>';
    el.style.display = 'block';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <div class="zs-title">ZONE ANALYSIS</div>
    <div class="zs-grid">
      <div class="zscell"><div class="zs-val ck">${stats.kills}</div><div class="zs-lbl">KILLS</div></div>
      <div class="zscell"><div class="zs-val cd">${stats.deaths}</div><div class="zs-lbl">DEATHS</div></div>
      <div class="zscell"><div class="zs-val cl">${stats.loot}</div><div class="zs-lbl">LOOT</div></div>
      <div class="zscell"><div class="zs-val cp">${stats.pos}</div><div class="zs-lbl">POSITIONS</div></div>
    </div>
    <div class="zs-row"><span>Players in zone</span><span style="color:var(--acc)">${stats.players}</span></div>
    <div class="zs-row"><span>Total events</span><span style="color:var(--acc)">${stats.total}</span></div>
    ${stats.topPlayer ? `<div class="zs-row"><span>Most active</span><span style="color:var(--acc)">${stats.topPlayer.uid} (${stats.topPlayer.count})</span></div>` : ''}
    <div class="zs-row" style="margin-top:6px">
      <span style="color:var(--muted);font-size:8px">Kill density</span>
      <span style="color:var(--kill);font-size:9px">${stats.total ? (stats.kills/stats.total*100).toFixed(0)+'%' : '—'}</span>
    </div>
    <button class="smolbtn" style="margin-top:8px;width:100%" onclick="App.clearZone()">✕ CLEAR ZONE</button>`;
}

// ─── Timeline UI ───────────────────────────────────────────────────────────────
function updateTimelineUI(totalMs, tsCount) {
  const scrubber = document.getElementById('tl-scrubber');
  const totalEl  = document.getElementById('tl-total');
  const tsCountEl = document.getElementById('ts-count');
  const hasTl = totalMs > 0;
  document.getElementById('tl-bar').style.opacity = hasTl ? '1' : '0.35';
  if (scrubber)  { scrubber.max = Math.floor(totalMs); scrubber.value = 0; }
  if (totalEl)   totalEl.textContent = formatMs(totalMs);
  if (tsCountEl) tsCountEl.textContent = `${tsCount||0} session${tsCount!==1?'s':''}`;
  updatePlayhead(0);
}

function updatePlayhead(timeMs) {
  const scrubber  = document.getElementById('tl-scrubber');
  const currentEl = document.getElementById('tl-current');
  if (scrubber)  scrubber.value = Math.floor(timeMs);
  if (currentEl) currentEl.textContent = formatMs(timeMs);
  const track = document.getElementById('tl-track');
  if (track && tl.totalMs > 0) {
    track.style.setProperty('--progress', `${(timeMs/tl.totalMs)*100}%`);
  }
  const btn = document.getElementById('tl-playbtn');
  if (btn) btn.textContent = tl.playing ? '⏸' : '▶';
}

// ─── Canvas interaction ─────────────────────────────────────────────────────────
function wireCanvasInteraction() {
  const cv  = document.getElementById('main-canvas');
  const tip = document.getElementById('tooltip');
  const vp  = document.getElementById('viewport');
  let drag = false, ds = null, cs = null;

  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (toolMode === 'paint') return;
    drag = true;
    ds = { x: e.clientX, y: e.clientY };
    cs = { x: renderer.cam.x, y: renderer.cam.y };
    cv.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    if (drag) { drag = false; cv.style.cursor = toolMode === 'paint' ? 'crosshair' : 'grab'; }
  });

  cv.addEventListener('click', e => {
    if (toolMode !== 'paint') return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { px, py } = renderer.fromScreen(mx, my);
    const closed = painter.click(px, py);
    if (closed) {
      zoneStats = painter.computeStats(activeSessions(), activeEvTypes);
      showZoneStats(zoneStats);
    }
    renderFrame();
  });

  cv.addEventListener('dblclick', e => {
    if (toolMode !== 'paint') return;
    const closed = painter.dblclick();
    if (closed) {
      zoneStats = painter.computeStats(activeSessions(), activeEvTypes);
      showZoneStats(zoneStats);
    }
    renderFrame();
  });

  cv.addEventListener('mousemove', e => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    if (toolMode === 'paint') {
      const { px, py } = renderer.fromScreen(mx, my);
      painter.hoverPt = { x: px, y: py };
      renderFrame();
      return;
    }

    if (drag) {
      renderer.cam.x = cs.x + e.clientX - ds.x;
      renderer.cam.y = cs.y + e.clientY - ds.y;
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
      tip.classList.remove('show');
      return;
    }

    const hit = renderer.hitTest(mx, my, activeSessions(), activeEvTypes);
    if (hit) {
      renderer.hoverEvent = hit.event;
      cv.style.cursor = 'pointer';
      const m = EVENT_META[hit.event.ev] || {};
      const p = playerMap[hit.session.uid] || {};
      const coordLine = hit.event.x != null
        ? `<div class="tt-row"><span>WORLD</span><span>X:${hit.event.x.toFixed(1)} Z:${hit.event.z.toFixed(1)}</span></div>` : '';
      const timeLine = hit.event.ts_rel != null
        ? `<div class="tt-row"><span>TIME</span><span>${formatMs(hit.event.ts_rel/1000)}</span></div>` : '';
      tip.innerHTML = `
        <div class="tt-ev" style="color:${m.color}">${(m.label||hit.event.ev).toUpperCase()}</div>
        <div class="tt-uid" style="color:${p.color||'#aaa'}">${hit.session.is_bot?'🤖':'👤'} ${hit.session.uid.slice(0,16)}</div>
        <div class="tt-row"><span>MAP</span><span>${hit.session.map_id}</span></div>
        ${coordLine}${timeLine}
        <div class="tt-row"><span>SESSION</span><span>${hit.session.mid.slice(0,8)}…</span></div>`;
      tip.style.left = (e.clientX+14)+'px';
      tip.style.top  = (e.clientY-8)+'px';
      tip.classList.add('show');
    } else {
      renderer.hoverEvent = null;
      cv.style.cursor = 'grab';
      tip.classList.remove('show');
    }
    renderFrame();

    const { px, py } = renderer.fromScreen(mx, my);
    const { wx, wz } = renderer.fromPixel(px, py, activeMap);
    setText('coord-display', `X: ${wx.toFixed(1)}  Z: ${wz.toFixed(1)}`);
  });

  cv.addEventListener('mouseleave', () => {
    renderer.hoverEvent = null;
    if (toolMode === 'paint') painter.hoverPt = null;
    tip.classList.remove('show');
    renderFrame();
  });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const nz = Math.max(0.05, Math.min(14, renderer.cam.zoom * factor));
    const { x: ix, y: iy, w: iw, h: ih } = renderer._imgRect;
    const mapPx = (mx - ix) / iw, mapPy = (my - iy) / ih;
    renderer.cam.zoom = nz;
    renderFrame();
    renderer.cam.x += mx - (renderer._imgRect.x + mapPx * renderer._imgRect.w);
    renderer.cam.y += my - (renderer._imgRect.y + mapPy * renderer._imgRect.h);
    if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
    renderFrame();
    setText('zoom-display', Math.round(nz*100)+'%');
  }, { passive: false });

  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') return;
    if (e.key==='Escape') App.exitPaintMode();
    if (e.key==='r'||e.key==='R') App.resetCamera();
    if (e.key===' ') { e.preventDefault(); App.tlPlay(); }
    if (e.key==='e'||e.key==='E') App.exportPng();
    if (e.key==='p'||e.key==='P') App.togglePaintMode();
  });

  vp.addEventListener('dragover',  e => { e.preventDefault(); vp.classList.add('drag-over'); });
  vp.addEventListener('dragleave', () => vp.classList.remove('drag-over'));
  vp.addEventListener('drop', e => {
    e.preventDefault(); vp.classList.remove('drag-over');
    App.loadFiles(e.dataTransfer.files);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────────
function buildPublicAPI() {
  return {
    setMap(mapId) {
      activeMap = mapId; activeMatch = null; matchB = null;
      renderer.cam.reset();
      buildMapTabs(); buildMatchSelector(); buildPlayerList();
      buildCompareSelectorB(); updateMapInfo(); fullRender();
    },

    setMatch(mid) {
      activeMatch = mid || null;
      buildPlayerList(); fullRender();
    },

    setMatchB(mid) {
      matchB = mid || null;
      updateCompareStats(activeSessions());
      renderFrame();
    },

    setPlayerFilter(f) {
      playerFilter = f;
      ['all','human','bot'].forEach(k => {
        const btn = document.getElementById(`pf-${k}`);
        if (btn) btn.classList.toggle('active', k===f);
      });
      buildPlayerList(); fullRender();
    },

    togglePlayer(uid) {
      if (playerMap[uid]) {
        playerMap[uid].on = !playerMap[uid].on;
        buildPlayerList();
        if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
        renderFrame();
      }
    },

    allPlayers(on) {
      Object.keys(playerMap).forEach(uid => { playerMap[uid].on = on; });
      buildPlayerList();
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
    },

    toggleEvType(ev) {
      activeEvTypes.has(ev) ? activeEvTypes.delete(ev) : activeEvTypes.add(ev);
      buildEventFilters(); renderFrame();
    },

    setAllEvTypes(on) {
      if (on) Object.keys(EVENT_META).forEach(k => activeEvTypes.add(k));
      else    activeEvTypes.clear();
      buildEventFilters(); renderFrame();
    },

    setHeatmap(mode) {
      heatmapMode = mode;
      syncHeatmapButtons();
      renderer.layers.heatmap = mode !== 'off';
      if (mode !== 'off') {
        renderer.buildHeatmap(activeSessions(), mode);
      } else {
        // Explicitly clear the heatmap canvas so nothing bleeds through
        renderer.heatCtx.clearRect(0, 0, renderer.heatCv.width, renderer.heatCv.height);
      }
      renderFrame();
    },

    clearMatchFilter() {
      window._hiddenMids = new Set();
      buildMatchFilter();
      fullRender();
    },

    toggleMatchFilter(mid) {
      if (!window._hiddenMids) window._hiddenMids = new Set();
      if (window._hiddenMids.has(mid)) {
        window._hiddenMids.delete(mid);
      } else {
        window._hiddenMids.add(mid);
      }
      buildMatchFilter();
      fullRender();
    },

    toggleLayer(key) {
      renderer.layers[key] = !renderer.layers[key];
      const pill = document.getElementById(`layer-${key}`);
      if (pill) pill.classList.toggle('on', renderer.layers[key]);
      renderFrame();
    },

    setAllLayers(on) {
      Object.keys(renderer.layers).forEach(key => {
        if (key === 'heatmap') return; // heatmap handled separately
        renderer.layers[key] = on;
        const pill = document.getElementById(`layer-${key}`);
        if (pill) pill.classList.toggle('on', on);
      });
      renderFrame();
    },

    setPathAlpha(v)    { renderer.pathAlpha = v/100; renderFrame(); },
    setMarkerScale(v)  { renderer.markerScale = v/100; renderFrame(); },
    setHeatOpacity(v)  { renderer.heatOpacity = v/100; setText('heat-alpha-val', v); renderFrame(); },
    setHeatRadius(v)   {
      renderer.heatRadius = +v; setText('heat-radius-val', v);
      if (heatmapMode !== 'off') { renderer.buildHeatmap(activeSessions(), heatmapMode); renderFrame(); }
    },

    panToWorld(wx, wz, mapId) {
      const cfg = MAP_CONFIGS[mapId] || MAP_CONFIGS.AmbroseValley;
      const px = ((wx - cfg.ox) / cfg.scale) * 1024;
      const py = (1 - (wz - cfg.oz) / cfg.scale) * 1024;
      renderer.cam.zoom = Math.min(renderer.cam.zoom * 1.5, 4);
      renderFrame();
      const { x: ix, y: iy, w: iw, h: ih } = renderer._imgRect;
      const sx = ix + (px/1024)*iw, sy = iy + (py/1024)*ih;
      renderer.cam.x += renderer.canvas.width/2  - sx;
      renderer.cam.y += renderer.canvas.height/2 - sy;
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
    },

    resetCamera() {
      renderer.cam.reset();
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
    },

    // ── Zone Painter ────────────────────────────────────────────────────────────
    togglePaintMode() {
      if (toolMode === 'paint') {
        this.exitPaintMode(); return;
      }
      toolMode = 'paint';
      painter.reset();
      zoneStats = null;
      const el = document.getElementById('zone-stats-panel');
      if (el) el.style.display = 'none';
      document.getElementById('main-canvas').style.cursor = 'crosshair';
      document.getElementById('paint-btn').classList.add('active');
      document.getElementById('paint-hint').style.display = 'block';
      document.getElementById('compare-panel').style.display = 'none';
    },

    exitPaintMode() {
      if (toolMode !== 'paint') return;
      toolMode = 'normal';
      painter.reset();
      document.getElementById('main-canvas').style.cursor = 'grab';
      document.getElementById('paint-btn').classList.remove('active');
      document.getElementById('paint-hint').style.display = 'none';
      const el = document.getElementById('zone-stats-panel');
      if (el) el.style.display = 'none';
      renderFrame();
    },

    clearZone() {
      painter.reset(); zoneStats = null;
      const el = document.getElementById('zone-stats-panel');
      if (el) el.style.display = 'none';
      renderFrame();
    },

    // ── Compare ────────────────────────────────────────────────────────────────
    toggleCompare() {
      if (toolMode === 'compare') {
        toolMode = 'normal'; matchB = null;
        document.getElementById('compare-btn').classList.remove('active');
        document.getElementById('compare-panel').style.display = 'none';
        document.getElementById('compare-stats').style.display = 'none';
        renderFrame(); return;
      }
      if (toolMode === 'paint') this.exitPaintMode();
      toolMode = 'compare';
      document.getElementById('compare-btn').classList.add('active');
      document.getElementById('compare-panel').style.display = 'flex';
      buildCompareSelectorB();
      renderFrame();
    },

    // ── Replay ─────────────────────────────────────────────────────────────────
    startReplay(mid) {
      const ss = sessions.filter(s => s.map_id === activeMap && s.hasTs &&
        (mid ? s.mid === mid : true));
      if (!ss.length) { alert('No timed sessions for this match.'); return; }
      activeMatch = mid || null;
      buildMatchSelector();
      buildPlayerList();
      tl.load(ss);
      updateTimelineUI(tl.totalMs, ss.length);
      tl.seek(0);
      tl.play();
      document.getElementById('replay-hud').style.display = 'block';
      fullRender();
    },

    // ── Timeline ───────────────────────────────────────────────────────────────
    tlPlay()    { tl.toggle(); updatePlayhead(tl.timeMs); },
    tlSeek(v)   { tl.seek(+v); renderFrame(); },
    tlRestart() { tl.stop(); tl.timeMs = 0; updatePlayhead(0); renderFrame(); },
    tlSpeed(v)  { tl.speed = +v; setText('tl-speed-val', `${v}×`); },

    // ── File loading ───────────────────────────────────────────────────────────
    async loadFiles(files) {
      const arr = Array.from(files).filter(f => f.name.endsWith('.nakama-0')||f.name.endsWith('.parquet'));
      if (!arr.length) return;
      const ov = document.getElementById('loading-overlay');
      const lt = ov.querySelector('.lt');
      if (lt) lt.textContent = `Parsing ${arr.length} file(s)…`;
      ov.style.display = 'flex';
      await new Promise(r => setTimeout(r, 20));
      let ok = 0;
      for (const file of arr) {
        try {
          const s = parseParquet(await file.arrayBuffer(), file.name);
          if (s) { ingestSessions([s]); ok++; }
        } catch(err) { console.error(file.name, err); }
      }
      ov.style.display = 'none';
      fullRender();
    },

    exportPng() {
      // heatmap is already composited into main-canvas during render()
      const main = document.getElementById('main-canvas');
      const a = document.createElement('a');
      a.download = `lilaBlack_${activeMap}_${Date.now()}.png`;
      a.href = main.toDataURL('image/png'); a.click();
    },

    toggleInsights() {
      const panel = document.getElementById('insights-panel');
      const backdrop = document.getElementById('insights-backdrop');
      const isOpen = panel.classList.contains('open');
      panel.classList.toggle('open', !isOpen);
      backdrop.classList.toggle('open', !isOpen);
    },

    downloadInsights() {
      fetch('INSIGHTS.md').then(r => r.text()).then(md => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([md], { type:'text/markdown' }));
        a.download = 'LILA_BLACK_INSIGHTS.md'; a.click();
        URL.revokeObjectURL(a.href);
      }).catch(() => alert('INSIGHTS.md not found on server.'));
    },
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
