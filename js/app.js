/**
 * app.js — LILA BLACK Telemetry Tool
 * Application state, UI wiring, and render loop.
 *
 * Architecture note: all public methods are attached to window.App at boot
 * so HTML inline handlers (onclick, oninput) can call them without a bundler.
 */

import { parseParquet } from './parser.js';
import { MapRenderer, MAP_CONFIGS, EVENT_META, PLAYER_COLORS } from './canvas.js';
import { Timeline, formatMs } from './timeline.js';

// ─── Module-level state ────────────────────────────────────────────────────────
let sessions      = [];
let playerMap     = {};          // uid → { color, on, isBot }
let activeMap     = 'AmbroseValley';
let activeMatch   = null;        // null = show all matches
let playerFilter  = 'all';       // 'all' | 'human' | 'bot'
let activeEvTypes = new Set(Object.keys(EVENT_META));
let heatmapMode   = 'off';       // 'off' | 'traffic' | 'kills' | 'deaths'
let renderer      = null;
let tl            = null;

// ─── Boot ──────────────────────────────────────────────────────────────────────
export async function init() {
  const mainCv = document.getElementById('main-canvas');
  const heatCv = document.getElementById('heat-canvas');
  renderer = new MapRenderer(mainCv, heatCv);

  tl = new Timeline(timeMs => {
    updatePlayhead(timeMs);
    renderFrame();
  });

  // Attach public API to window so HTML onclick/oninput work
  window.App = buildPublicAPI();

  // Pre-load minimap
  const cfg = MAP_CONFIGS[activeMap];
  renderer.loadMapImage(cfg.img).catch(() => {});

  // Load pre-parsed sessions
  try {
    const r = await fetch('data/sessions.json');
    if (r.ok) ingestSessions(await r.json());
  } catch (e) {
    console.warn('sessions.json not found, starting empty:', e);
  }

  wireCanvasInteraction();
  resizeCanvases();
  window.addEventListener('resize', debounce(() => {
    resizeCanvases();
    fullRender();
  }, 120));

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
        on: true,
        isBot: s.is_bot,
      };
    }
    s._color = playerMap[s.uid].color;
  });
  rebuildUI();
}

// ─── Filtering ─────────────────────────────────────────────────────────────────
function activeSessions() {
  return sessions.filter(s => {
    if (s.map_id !== activeMap) return false;
    if (activeMatch && s.mid !== activeMatch) return false;
    if (playerFilter === 'human' && s.is_bot) return false;
    if (playerFilter === 'bot'   && !s.is_bot) return false;
    return playerMap[s.uid]?.on !== false;
  });
}

function visibleUids() {
  return new Set(activeSessions().map(s => s.uid));
}

// ─── Render ────────────────────────────────────────────────────────────────────
function renderFrame() {
  const ss = activeSessions();
  const timeMs = (tl && tl.totalMs > 0) ? tl.timeMs : null;
  renderer.render(ss, activeEvTypes, visibleUids(), timeMs);
  updateStats(ss);
}

function fullRender() {
  const ss = activeSessions();

  // Load minimap for active map
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

  // Heatmap
  renderer.layers.heatmap = heatmapMode !== 'off';
  if (heatmapMode !== 'off') renderer.buildHeatmap(ss, heatmapMode);

  // Timeline: use sessions that have timestamps
  const tsSessions = ss.filter(s => s.hasTs);
  tl.load(tsSessions);
  updateTimelineUI(tl.totalMs, tsSessions.length);

  renderFrame();
}

// ─── Canvas size ───────────────────────────────────────────────────────────────
function resizeCanvases() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth, h = vp.clientHeight;
  ['main-canvas','heat-canvas'].forEach(id => {
    const c = document.getElementById(id);
    c.width = w; c.height = h;
  });
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
  fullRender();
}

function buildMapTabs() {
  const maps = [...new Set(sessions.map(s => s.map_id))].sort();
  // Ensure activeMap is valid
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
    const k = evs.filter(e => e.ev === 'Kill'   || e.ev === 'BotKill').length;
    const d = evs.filter(e => ['Killed','BotKilled','KilledByStorm'].includes(e.ev)).length;
    const l = evs.filter(e => e.ev === 'Loot').length;
    return `
      <div class="pitem${p.on ? '' : ' off'}" onclick="App.togglePlayer('${uid}')">
        <div class="pswatch" style="background:${p.color}"></div>
        <div class="pinfo">
          <div class="pid">${uid.slice(0,13)}</div>
          <div class="psub">${ss.length} session${ss.length !== 1 ? 's' : ''} · ${p.isBot ? '🤖 bot' : '👤 human'}</div>
        </div>
        <div class="pstats">
          ${k ? `<span class="pk">✕${k}</span>` : ''}
          ${d ? `<span class="pd">☠${d}</span>` : ''}
          ${l ? `<span class="pl">◆${l}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function buildEventFilters() {
  const el = document.getElementById('ev-filters');
  if (!el) return;
  el.innerHTML = Object.entries(EVENT_META).map(([key, m]) => {
    const on = activeEvTypes.has(key);
    return `<div class="evpill${on ? ' on' : ''}" style="--ec:${m.color}"
      onclick="App.toggleEvType('${key}')">${m.label}</div>`;
  }).join('');
}

function buildLegend() {
  const el = document.getElementById('legend');
  if (!el) return;
  el.innerHTML = Object.entries(EVENT_META).map(([, m]) => `
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

function updateMapInfo() {
  const el = document.getElementById('map-info');
  if (!el) return;
  const cfg = MAP_CONFIGS[activeMap];
  const ss = sessions.filter(s => s.map_id === activeMap);
  if (!cfg || !ss.length) { el.innerHTML = '<div>No data for this map</div>'; return; }
  el.innerHTML = `
    <div>Scale: <span style="color:var(--acc)">${cfg.scale}</span> units</div>
    <div>Origin X: <span style="color:var(--acc)">${cfg.ox}</span></div>
    <div>Origin Z: <span style="color:var(--acc)">${cfg.oz}</span></div>
    <div>Sessions: <span style="color:var(--acc)">${ss.length}</span></div>
    <div>With coords: <span style="color:var(--acc)">${ss.filter(s=>s.hasCoords).length}</span></div>
    <div>With timestamps: <span style="color:var(--acc)">${ss.filter(s=>s.hasTs).length}</span></div>`;
}

// ─── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(ss) {
  const evs = ss.flatMap(s => s.events);
  const k = evs.filter(e => e.ev === 'Kill' || e.ev === 'BotKill').length;
  const d = evs.filter(e => ['Killed','BotKilled','KilledByStorm'].includes(e.ev)).length;
  const l = evs.filter(e => e.ev === 'Loot').length;
  const p = evs.filter(e => e.ev === 'Position' || e.ev === 'BotPosition').length;
  const u = new Set(ss.map(s => s.uid)).size;

  // Header stats
  setText('stat-h-sessions', ss.length);
  setText('stat-h-players',  u);
  setText('stat-h-events',   evs.length);
  setText('stat-h-kills',    k);
  setText('stat-h-deaths',   d);

  // Right panel stats
  setText('stat-sessions', ss.length);
  setText('stat-players',  u);
  setText('stat-kills',    k);
  setText('stat-loot',     l);
  setText('stat-deaths',   d);
  setText('stat-pos',      p);

  // Event breakdown bars
  const ec = {};
  evs.forEach(e => { ec[e.ev] = (ec[e.ev] || 0) + 1; });
  const maxC = Math.max(...Object.values(ec), 1);
  const barsEl = document.getElementById('ev-bars');
  if (barsEl) {
    barsEl.innerHTML = Object.entries(ec).sort(([,a],[,b]) => b - a).map(([ev, cnt]) => {
      const m = EVENT_META[ev] || { color: '#888', label: ev };
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
    if (!e.x || !e.z || !(e.ev === 'Kill' || e.ev === 'BotKill')) return;
    const key = `${Math.floor(e.x/G)},${Math.floor(e.z/G)}`;
    if (!cells[key]) cells[key] = { n: 0, cx: (Math.floor(e.x/G) + .5) * G, cz: (Math.floor(e.z/G) + .5) * G };
    cells[key].n++;
  }));
  const top = Object.values(cells).sort((a,b) => b.n - a.n).slice(0, 5);
  if (!top.length) { el.innerHTML = '<div class="nd">No kill data</div>'; return; }
  el.innerHTML = top.map((z, i) => `
    <div class="hzrow" onclick="App.panToWorld(${z.cx},${z.cz},'${activeMap}')">
      <span class="hzrank">#${i+1}</span>
      <span class="hzloc">X:${z.cx.toFixed(0)} Z:${z.cz.toFixed(0)}</span>
      <span class="hzcnt">✕${z.n}</span>
    </div>`).join('');
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
  if (tsCountEl) tsCountEl.textContent = `${tsCount || 0} session${tsCount !== 1 ? 's' : ''}`;
  updatePlayhead(0);
}

function updatePlayhead(timeMs) {
  const scrubber  = document.getElementById('tl-scrubber');
  const currentEl = document.getElementById('tl-current');
  if (scrubber)  scrubber.value = Math.floor(timeMs);
  if (currentEl) currentEl.textContent = formatMs(timeMs);

  const track = document.getElementById('tl-track');
  if (track && tl.totalMs > 0) {
    track.style.setProperty('--progress', `${(timeMs / tl.totalMs) * 100}%`);
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
    drag = true;
    ds = { x: e.clientX, y: e.clientY };
    cs = { x: renderer.cam.x, y: renderer.cam.y };
    cv.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    if (drag) { drag = false; cv.style.cursor = 'grab'; }
  });

  cv.addEventListener('mousemove', e => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    if (drag) {
      renderer.cam.x = cs.x + e.clientX - ds.x;
      renderer.cam.y = cs.y + e.clientY - ds.y;
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
      tip.classList.remove('show');
      return;
    }

    // Tooltip hit-test
    const hit = renderer.hitTest(mx, my, activeSessions(), activeEvTypes);
    if (hit) {
      renderer.hoverEvent = hit.event;
      cv.style.cursor = 'pointer';
      const m = EVENT_META[hit.event.ev] || {};
      const p = playerMap[hit.session.uid] || {};
      const coordLine = hit.event.x != null
        ? `<div class="tt-row"><span>WORLD</span><span>X:${hit.event.x.toFixed(1)} Z:${hit.event.z.toFixed(1)}</span></div>`
        : '';
      const timeLine = hit.event.ts_rel != null
        ? `<div class="tt-row"><span>TIME</span><span>${formatMs(hit.event.ts_rel / 1000)}</span></div>`
        : '';
      tip.innerHTML = `
        <div class="tt-ev" style="color:${m.color}">${(m.label || hit.event.ev).toUpperCase()}</div>
        <div class="tt-uid" style="color:${p.color||'#aaa'}">${hit.session.is_bot ? '🤖' : '👤'} ${hit.session.uid.slice(0,16)}</div>
        <div class="tt-row"><span>MAP</span><span>${hit.session.map_id}</span></div>
        ${coordLine}
        ${timeLine}
        <div class="tt-row"><span>SESSION</span><span>${hit.session.mid.slice(0,8)}…</span></div>`;
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY - 8 ) + 'px';
      tip.classList.add('show');
    } else {
      renderer.hoverEvent = null;
      cv.style.cursor = 'grab';
      tip.classList.remove('show');
    }
    renderFrame();

    // Live world coords
    const { px, py } = renderer.fromScreen(mx, my);
    const { wx, wz } = renderer.fromPixel(px, py, activeMap);
    setText('coord-display', `X: ${wx.toFixed(1)}  Z: ${wz.toFixed(1)}`);
  });

  cv.addEventListener('mouseleave', () => {
    renderer.hoverEvent = null;
    tip.classList.remove('show');
    renderFrame();
  });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const oz = renderer.cam.zoom;
    const nz = Math.max(0.05, Math.min(14, oz * factor));
    const sc = renderer._sc;

    // Find the map pixel currently under the cursor
    const oxOld = (renderer.W - 1024 * sc * oz) / 2 + renderer.cam.x;
    const oyOld = (renderer.H - 1024 * sc * oz) / 2 + renderer.cam.y;
    const pxCursor = (mx - oxOld) / (sc * oz);
    const pyCursor = (my - oyOld) / (sc * oz);

    // After zoom, keep that map pixel under the cursor
    renderer.cam.zoom = nz;
    renderer.cam.x = mx - pxCursor * sc * nz - (renderer.W - 1024 * sc * nz) / 2;
    renderer.cam.y = my - pyCursor * sc * nz - (renderer.H - 1024 * sc * nz) / 2;

    if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
    renderFrame();
    setText('zoom-display', Math.round(nz * 100) + '%');
  }, { passive: false });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R') { App.resetCamera(); }
    if (e.key === ' ')  { e.preventDefault(); App.tlPlay(); }
    if (e.key === 'e' || e.key === 'E') App.exportPng();
  });

  // Drag-drop files onto viewport
  vp.addEventListener('dragover',  e => { e.preventDefault(); vp.classList.add('drag-over'); });
  vp.addEventListener('dragleave', () => vp.classList.remove('drag-over'));
  vp.addEventListener('drop', e => {
    e.preventDefault();
    vp.classList.remove('drag-over');
    App.loadFiles(e.dataTransfer.files);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────────
function buildPublicAPI() {
  return {
    setMap(mapId) {
      activeMap   = mapId;
      activeMatch = null;
      renderer.cam.reset();
      buildMapTabs();
      buildMatchSelector();
      buildPlayerList();
      updateMapInfo();
      fullRender();
    },

    setMatch(mid) {
      activeMatch = mid || null;
      buildPlayerList();
      fullRender();
    },

    setPlayerFilter(f) {
      playerFilter = f;
      ['all','human','bot'].forEach(k => {
        const btn = document.getElementById(`pf-${k}`);
        if (btn) btn.classList.toggle('active', k === f);
      });
      buildPlayerList();
      fullRender();
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
      buildEventFilters();
      renderFrame();
    },

    setAllEvTypes(on) {
      if (on) Object.keys(EVENT_META).forEach(k => activeEvTypes.add(k));
      else    activeEvTypes.clear();
      buildEventFilters();
      renderFrame();
    },

    setHeatmap(mode) {
      heatmapMode = mode;
      syncHeatmapButtons();
      renderer.layers.heatmap = mode !== 'off';
      if (mode !== 'off') renderer.buildHeatmap(activeSessions(), mode);
      renderFrame();
    },

    toggleLayer(key) {
      renderer.layers[key] = !renderer.layers[key];
      const tog = document.getElementById(`layer-${key}`);
      if (tog) tog.classList.toggle('on', renderer.layers[key]);
      renderFrame();
    },

    setPathAlpha(v) {
      renderer.pathAlpha = v / 100;
      renderFrame();
    },

    setMarkerScale(v) {
      renderer.markerScale = v / 100;
      renderFrame();
    },

    setHeatOpacity(v) {
      renderer.heatOpacity = v / 100;
      setText('heat-alpha-val', v);
      renderFrame();
    },

    setHeatRadius(v) {
      renderer.heatRadius = +v;
      setText('heat-radius-val', v);
      if (heatmapMode !== 'off') {
        renderer.buildHeatmap(activeSessions(), heatmapMode);
        renderFrame();
      }
    },

    panToWorld(wx, wz, mapId) {
      const cfg = MAP_CONFIGS[mapId] || MAP_CONFIGS.AmbroseValley;
      const px = ((wx - cfg.ox) / cfg.scale) * 1024;
      const py = (1  - (wz - cfg.oz) / cfg.scale) * 1024;
      // Zoom in a bit, then centre the target map pixel on screen
      renderer.cam.zoom = Math.min(renderer.cam.zoom * 1.5, 4);
      const sc = renderer._sc;
      const nz = renderer.cam.zoom;
      const cx = renderer.canvas.width  / 2;
      const cy = renderer.canvas.height / 2;
      // Set pan so target pixel lands at canvas centre
      renderer.cam.x = cx - px * sc * nz - (renderer.canvas.width  - 1024 * sc * nz) / 2;
      renderer.cam.y = cy - py * sc * nz - (renderer.canvas.height - 1024 * sc * nz) / 2;
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
    },

    resetCamera() {
      renderer.cam.reset();
      if (heatmapMode !== 'off') renderer.buildHeatmap(activeSessions(), heatmapMode);
      renderFrame();
    },

    // Timeline
    tlPlay()    { tl.toggle(); updatePlayhead(tl.timeMs); },
    tlSeek(v)   { tl.seek(+v); renderFrame(); },
    tlRestart() { tl.stop(); tl.timeMs = 0; updatePlayhead(0); renderFrame(); },
    tlSpeed(v)  {
      tl.speed = +v;
      setText('tl-speed-val', `${v}×`);
    },

    // Load additional files (user-dropped / file input)
    async loadFiles(files) {
      const arr = Array.from(files).filter(f =>
        f.name.endsWith('.nakama-0') || f.name.endsWith('.parquet')
      );
      if (!arr.length) return;
      const ov = document.getElementById('loading-overlay');
      const lt = ov.querySelector('.lt');
      if (lt) lt.textContent = `Parsing ${arr.length} file(s)…`;
      ov.style.display = 'flex';
      await new Promise(r => setTimeout(r, 20));
      let ok = 0, fail = 0;
      for (const file of arr) {
        try {
          const buf = await file.arrayBuffer();
          const s   = parseParquet(buf, file.name);
          if (s) { ingestSessions([s]); ok++; }
        } catch (err) {
          console.error('Parse error:', file.name, err);
          fail++;
        }
      }
      ov.style.display = 'none';
      if (lt) lt.textContent = `Loaded ${ok} file(s)${fail ? `, ${fail} failed` : ''}`;
      fullRender();
    },

    toggleInsights() {
      const panel    = document.getElementById('insights-panel');
      const backdrop = document.getElementById('insights-backdrop');
      const isOpen   = panel.classList.contains('open');
      panel.classList.toggle('open', !isOpen);
      backdrop.classList.toggle('open', !isOpen);
    },

    downloadInsights() {
      const md = `# LILA BLACK — Design Insights
Generated from 5 days of production telemetry (Feb 10–14, 2026)
20 sessions · 9 players · AmbroseValley + Lockdown · 220 events

---

## Insight 1 — Loot is the fight trigger, not position or rotation

**Confidence:** High

**What the data shows**
Every single kill hotzone cell overlaps with a loot hotzone cell — 12 out of 12, 100% overlap. The top kill cluster (world X: 56–100, Z: 110–129) accounts for 22% of all kills and 18% of all loot pickups. Kill cell ranking and loot cell ranking track almost identically across the map.

**What this means**
Players aren't fighting over angles or high ground. They're colliding because they're going for the same chest. Combat is loot-driven, not position-driven.

**Actionable items**
- Redistribute high-value loot into low-traffic zones to spread fights across the map
- Reduce loot density in the top hotzone to lower forced collision rate
- Audit whether the top hotzone is a deliberate POI or a side effect of spawner placement

**Metrics affected:** Kill spread across map · Average engagement distance · Time-to-first-contact

---

## Insight 2 — The right half of AmbroseValley is a dead zone

**Confidence:** High

**What the data shows**
The right half of the map (px > 512) accounts for only 37.5% of all events. The top-right quadrant registers zero activity — no positions, no kills, no loot pickups.

Quadrant traffic (NW origin):
  0  |  2  |  2  |  0
  8  | 14  | 22  |  0
  4  | 11  |  0  |  0
  1  |  1  |  0  |  0

**Actionable items**
- Add a high-value loot spawn or landmark on the right side
- Check sightlines from the active centre — exposed crossings with no cover kill traversal
- Walk the right side and ask: what is the pull?

**Metrics affected:** Event distribution by quadrant · Average path length · Zone utilisation rate

---

## Insight 3 — Lockdown is dramatically slower — no kills in 28 minutes

**Confidence:** Medium (single session sample)

**What the data shows**
The one timed Lockdown session ran for 28 minutes at 0.4 events/min. AmbroseValley sessions average 10–11 minutes at 1.0–1.2 events/min — 3× the activity rate. Zero kills and zero deaths in the Lockdown session.

**Actionable items**
- Review storm compression timing — slow zones let players avoid combat indefinitely
- Compare loot density per square metre between maps
- Check for long open sightlines that punish traversal and reward passive play

**Metrics affected:** Average match duration · Time-to-first-kill · Storm death rate · Kills per match

---

## Insight 4 — One player dominates by barely moving — likely a camp spot

**Confidence:** Medium (single player sample)

**What the data shows**
Player 2c551757 went 6 kills / 0 deaths across 3 sessions. Movement range in one session: 7 pixels wide on the minimap (~6 world units). They are anchoring one spot and winning every time.

Session breakdown:
  363f3851: K=2 D=0 Loot=4 X-movement=26px
  39a88d87: K=2 D=0 Loot=4 X-movement=66px
  e325a53a: K=2 D=0 Loot=5 X-movement=7px

**Actionable items**
- Cross-reference coordinates across sessions to confirm the exact spot
- Look at geometry: single entry? Wide angle? Uncontestable height advantage?
- Fix: second entry point, destructible cover, or flank route

**Metrics affected:** Position variance over time · Kills per map area · Camp detection rate

---

## Insight 5 — The storm is not creating pressure

**Confidence:** High

**What the data shows**
Across all 20 sessions, there is exactly 1 storm death vs 23 player kills. Storm death rate: ~3% of all deaths. Players are dying to each other 23× more than to the storm.

**Actionable items**
- Reduce storm warning time or increase early-phase contraction speed
- Check storm damage output — if players can tank it for 30 seconds, it is not threatening
- Tighten the final circle size

**Metrics affected:** Storm deaths per match · Distance from storm edge at match end · Time spent outside zone

---

*Note: Insights 3 and 4 are medium confidence due to small sample size. Expand to the full 1,243-session dataset to raise confidence.*
`;
      const blob = new Blob([md], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'LILA_BLACK_INSIGHTS.md';
      a.click();
      URL.revokeObjectURL(a.href);
    },

    exportPng() {
      const out = document.createElement('canvas');
      const main = document.getElementById('main-canvas');
      const heat = document.getElementById('heat-canvas');
      out.width  = main.width;
      out.height = main.height;
      const oc = out.getContext('2d');
      oc.drawImage(main, 0, 0);
      if (renderer.layers.heatmap) {
        oc.globalAlpha = renderer.heatOpacity;
        oc.drawImage(heat, 0, 0);
      }
      const a = document.createElement('a');
      a.download = `lilaBlack_${activeMap}_${Date.now()}.png`;
      a.href = out.toDataURL('image/png');
      a.click();
    },
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
