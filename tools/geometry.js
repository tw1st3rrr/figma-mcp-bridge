// Shared 2D geometry for mall maps: SVG path parsing, polygon ops, Figma vectorPaths helpers.
// Pure ESM, no DOM. Used by tools/svg-mall.js and server/index.js.
import polygonClipping from 'polygon-clipping';

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;

/** Round to 3 decimals, strip -0. */
export const r3 = (v) => {
  const x = Math.round(v * 1000) / 1000;
  return Object.is(x, -0) ? 0 : x;
};

/**
 * Parse an SVG path `d` into absolute commands: {c:'M'|'L'|'C'|'Q'|'Z', p:[x,y,...]}.
 * Supports M L H V C S Q T Z (abs + rel). Arcs (A) degrade to a straight line to the endpoint.
 */
export function parsePath(d) {
  const tokens = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(d))) tokens.push(m[1] ? m[1] : parseFloat(m[2]));
  const out = [];
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, lastC = null, lastQ = null;
  const next = () => tokens[i++];
  const peekNum = () => typeof tokens[i] === 'number';
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t; i++;
      if (cmd === 'Z' || cmd === 'z') { out.push({ c: 'Z', p: [] }); cx = sx; cy = sy; lastC = lastQ = null; continue; }
    } else if (cmd === null) throw new Error('Path must start with a command');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (!peekNum()) { if (C === 'Z') continue; throw new Error('Bad path near token ' + i); }
    switch (C) {
      case 'M': { let x = next(), y = next(); if (rel) { x += cx; y += cy; } out.push({ c: 'M', p: [x, y] }); cx = sx = x; cy = sy = y; cmd = rel ? 'l' : 'L'; lastC = lastQ = null; break; }
      case 'L': { let x = next(), y = next(); if (rel) { x += cx; y += cy; } out.push({ c: 'L', p: [x, y] }); cx = x; cy = y; lastC = lastQ = null; break; }
      case 'H': { let x = next(); if (rel) x += cx; out.push({ c: 'L', p: [x, cy] }); cx = x; lastC = lastQ = null; break; }
      case 'V': { let y = next(); if (rel) y += cy; out.push({ c: 'L', p: [cx, y] }); cy = y; lastC = lastQ = null; break; }
      case 'C': {
        let x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] }); lastC = [x2, y2]; lastQ = null; cx = x; cy = y; break;
      }
      case 'S': {
        let x2 = next(), y2 = next(), x = next(), y = next();
        if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
        const x1 = lastC ? 2 * cx - lastC[0] : cx, y1 = lastC ? 2 * cy - lastC[1] : cy;
        out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] }); lastC = [x2, y2]; lastQ = null; cx = x; cy = y; break;
      }
      case 'Q': {
        let x1 = next(), y1 = next(), x = next(), y = next();
        if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
        out.push({ c: 'Q', p: [x1, y1, x, y] }); lastQ = [x1, y1]; lastC = null; cx = x; cy = y; break;
      }
      case 'T': {
        let x = next(), y = next();
        if (rel) { x += cx; y += cy; }
        const x1 = lastQ ? 2 * cx - lastQ[0] : cx, y1 = lastQ ? 2 * cy - lastQ[1] : cy;
        out.push({ c: 'Q', p: [x1, y1, x, y] }); lastQ = [x1, y1]; lastC = null; cx = x; cy = y; break;
      }
      case 'A': {
        next(); next(); next(); next(); next();
        let x = next(), y = next();
        if (rel) { x += cx; y += cy; }
        out.push({ c: 'L', p: [x, y] }); cx = x; cy = y; lastC = lastQ = null; break;
      }
      default: throw new Error('Unsupported path command ' + cmd);
    }
  }
  return out;
}

/** Serialize absolute commands back to a `d` string (Figma-compatible: "M x y L x y C ... Z"). */
export function serializePath(cmds) {
  return cmds.map((k) => (k.c === 'Z' ? 'Z' : k.c + ' ' + k.p.map(r3).join(' '))).join(' ');
}

/** Apply a 2x3 affine matrix [[a,c,tx],[b,d,ty]] to every coordinate pair. */
export function transformCommands(cmds, m) {
  const [[a, c, tx], [b, d, ty]] = m;
  return cmds.map((k) => {
    const p = [];
    for (let i = 0; i < k.p.length; i += 2) {
      const x = k.p[i], y = k.p[i + 1];
      p.push(a * x + c * y + tx, b * x + d * y + ty);
    }
    return { c: k.c, p };
  });
}

export function translateCommands(cmds, dx, dy) {
  return transformCommands(cmds, [[1, 0, dx], [0, 1, dy]]);
}

/** Bounding box over all coordinates (on-curve and control points). */
export function bboxOfCommands(cmds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of cmds) {
    for (let i = 0; i < k.p.length; i += 2) {
      const x = k.p[i], y = k.p[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, maxX, maxY };
}

export function bboxOfPath(d) { return bboxOfCommands(parsePath(d)); }

/** Flatten commands into closed rings [[x,y],...]. Curves sampled with `steps` segments. */
export function commandsToRings(cmds, steps = 8) {
  const rings = [];
  let ring = null, cx = 0, cy = 0;
  const push = (x, y) => { if (!ring) ring = []; ring.push([x, y]); cx = x; cy = y; };
  const close = () => { if (ring && ring.length >= 3) rings.push(ring); ring = null; };
  for (const k of cmds) {
    if (k.c === 'M') { close(); push(k.p[0], k.p[1]); }
    else if (k.c === 'L') push(k.p[0], k.p[1]);
    else if (k.c === 'C') {
      const [x1, y1, x2, y2, x, y] = k.p, x0 = cx, y0 = cy;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        push(u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x, u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y);
      }
    } else if (k.c === 'Q') {
      const [x1, y1, x, y] = k.p, x0 = cx, y0 = cy;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        push(u*u*x0 + 2*u*t*x1 + t*t*x, u*u*y0 + 2*u*t*y1 + t*t*y);
      }
    } else if (k.c === 'Z') close();
  }
  close();
  return rings.map((rg) => dedupeRing(rg));
}

export function pathToRings(d, steps = 8) { return commandsToRings(parsePath(d), steps); }

function dedupeRing(ring, eps = 1e-6) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

/** Remove collinear vertices (eps = max perpendicular distance in px). */
export function simplifyRing(ring, eps = 0.05) {
  ring = dedupeRing(ring);
  if (ring.length < 4) return ring;
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const dx = c[0] - a[0], dy = c[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const dist = Math.abs(dx * (a[1] - b[1]) - dy * (a[0] - b[0])) / len;
      const dot = ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / (len * len);
      if (dist <= eps && dot >= -1e-9 && dot <= 1 + 1e-9) { ring.splice(i, 1); changed = true; break; }
    }
  }
  return ring;
}

export function ringsToPath(rings) {
  return rings.map((rg) => 'M ' + rg.map((p) => r3(p[0]) + ' ' + r3(p[1])).join(' L ') + ' Z').join(' ');
}

/** polygon-clipping multipolygon -> flat list of rings (outer rings + holes). */
function multiToRings(multi) {
  const rings = [];
  for (const poly of multi) for (const ring of poly) rings.push(dedupeRing(ring.map((p) => [p[0], p[1]])));
  return rings;
}

const toPoly = (rings) => rings.map((rg) => [rg]);

export function unionRings(aRings, bRings) {
  const multi = polygonClipping.union(toPoly(aRings), toPoly(bRings));
  return multiToRings(multi).map((rg) => simplifyRing(rg));
}

export function intersectRings(aRings, bRings) {
  const multi = polygonClipping.intersection(toPoly(aRings), toPoly(bRings));
  return multiToRings(multi).map((rg) => simplifyRing(rg));
}

export function differenceRings(aRings, bRings) {
  const multi = polygonClipping.difference(toPoly(aRings), toPoly(bRings));
  return multiToRings(multi).map((rg) => simplifyRing(rg));
}

/**
 * Snap every vertex coordinate of `src` rings to the nearest x / y coordinate present in `dst` rings
 * when within `tol`. This closes the thin wall gap between adjacent tenants before a union.
 */
export function snapRingsTo(srcRings, dstRings, tol = 4) {
  const xs = new Set(), ys = new Set();
  for (const rg of dstRings) for (const p of rg) { xs.add(p[0]); ys.add(p[1]); }
  const snap = (v, set) => {
    let best = v, bd = tol + 1e-9;
    for (const s of set) { const d = Math.abs(s - v); if (d < bd) { bd = d; best = s; } }
    return best;
  };
  return srcRings.map((rg) => rg.map((p) => [snap(p[0], xs), snap(p[1], ys)]));
}

/**
 * Merge tenant `src` (rings) into neighbour `dst` (rings): snap src to dst's coordinate grid, union, simplify.
 * Returns {rings, d}.
 */
export function mergeShapes(srcRings, dstRings, { tol = 4 } = {}) {
  const snapped = snapRingsTo(srcRings, dstRings, tol);
  const rings = unionRings(dstRings, snapped);
  return { rings, d: ringsToPath(rings) };
}

export function pointInRings(rings, x, y) {
  let inside = false;
  for (const rg of rings) {
    for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) {
      const xi = rg[i][0], yi = rg[i][1], xj = rg[j][0], yj = rg[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function bboxOfRings(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rg of rings) for (const [x, y] of rg) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, maxX, maxY };
}

/** Convert Figma vectorPaths (node-local coords) to absolute page coords using node.absoluteTransform. */
export function vectorPathsToAbsolute(vectorPaths, absoluteTransform) {
  return vectorPaths.map((vp) => ({
    windingRule: vp.windingRule,
    data: serializePath(transformCommands(parsePath(vp.data), absoluteTransform)),
  }));
}
