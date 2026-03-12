/**
 * ODB++ Layer Differ — browser-side comparison engine.
 * Requires JSZip to be loaded before this script.
 *
 * Public API:
 *   ODBDiff.compareArchives(fileA, fileB, onProgress?)
 *     → Promise<{ refName, revName, layers: [{ name, svg }] }>
 *
 * onProgress(msg) is called with human-readable status strings while working.
 */
(function (global) {
  'use strict';

  // ODB++ symbol sizes are in "micrometers-ish"; coordinates are already mm.
  const UNITS_SCALE = 0.001;

  // ── Symbol definition parser ──────────────────────────────────────────────
  //
  // Examples:
  //   'r149.9997'                    → { kind:'circle', d:0.15 }
  //   'rect299.9994x1399.99974xr75'  → { kind:'rect', w:0.3, h:1.4, r:0.075 }
  //   'oval1799.99894x1100.00034'    → { kind:'oval', w:1.8, h:1.1, r:0.55 }

  function parseSymbolDef(defstr) {
    const s = defstr.trim();

    if (s.startsWith('r')) {
      const d = parseFloat(s.slice(1)) * UNITS_SCALE;
      return isNaN(d) ? { kind: 'unknown', raw: s } : { kind: 'circle', d };
    }

    if (s.startsWith('rect')) {
      try {
        const rest = s.slice(4);                    // "WxH" or "WxHxrR"
        const [whPart, rPart] = rest.split('xr');   // split on 'xr' for corner radius
        const [wStr, hStr] = whPart.split('x');
        const w = parseFloat(wStr) * UNITS_SCALE;
        const h = parseFloat(hStr) * UNITS_SCALE;
        const r = rPart !== undefined ? parseFloat(rPart) * UNITS_SCALE : 0;
        return { kind: 'rect', w, h, r };
      } catch (e) {
        return { kind: 'unknown', raw: s };
      }
    }

    if (s.startsWith('oval')) {
      try {
        const [wStr, hStr] = s.slice(4).split('x');
        const w = parseFloat(wStr) * UNITS_SCALE;
        const h = parseFloat(hStr) * UNITS_SCALE;
        return { kind: 'oval', w, h, r: Math.min(w, h) / 2 };
      } catch (e) {
        return { kind: 'unknown', raw: s };
      }
    }

    return { kind: 'unknown', raw: s };
  }

  // ── Features file parser ──────────────────────────────────────────────────
  //
  // Line types handled:
  //   $<idx> <def>          symbol definition
  //   P x y sym ...         flash (pad)
  //   L x1 y1 x2 y2 sym ... line
  //   S ... OB x y / OS x y / OE / SE   surface polygon (even-odd)
  //
  // Arc ('A') tokens are intentionally skipped (matches Python behaviour).

  const SYM_RE = /^\$(\d+)\s+(\S+)/;

  function parseFeaturesText(text) {
    const symbols = {};
    const shapes  = [];

    let inLayerFeatures  = false;
    let inSurface        = false;
    let currentSurfacePaths = [];
    let currentPath      = null;

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      // Section marker — everything before this is symbol defs, not features
      if (line.startsWith('#Layer features')) {
        inLayerFeatures = true;
        continue;
      }

      // Symbol definition  $idx defstr
      const symMatch = SYM_RE.exec(line);
      if (symMatch) {
        symbols[parseInt(symMatch[1], 10)] = parseSymbolDef(symMatch[2]);
        continue;
      }

      if (!inLayerFeatures) continue;

      // ── Surface block ────────────────────────────────────────────────────
      if (line.startsWith('S ')) {
        inSurface = true;
        currentSurfacePaths = [];
        currentPath = null;
        continue;
      }

      if (inSurface) {
        if (line.startsWith('OB ')) {           // begin contour
          const p = line.split(/\s+/);
          if (p.length >= 3) {
            currentPath = [[parseFloat(p[1]), parseFloat(p[2])]];
            currentSurfacePaths.push(currentPath);
          }
          continue;
        }
        if (line.startsWith('OS ')) {           // segment
          const p = line.split(/\s+/);
          if (p.length >= 3 && currentPath) {
            currentPath.push([parseFloat(p[1]), parseFloat(p[2])]);
          }
          continue;
        }
        if (line.startsWith('OE')) {            // end contour
          currentPath = null;
          continue;
        }
        if (line.startsWith('SE')) {            // end surface
          if (currentSurfacePaths.length) {
            shapes.push({ type: 'surface', paths: currentSurfacePaths });
          }
          inSurface = false;
          currentSurfacePaths = [];
          currentPath = null;
          continue;
        }
        continue; // ignore other tokens inside a surface block
      }

      // ── Line ─────────────────────────────────────────────────────────────
      if (line.startsWith('L ')) {
        const p = line.split(/\s+/);
        if (p.length >= 6) {
          shapes.push({
            type: 'line',
            x1: parseFloat(p[1]), y1: parseFloat(p[2]),
            x2: parseFloat(p[3]), y2: parseFloat(p[4]),
            sym: parseInt(p[5], 10),
          });
        }
        continue;
      }

      // ── Flash (pad) ───────────────────────────────────────────────────────
      if (line.startsWith('P ')) {
        const p = line.split(/\s+/);
        if (p.length >= 4) {
          shapes.push({
            type: 'flash',
            x: parseFloat(p[1]), y: parseFloat(p[2]),
            sym: parseInt(p[3], 10),
          });
        }
        continue;
      }
    }

    return { symbols, shapes };
  }

  // ── Bounding box ──────────────────────────────────────────────────────────
  // Returns [minx, miny, maxx, maxy] in mm.

  function shapeBbox(shape, symbols) {
    if (shape.type === 'line') {
      const sd = symbols[shape.sym] || { kind: 'circle', d: 0 };
      let w = 0;
      if (sd.kind === 'circle') w = sd.d || 0;
      else if (sd.kind === 'rect' || sd.kind === 'oval') w = Math.max(sd.w || 0, sd.h || 0);
      const hw = w / 2;
      return [
        Math.min(shape.x1, shape.x2) - hw, Math.min(shape.y1, shape.y2) - hw,
        Math.max(shape.x1, shape.x2) + hw, Math.max(shape.y1, shape.y2) + hw,
      ];
    }

    if (shape.type === 'flash') {
      const sd = symbols[shape.sym] || { kind: 'circle', d: 0 };
      const { x: cx, y: cy } = shape;
      if (sd.kind === 'circle') {
        const r = (sd.d || 0) / 2;
        return [cx - r, cy - r, cx + r, cy + r];
      }
      if (sd.kind === 'rect' || sd.kind === 'oval') {
        const hw = (sd.w || 0) / 2, hh = (sd.h || 0) / 2;
        return [cx - hw, cy - hh, cx + hw, cy + hh];
      }
      return [cx, cy, cx, cy]; // unknown — zero-size
    }

    if (shape.type === 'surface') {
      const xs = shape.paths.flatMap(p => p.map(pt => pt[0]));
      const ys = shape.paths.flatMap(p => p.map(pt => pt[1]));
      if (!xs.length) return [0, 0, 0, 0];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    return [0, 0, 0, 0];
  }

  // ── SVG rendering ─────────────────────────────────────────────────────────

  function renderGroup(shapes, symbols, color, alpha, scale, minx, miny) {
    const p = [`<g fill="${color}" fill-opacity="${alpha}" stroke="${color}" stroke-opacity="${alpha}">`];

    for (const sh of shapes) {

      if (sh.type === 'line') {
        const sd = symbols[sh.sym];
        if (!sd) continue;
        let wmm = 0;
        if (sd.kind === 'circle') wmm = sd.d || 0;
        else if (sd.kind === 'rect' || sd.kind === 'oval') wmm = Math.max(sd.w || 0, sd.h || 0);
        const x1 = (sh.x1 - minx) * scale, y1 = (sh.y1 - miny) * scale;
        const x2 = (sh.x2 - minx) * scale, y2 = (sh.y2 - miny) * scale;
        p.push(`<line x1="${x1.toFixed(3)}" y1="${y1.toFixed(3)}" x2="${x2.toFixed(3)}" y2="${y2.toFixed(3)}" stroke-width="${(wmm * scale).toFixed(3)}" stroke-linecap="round" fill="none" />`);

      } else if (sh.type === 'flash') {
        const sd = symbols[sh.sym];
        if (!sd) continue;
        const cx = (sh.x - minx) * scale, cy = (sh.y - miny) * scale;
        if (sd.kind === 'circle') {
          const r = ((sd.d || 0) / 2) * scale;
          p.push(`<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${r.toFixed(3)}" />`);
        } else if (sd.kind === 'rect' || sd.kind === 'oval') {
          const w = (sd.w || 0) * scale, h = (sd.h || 0) * scale;
          let rx = (sd.r || 0) * scale;
          if (sd.kind === 'oval' && rx === 0) rx = Math.min(w, h) / 2;
          p.push(`<rect x="${(cx - w / 2).toFixed(3)}" y="${(cy - h / 2).toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" rx="${rx.toFixed(3)}" ry="${rx.toFixed(3)}" />`);
        } else {
          p.push(`<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="1.000" />`); // unknown — small dot
        }

      } else if (sh.type === 'surface') {
        const dparts = [];
        for (const path of sh.paths) {
          if (!path.length) continue;
          const segs = [`M ${((path[0][0] - minx) * scale).toFixed(3)} ${((path[0][1] - miny) * scale).toFixed(3)}`];
          for (const [x, y] of path.slice(1)) {
            segs.push(`L ${((x - minx) * scale).toFixed(3)} ${((y - miny) * scale).toFixed(3)}`);
          }
          segs.push('Z');
          dparts.push(segs.join(' '));
        }
        if (dparts.length) {
          p.push(`<path d="${dparts.join(' ')}" fill-rule="evenodd" stroke="none" />`);
        }
      }
    }

    p.push('</g>');
    return p.join('\n');
  }

  function svgEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function generateLayerSvg(layer, featsA, featsB, bounds) {
    const { symbols: symA, shapes: shapesA } = featsA;
    const { symbols: symB, shapes: shapesB } = featsB;

    let minx, miny, maxx, maxy;

    if (bounds) {
      [minx, miny, maxx, maxy] = bounds;
    } else {
      minx = Infinity; miny = Infinity; maxx = -Infinity; maxy = -Infinity;
      for (const sh of shapesA) {
        const b = shapeBbox(sh, symA);
        minx = Math.min(minx, b[0]); miny = Math.min(miny, b[1]);
        maxx = Math.max(maxx, b[2]); maxy = Math.max(maxy, b[3]);
      }
      for (const sh of shapesB) {
        const b = shapeBbox(sh, symB);
        minx = Math.min(minx, b[0]); miny = Math.min(miny, b[1]);
        maxx = Math.max(maxx, b[2]); maxy = Math.max(maxy, b[3]);
      }
      if (!(minx < maxx && miny < maxy)) { minx = 0; miny = 0; maxx = 10; maxy = 10; }
      minx -= 2; miny -= 2; maxx += 2; maxy += 2;
    }

    const wMm = maxx - minx, hMm = maxy - miny;
    const sc  = 2000 / Math.max(wMm, hMm);   // aim for ~2000 px on the longer axis
    const wPx = Math.round(wMm * sc), hPx = Math.round(hMm * sc);

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${wPx}" height="${hPx}" viewBox="0 0 ${wPx} ${hPx}">`,
      '<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>',
      // Flip Y so the ODB++ coordinate system (Y-up) maps correctly to SVG (Y-down)
      `<g transform="scale(1,-1) translate(0,-${hPx})">`,
      renderGroup(shapesA, symA, '#00cc66', 0.5, sc, minx, miny),  // reference: green
      renderGroup(shapesB, symB, '#cc00cc', 0.5, sc, minx, miny),  // revised:   magenta
      '</g>',
      // Legend (not flipped)
      '<g font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#000" stroke="none">',
      `<text x="10" y="24">Layer: ${svgEscape(layer)}</text>`,
      '<rect x="10"  y="34" width="24" height="12" fill="#00cc66" fill-opacity="0.5" stroke="#00cc66" stroke-opacity="0.5"/>',
      '<text x="40"  y="44">A only</text>',
      '<rect x="120" y="34" width="24" height="12" fill="#cc00cc" fill-opacity="0.5" stroke="#cc00cc" stroke-opacity="0.5"/>',
      '<text x="150" y="44">B only</text>',
      '<text x="10"  y="66">Overlap appears as blended color</text>',
      '</g>',
      '</svg>',
    ].join('\n');
  }

  // ── Archive traversal ─────────────────────────────────────────────────────

  // Locate every 'features' file whose path matches the ODB++ layer hierarchy:
  //   .../odb/steps/pcb/layers/<layerName>/features
  // The leading path before 'odb/' is ignored to handle varied archive structures.

  function findLayerFiles(zip) {
    const layers = {};
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      const m = relPath.match(/(?:^|\/)odb\/steps\/pcb\/layers\/([^\/]+)\/features$/i);
      if (m) layers[m[1]] = entry;
    });
    return layers;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function compareArchives(fileA, fileB, onProgress) {
    const report = msg => { if (onProgress) onProgress(msg); };

    report('Loading archives\u2026');
    const [zipA, zipB] = await Promise.all([
      JSZip.loadAsync(fileA),
      JSZip.loadAsync(fileB),
    ]);

    const layerFilesA = findLayerFiles(zipA);
    const layerFilesB = findLayerFiles(zipB);
    const common = Object.keys(layerFilesA).filter(n => n in layerFilesB).sort();

    if (common.length === 0) {
      return { refName: fileA.name, revName: fileB.name, layers: [] };
    }

    // Pass 1 — parse all layers and accumulate a global bounding box so that
    // every per-layer SVG uses the same coordinate origin.  This is required
    // for correct spatial alignment when multiple layers are composited in the
    // viewer (same behaviour as compare_archives() in compare_odb_layers.py).

    const allFeats = {};
    let gMinx = Infinity, gMiny = Infinity, gMaxx = -Infinity, gMaxy = -Infinity;

    for (const name of common) {
      report(`Parsing ${name}\u2026`);
      await new Promise(r => setTimeout(r, 0)); // yield to keep UI responsive

      const [textA, textB] = await Promise.all([
        layerFilesA[name].async('text'),
        layerFilesB[name].async('text'),
      ]);

      const featsA = parseFeaturesText(textA);
      const featsB = parseFeaturesText(textB);
      allFeats[name] = { featsA, featsB };

      for (const sh of featsA.shapes) {
        const b = shapeBbox(sh, featsA.symbols);
        gMinx = Math.min(gMinx, b[0]); gMiny = Math.min(gMiny, b[1]);
        gMaxx = Math.max(gMaxx, b[2]); gMaxy = Math.max(gMaxy, b[3]);
      }
      for (const sh of featsB.shapes) {
        const b = shapeBbox(sh, featsB.symbols);
        gMinx = Math.min(gMinx, b[0]); gMiny = Math.min(gMiny, b[1]);
        gMaxx = Math.max(gMaxx, b[2]); gMaxy = Math.max(gMaxy, b[3]);
      }
    }

    const globalBounds = (gMinx < gMaxx && gMiny < gMaxy)
      ? [gMinx - 2, gMiny - 2, gMaxx + 2, gMaxy + 2]
      : null;

    // Pass 2 — generate SVGs using the shared bounding box.

    const layers = [];
    for (const name of common) {
      report(`Rendering ${name}\u2026`);
      await new Promise(r => setTimeout(r, 0));

      const { featsA, featsB } = allFeats[name];
      layers.push({ name, svg: generateLayerSvg(name, featsA, featsB, globalBounds) });
    }

    return { refName: fileA.name, revName: fileB.name, layers };
  }

  global.ODBDiff = { compareArchives };

}(window));
