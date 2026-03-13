/**
 * canvas.js
 * All map rendering: minimap, event markers, movement paths, heatmap overlay.
 */

export const MAP_CONFIGS = {
  AmbroseValley: { scale: 900,  ox: -370, oz: -473, img: 'assets/AmbroseValley_Minimap.png' },
  GrandRift:     { scale: 581,  ox: -290, oz: -290, img: 'assets/GrandRift_Minimap.png'     },
  Lockdown:      { scale: 1000, ox: -500, oz: -500, img: 'assets/Lockdown_Minimap.jpg'      },
};

export const EVENT_META = {
  Position:      { color: '#00d4f0', label: 'Position',    category: 'move',   shape: 'diamond', size: 5  },
  BotPosition:   { color: '#006a78', label: 'Bot Pos',     category: 'move',   shape: 'diamond', size: 4  },
  Kill:          { color: '#ff2244', label: 'Kill',        category: 'kill',   shape: 'x',       size: 8  },
  BotKill:       { color: '#ff6644', label: 'Bot Kill',    category: 'kill',   shape: 'x',       size: 7  },
  Loot:          { color: '#f0c020', label: 'Loot',        category: 'loot',   shape: 'square',  size: 6  },
  Killed:        { color: '#b040ff', label: 'Death',       category: 'death',  shape: 'skull',   size: 7  },
  BotKilled:     { color: '#7822cc', label: 'Bot Death',   category: 'death',  shape: 'skull',   size: 6  },
  KilledByStorm: { color: '#3080ff', label: 'Storm Death', category: 'storm',  shape: 'bolt',    size: 8  },
};

export const PLAYER_COLORS = [
  '#ff6b00','#00d4f0','#ff2244','#30e880','#f0c020',
  '#b040ff','#ff80aa','#00e8c0','#ff9060','#8090ff',
  '#a8ff40','#ffb0d0','#ff2090','#b8ff00','#ff9800',
  '#30b8ff','#ff4060','#40ff90','#b090ff','#ffaa40',
];

// ─── Camera state ─────────────────────────────────────────────────────────────

export class Camera {
  constructor() { this.reset(); }
  reset() { this.x = 0; this.y = 0; this.zoom = 1; }

  // Map pixel coord → canvas screen coord
  toScreen(px, py, canvasW, canvasH) {
    return {
      sx: canvasW / 2 + (px - canvasW / 2) * this.zoom + this.x,
      sy: canvasH / 2 + (py - canvasH / 2) * this.zoom + this.y,
    };
  }

  // Canvas screen coord → map pixel coord
  fromScreen(sx, sy, canvasW, canvasH) {
    return {
      px: (sx - this.x - canvasW / 2) / this.zoom + canvasW / 2,
      py: (sy - this.y - canvasH / 2) / this.zoom + canvasH / 2,
    };
  }
}

// ─── Marker drawing ────────────────────────────────────────────────────────────

function drawDiamond(ctx, x, y, r, color) {
  ctx.shadowBlur = 6; ctx.shadowColor = color;
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawX(ctx, x, y, r, color) {
  ctx.shadowBlur = 8; ctx.shadowColor = color;
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2;
  const d = r * 0.55;
  ctx.beginPath();
  ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
  ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
  ctx.stroke();
}

function drawSquare(ctx, x, y, r, color) {
  ctx.shadowBlur = 6; ctx.shadowColor = color;
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 0.7;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.strokeRect(x - r, y - r, r * 2, r * 2);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - r * .55, y); ctx.lineTo(x + r * .55, y);
  ctx.moveTo(x, y - r * .55); ctx.lineTo(x, y + r * .55);
  ctx.stroke();
}

function drawSkull(ctx, x, y, r, color) {
  ctx.shadowBlur = 8; ctx.shadowColor = color;
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = `${Math.round(r * 1.3)}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('☠', x, y + 1);
}

function drawBolt(ctx, x, y, r, color) {
  ctx.shadowBlur = 10; ctx.shadowColor = color;
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = `${Math.round(r * 1.3)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('⚡', x, y);
}

export function drawMarker(ctx, sx, sy, evName, scale = 1, isHovered = false) {
  const meta = EVENT_META[evName];
  if (!meta) return;
  const r = meta.size * scale * (isHovered ? 1.8 : 1.0);
  ctx.save();
  ctx.globalAlpha = isHovered ? 1.0 : 0.85;
  switch (meta.shape) {
    case 'diamond': drawDiamond(ctx, sx, sy, r, meta.color); break;
    case 'x':       drawX(ctx, sx, sy, r, meta.color);       break;
    case 'square':  drawSquare(ctx, sx, sy, r, meta.color);  break;
    case 'skull':   drawSkull(ctx, sx, sy, r, meta.color);   break;
    case 'bolt':    drawBolt(ctx, sx, sy, r, meta.color);    break;
  }
  ctx.restore();
}

// ─── Main renderer ─────────────────────────────────────────────────────────────

export class MapRenderer {
  constructor(mainCanvas) {
    this.canvas  = mainCanvas;
    // Offscreen canvas for heatmap - rebuilt on every pan/zoom, composited into main canvas
    this.heatCv  = document.createElement('canvas');
    this.ctx     = mainCanvas.getContext('2d');
    this.heatCtx = this.heatCv.getContext('2d');
    this.cam     = new Camera();
    this.mapImage = null;
    this.hoverEvent = null;

    // Layer visibility
    this.layers = {
      paths:     true,
      arrows:    true,
      positions: true,
      kills:     true,
      loot:      true,
      deaths:    true,
      heatmap:   false,
    };
    this.heatOpacity = 0.70;
    this.heatRadius  = 30;
    this.markerScale = 1.0;
    this.pathAlpha   = 0.25;
  }

  get W() { return this.canvas.width; }
  get H() { return this.canvas.height; }

  // _imgRect: the actual screen rect the minimap image is drawn into.
  // Set during render() so toScreen/fromScreen always match the drawn image.
  // { x, y, w, h } — top-left origin + drawn dimensions.
  _imgRect = { x: 0, y: 0, w: 1, h: 1 };

  // Map pixel [0-1024] -> screen pixel
  toScreen(px, py) {
    const { x, y, w, h } = this._imgRect;
    return { sx: x + (px / 1024) * w, sy: y + (py / 1024) * h };
  }

  // Screen pixel -> map pixel [0-1024]
  fromScreen(sx, sy) {
    const { x, y, w, h } = this._imgRect;
    return { px: (sx - x) / w * 1024, py: (sy - y) / h * 1024 };
  }

  // Map pixel -> world coord
  fromPixel(px, py, mapId) {
    const cfg = MAP_CONFIGS[mapId] || MAP_CONFIGS.AmbroseValley;
    const u = px / 1024;
    const v = 1 - py / 1024;
    return { wx: u * cfg.scale + cfg.ox, wz: v * cfg.scale + cfg.oz };
  }

  loadMapImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { this.mapImage = img; resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  // ── Draw loop ──────────────────────────────────────────────────────────────

  render(sessions, activeEvTypes, visiblePlayerUids, timeMs = null) {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    // Background / minimap
    if (this.mapImage) {
      const iw = this.mapImage.naturalWidth;
      const ih = this.mapImage.naturalHeight;
      const sc = Math.min(W / iw, H / ih);
      const dw = iw * sc * this.cam.zoom;
      const dh = ih * sc * this.cam.zoom;
      const dx = (W - dw) / 2 + this.cam.x;
      const dy = (H - dh) / 2 + this.cam.y;
      // Store exact drawn rect — toScreen/fromScreen read this to stay in sync
      this._imgRect = { x: dx, y: dy, w: dw, h: dh };
      ctx.drawImage(this.mapImage, dx, dy, dw, dh);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(dx, dy, dw, dh);
    } else {
      ctx.fillStyle = '#080a0d';
      ctx.fillRect(0, 0, W, H);
      this._drawGrid();
      // Fallback rect: fill canvas
      this._imgRect = { x: 0, y: 0, w: W, h: H };
    }

    if (!sessions.length) return;

    // Filter events to what's visible at `timeMs`
    const visibleSessions = sessions.filter(s =>
      visiblePlayerUids.has(s.uid) &&
      (timeMs === null || s.hasTs)
    );
    // For sessions without timestamps, always show all their events
    const allSessions = sessions.filter(s => visiblePlayerUids.has(s.uid));

    // Draw paths
    if (this.layers.paths) {
      this._drawPaths(allSessions, activeEvTypes, timeMs, this.pathAlpha);
    }

    // Draw markers
    const shownTypes = new Set();
    if (this.layers.positions) { shownTypes.add('Position'); shownTypes.add('BotPosition'); }
    if (this.layers.kills)     { shownTypes.add('Kill'); shownTypes.add('BotKill'); }
    if (this.layers.loot)      { shownTypes.add('Loot'); }
    if (this.layers.deaths)    { shownTypes.add('Killed'); shownTypes.add('BotKilled'); shownTypes.add('KilledByStorm'); }

    this._drawMarkers(allSessions, shownTypes, activeEvTypes, timeMs);

    // Heatmap overlay
    if (this.layers.heatmap) {
      ctx.save();
      ctx.globalAlpha = this.heatOpacity;
      ctx.drawImage(this.heatCv, 0, 0);
      ctx.restore();
    }
  }

  _drawGrid() {
    const { ctx, W, H } = this;
    ctx.strokeStyle = '#12161c';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 70) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 70) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  _eventsUpTo(session, timeMs) {
    if (timeMs === null || !session.hasTs) return session.events;
    return session.events.filter(e => e.ts_rel != null && e.ts_rel / 1000 <= timeMs);
  }

  _drawPaths(sessions, activeEvTypes, timeMs, alpha) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setLineDash([5, 8]);
    ctx.lineWidth = 1.5;

    sessions.forEach(s => {
      const events = this._eventsUpTo(s, timeMs).filter(e => e.px != null);
      if (events.length < 2) return;
      const col = s._color || '#ffffff';
      const pts = events.map(e => this.toScreen(e.px, e.py));

      // Draw dashed path
      ctx.strokeStyle = col;
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy));
      ctx.stroke();

      // Draw direction arrows — one per segment, spaced at least 40px apart
      if (this.layers.arrows) {
        ctx.setLineDash([]);
        ctx.save();
        ctx.globalAlpha = alpha * 1.4;
        ctx.fillStyle = col;
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.lineWidth = 0.7;
        let distSinceArrow = 999;
        for (let i = 1; i < pts.length; i++) {
          const ax = pts[i-1].sx, ay = pts[i-1].sy;
          const bx = pts[i].sx,   by = pts[i].sy;
          const segLen = Math.hypot(bx - ax, by - ay);
          distSinceArrow += segLen;
          if (distSinceArrow < 44) continue;
          distSinceArrow = 0;
          // Place arrow at midpoint of segment
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const angle = Math.atan2(by - ay, bx - ax);
          const r = 5;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.moveTo(r,  0);
          ctx.lineTo(-r, -r * 0.6);
          ctx.lineTo(-r,  r * 0.6);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
        ctx.setLineDash([5, 8]);
      }
    });

    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawMarkers(sessions, shownTypes, activeEvTypes, timeMs) {
    sessions.forEach(s => {
      const events = this._eventsUpTo(s, timeMs);
      events.forEach(e => {
        if (!e.px || !e.py) return;
        if (!shownTypes.has(e.ev)) return;
        if (!activeEvTypes.has(e.ev)) return;
        const { sx, sy } = this.toScreen(e.px, e.py);
        const isHov = this.hoverEvent === e;
        drawMarker(this.ctx, sx, sy, e.ev, this.markerScale, isHov);
      });
    });
  }

  // ── Heatmap ────────────────────────────────────────────────────────────────

  /**
   * Build the heatmap canvas.
   * @param {Session[]} sessions
   * @param {'traffic'|'kills'|'deaths'} mode
   */
  buildHeatmap(sessions, mode = 'traffic') {
    const { heatCtx: hx, W, H, heatRadius } = this;
    hx.clearRect(0, 0, W, H);

    const pts = [];
    sessions.forEach(s => {
      s.events.forEach(e => {
        if (!e.px || !e.py) return;
        const cat = EVENT_META[e.ev]?.category;
        if (mode === 'traffic' && (cat === 'move' || cat === 'kill' || cat === 'loot' || cat === 'death')) {
          pts.push({ px: e.px, py: e.py, w: cat === 'kill' ? 5 : 1 });
        } else if (mode === 'kills' && cat === 'kill') {
          pts.push({ px: e.px, py: e.py, w: 6 });
        } else if (mode === 'deaths' && (cat === 'death' || cat === 'storm')) {
          pts.push({ px: e.px, py: e.py, w: 6 });
        }
      });
    });

    if (!pts.length) return;

    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const oc  = off.getContext('2d');
    // Scale radius relative to how large the image is on screen (w/2000 = pixels per world-unit)
    const r   = heatRadius * (this._imgRect.w / 2000) * 10;

    pts.forEach(pt => {
      const { sx, sy } = this.toScreen(pt.px, pt.py);
      if (sx < -r || sy < -r || sx > W + r || sy > H + r) return;
      const g = oc.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, `rgba(255,255,255,${0.12 * pt.w})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      oc.fillStyle = g;
      oc.fillRect(sx - r, sy - r, r * 2, r * 2);
    });

    // Colorize: intensity → mode-specific color ramp
    const colorFn = mode === 'kills'  ? _heatColorKills
                  : mode === 'deaths' ? _heatColorDeaths
                  : _heatColor; // traffic: blue→green→red
    const id = oc.getImageData(0, 0, W, H), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const t = d[i] / 255;
      if (!t) { d[i + 3] = 0; continue; }
      const [r2, g2, b2] = colorFn(Math.min(t, 1));
      d[i] = r2; d[i+1] = g2; d[i+2] = b2;
      d[i+3] = Math.min(255, t * 280);
    }
    hx.putImageData(id, 0, 0);
  }

  // ── Compare render ────────────────────────────────────────────────────────

  renderCompare(sessionsA, sessionsB, activeEvTypes, visibleUids, timeMs = null) {
    // Draw the map image once, then render A normally and B with a ring overlay
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    if (this.mapImage) {
      const iw = this.mapImage.naturalWidth, ih = this.mapImage.naturalHeight;
      const sc = Math.min(W / iw, H / ih);
      const dw = iw * sc * this.cam.zoom, dh = ih * sc * this.cam.zoom;
      const dx = (W - dw) / 2 + this.cam.x, dy = (H - dh) / 2 + this.cam.y;
      this._imgRect = { x: dx, y: dy, w: dw, h: dh };
      ctx.drawImage(this.mapImage, dx, dy, dw, dh);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(dx, dy, dw, dh);
    } else {
      ctx.fillStyle = '#080a0d'; ctx.fillRect(0, 0, W, H);
      this._imgRect = { x: 0, y: 0, w: W, h: H };
      this._drawGrid();
    }

    const shownTypes = new Set();
    if (this.layers.positions) { shownTypes.add('Position'); shownTypes.add('BotPosition'); }
    if (this.layers.kills)     { shownTypes.add('Kill'); shownTypes.add('BotKill'); }
    if (this.layers.loot)      { shownTypes.add('Loot'); }
    if (this.layers.deaths)    { shownTypes.add('Killed'); shownTypes.add('BotKilled'); shownTypes.add('KilledByStorm'); }

    // Match A — normal rendering
    const allA = sessionsA.filter(s => visibleUids.has(s.uid));
    if (this.layers.paths) this._drawPaths(allA, activeEvTypes, timeMs, this.pathAlpha);
    this._drawMarkers(allA, shownTypes, activeEvTypes, timeMs);

    // Match B — dimmed + white ring to distinguish
    const allB = sessionsB.filter(s => visibleUids.has(s.uid));
    if (this.layers.paths) {
      ctx.save(); ctx.globalAlpha = 0.5;
      this._drawPaths(allB, activeEvTypes, timeMs, this.pathAlpha);
      ctx.restore();
    }
    this._drawMarkersB(allB, shownTypes, activeEvTypes, timeMs);

    // Labels on the viewport
    ctx.save();
    ctx.font = 'bold 11px "DM Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText('▲ MATCH A', 12, H - 28);
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText('◈ MATCH B', 12, H - 14);
    ctx.restore();

    if (this.layers.heatmap) {
      ctx.save(); ctx.globalAlpha = this.heatOpacity;
      ctx.drawImage(this.heatCv, 0, 0); ctx.restore();
    }
  }

  // Draw match-B markers with a white ring to distinguish from match A
  _drawMarkersB(sessions, shownTypes, activeEvTypes, timeMs) {
    sessions.forEach(s => {
      const events = this._eventsUpTo(s, timeMs);
      events.forEach(e => {
        if (!e.px || !e.py) return;
        if (!shownTypes.has(e.ev)) return;
        if (!activeEvTypes.has(e.ev)) return;
        const { sx, sy } = this.toScreen(e.px, e.py);
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 0.6;
        // White ring
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        drawMarker(this.ctx, sx, sy, e.ev, this.markerScale * 0.85, false);
      });
    });
  }

  // ── Hit testing ────────────────────────────────────────────────────────────

  hitTest(screenX, screenY, sessions, activeEvTypes) {
    let best = null, bestDist = 14;
    sessions.forEach(s => {
      s.events.forEach(e => {
        if (!e.px || !e.py) return;
        if (!activeEvTypes.has(e.ev)) return;
        const { sx, sy } = this.toScreen(e.px, e.py);
        const d = Math.hypot(screenX - sx, screenY - sy);
        if (d < bestDist) { bestDist = d; best = { event: e, session: s }; }
      });
    });
    return best;
  }
}

// ─── Heatmap color ramps ────────────────────────────────────────────────────

/** Traffic: cool blue → green → hot red */
function _heatColor(t) {
  const stops = [
    [0,    [0,   20,  180]],
    [0.25, [0,   100, 255]],
    [0.5,  [0,   220, 120]],
    [0.75, [255, 220, 0  ]],
    [1.0,  [255, 30,  0  ]],
  ];
  return _lerpStops(stops, t);
}

/** Kills: black → deep red → bright orange → yellow-white */
function _heatColorKills(t) {
  const stops = [
    [0,    [80,  0,   0  ]],
    [0.3,  [200, 0,   0  ]],
    [0.6,  [255, 80,  0  ]],
    [0.85, [255, 200, 0  ]],
    [1.0,  [255, 255, 180]],
  ];
  return _lerpStops(stops, t);
}

/** Deaths: black → deep purple → violet → pink-white */
function _heatColorDeaths(t) {
  const stops = [
    [0,    [30,  0,   60 ]],
    [0.3,  [120, 0,   200]],
    [0.6,  [200, 60,  255]],
    [0.85, [255, 140, 255]],
    [1.0,  [255, 220, 255]],
  ];
  return _lerpStops(stops, t);
}

function _lerpStops(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i+1][0]) {
      const f = (t - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
      return stops[i][1].map((c, j) => Math.round(c + f * (stops[i+1][1][j] - c)));
    }
  }
  return stops[stops.length-1][1];
}
