// Add viewBox/width/height to an SVG that lacks them (clean import into Figma).
import * as G from './geometry.js';

export function ensureViewBox(svg) {
  const open = /<svg\b[^>]*>/.exec(svg);
  if (!open) throw new Error('Not an SVG');
  if (/\sviewBox=/.test(open[0])) return { svg, changed: false };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, m;
  const dRe = /\sd="([^"]*)"/g;
  while ((m = dRe.exec(svg))) {
    try {
      const bb = G.bboxOfPath(m[1]);
      if (!bb) continue;
      if (bb.x < minX) minX = bb.x;
      if (bb.y < minY) minY = bb.y;
      if (bb.maxX > maxX) maxX = bb.maxX;
      if (bb.maxY > maxY) maxY = bb.maxY;
    } catch { /* skip unparsable */ }
  }
  if (minX === Infinity) return { svg, changed: false };
  const x = Math.floor(Math.min(0, minX)), y = Math.floor(Math.min(0, minY));
  const w = Math.ceil(maxX - x), h = Math.ceil(maxY - y);
  const tag = open[0].replace(/^<svg\b/, `<svg viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}"`);
  return { svg: svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length), changed: true, viewBox: [x, y, w, h] };
}
