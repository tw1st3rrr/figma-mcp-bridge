#!/usr/bin/env node
// figma-mcp: stdio MCP server for Claude Code. Talks to Figma Desktop through server/bridge.js + plugin/.
// Never write to stdout here except via the MCP transport; use console.error for logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as G from '../tools/geometry.js';
import { ensureViewBox } from '../tools/svg-viewbox.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055);
const BRIDGE_URL = `ws://127.0.0.1:${PORT}/mcp`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.FIGMA_MCP_OUT || path.join(os.tmpdir(), 'figma-mcp');
const MAX_TEXT = Number(process.env.FIGMA_MCP_MAX_TEXT || 30000);
const log = (...a) => console.error('[figma-mcp]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- bridge client ---------------- */
class BridgeClient {
  constructor(url) { this.url = url; this.ws = null; this.seq = 0; this.pending = new Map(); this.status = { pluginConnected: false }; this.connecting = null; }

  async ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.connecting) this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _connect() {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await this._open(); return; } catch (e) {
        lastErr = e;
        if (attempt === 0) this._spawnBridge();
        await sleep(400 * (attempt + 1));
      }
    }
    throw new Error(`Cannot reach the bridge at ${this.url} (${lastErr && lastErr.message}). Start it manually: node server/bridge.js`);
  }

  _open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const onErr = (e) => reject(e);
      ws.once('error', onErr);
      ws.once('open', () => {
        ws.off('error', onErr);
        this.ws = ws;
        ws.on('message', (d) => this._onMessage(d));
        ws.on('error', () => {});
        ws.on('close', () => {
          this.ws = null;
          this.status = { pluginConnected: false };
          for (const p of this.pending.values()) p.reject(new Error('bridge connection closed'));
          this.pending.clear();
        });
        resolve();
      });
    });
  }

  _spawnBridge() {
    const bridge = path.join(HERE, 'bridge.js');
    log('bridge not running, starting', bridge);
    try {
      const child = spawn(process.execPath, [bridge], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: Object.assign({}, process.env, { FIGMA_BRIDGE_PORT: String(PORT) }),
      });
      child.unref();
    } catch (e) { log('spawn failed', e.message); }
  }

  _onMessage(data) {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'status') {
      this.status = msg;
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id).resolve(msg); this.pending.delete(msg.id); }
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error + (msg.stack ? '\n' + msg.stack : '')));
    }
  }

  async send(cmd, params = {}, timeoutMs = 120000) {
    await this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'cmd', id, cmd, params, timeoutMs }));
    });
  }

  async getStatus() {
    await this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'status', id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('bridge status timeout')); }, 5000);
    });
  }
}
const bridge = new BridgeClient(BRIDGE_URL);
const fig = (cmd, params, timeoutMs) => bridge.send(cmd, params, timeoutMs);

/* ---------------- output helpers ---------------- */
function outFile(name) { fs.mkdirSync(OUT_DIR, { recursive: true }); return path.join(OUT_DIR, name); }
function text(obj) {
  let s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (s.length > MAX_TEXT) {
    const file = outFile('out-' + Date.now() + '.json');
    fs.writeFileSync(file, s);
    s = s.slice(0, MAX_TEXT) + `\n…[truncated ${s.length - MAX_TEXT} chars; full output saved to ${file}]`;
  }
  return { content: [{ type: 'text', text: s }] };
}
function tool(server, name, description, shape, fn) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const res = await fn(args || {});
      return res && res.content ? res : text(res === undefined ? { ok: true } : res);
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + (e && e.message ? e.message : String(e)) }], isError: true };
    }
  });
}


/* ---------------- server ---------------- */
const server = new McpServer(
  { name: 'figma-mcp', version: VERSION },
  {
    instructions: [
      'Local Figma bridge (no monthly limits). Requires Figma Desktop with the dev plugin "Figma MCP Bridge" running in the open file.',
      'Call figma_status first. Node ids look like "12:34". x/y are relative to the parent unless absolute=true.',
      'Vector geometry: figma_get_vector_paths(absolute=true) returns page-space paths; figma_set_vector_paths(absolute=true) accepts them back.',
      'Anything not covered: figma_run_js runs async JS with (figma, params, h) inside the plugin sandbox.',
    ].join('\n'),
  },
);

const S = {
  id: z.string().describe('Figma node id, e.g. "12:34"'),
  ids: z.array(z.string()).min(1).describe('Figma node ids'),
  paint: z.union([z.string(), z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }), z.array(z.any()), z.null()])
    .describe('"#RRGGBB[AA]", "none", {r,g,b} in 0..1, or Figma Paint[]'),
  paths: z.array(z.object({ windingRule: z.enum(['NONZERO', 'EVENODD']).optional(), data: z.string() })).min(1)
    .describe('Figma vectorPaths: [{windingRule, data:"M x y L x y … Z"}]'),
  placement: {
    parentId: z.string().optional().describe('Parent node id (default: current page)'),
    name: z.string().optional(),
    x: z.number().optional(), y: z.number().optional(),
    absolute: z.boolean().optional().describe('Treat x/y as page coordinates'),
    fill: z.union([z.string(), z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }), z.array(z.any()), z.null()]).optional(),
    stroke: z.union([z.string(), z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }), z.array(z.any()), z.null()]).optional(),
    strokeWeight: z.number().optional(),
    opacity: z.number().optional(),
  },
};

/* --- connection / reading --- */
tool(server, 'figma_status', 'Bridge + plugin connection status, open file, current page, selection. Call this first.', {}, async () => {
  let st;
  try { st = await bridge.getStatus(); } catch (e) { return { bridge: 'unreachable', error: e.message, hint: 'node server/bridge.js' }; }
  const out = { bridge: 'ok', port: st.port, pluginConnected: st.pluginConnected, plugin: st.plugin, controllers: st.controllers };
  if (st.pluginConnected) { try { out.ping = await fig('ping', {}, 10000); } catch (e) { out.ping = 'failed: ' + e.message; } }
  else out.hint = 'Figma Desktop → open the file → Plugins → Development → "Figma MCP Bridge" (keep its window open).';
  return out;
});

tool(server, 'figma_get_document', 'File name, pages, current page, selection, viewport.', {}, () => fig('get_document'));

tool(server, 'figma_get_selection', 'Serialize the current selection.', {
  depth: z.number().int().min(0).max(10).optional().describe('Children depth (default 1)'),
  vectors: z.boolean().optional().describe('Include vectorPaths for VECTOR nodes'),
}, (a) => fig('get_selection', a));

tool(server, 'figma_get_node', 'Serialize one node (with children up to depth).', {
  id: S.id,
  depth: z.number().int().min(0).max(10).optional(),
  vectors: z.boolean().optional(),
  compact: z.boolean().optional().describe('Skip fills/strokes/text details'),
  maxChildren: z.number().int().optional(),
}, (a) => fig('get_node', a));

tool(server, 'figma_get_page_tree', 'Compact layer tree of a page.', {
  pageId: z.string().optional(), depth: z.number().int().min(0).max(20).optional().describe('default 2'),
}, (a) => fig('get_page_tree', a));

tool(server, 'figma_find_nodes', 'Find nodes by exact name / substring / regex / type under a root (default: current page).', {
  name: z.string().optional(), nameContains: z.string().optional(), nameRegex: z.string().optional(), flags: z.string().optional(),
  type: z.union([z.string(), z.array(z.string())]).optional().describe('e.g. "VECTOR" or ["FRAME","GROUP"]'),
  rootId: z.string().optional().describe('Search root; a page id, a node id, or the document id "0:0"'),
  limit: z.number().int().optional(), full: z.boolean().optional().describe('Return full serialization instead of compact'),
}, (a) => fig('find_nodes', a));

/* --- editing --- */
tool(server, 'figma_set_props', 'Set properties on a node: name, x, y, width, height, absoluteX, absoluteY, visible, locked, opacity, fills, strokes, strokeWeight, cornerRadius, rotation, characters, fontSize, fontName, textAlignHorizontal, parentId, … (any writable Plugin API property).', {
  id: S.id, props: z.record(z.any()),
}, (a) => fig('set_props', a));

tool(server, 'figma_translate', 'Move nodes by dx/dy.', { ids: S.ids, dx: z.number().optional(), dy: z.number().optional() }, (a) => fig('translate', a));

tool(server, 'figma_delete', 'Delete nodes by id.', { ids: S.ids }, (a) => fig('delete_nodes', a));

tool(server, 'figma_create_rectangle', 'Create a rectangle.', Object.assign({ width: z.number(), height: z.number(), cornerRadius: z.number().optional() }, S.placement), (a) => fig('create_rectangle', a));

tool(server, 'figma_create_frame', 'Create a frame (transparent by default).', Object.assign({ width: z.number(), height: z.number(), clipsContent: z.boolean().optional() }, S.placement), (a) => fig('create_frame', a));

tool(server, 'figma_create_text', 'Create a text node (font must exist in Figma; default Inter Regular).', Object.assign({
  characters: z.string(), fontFamily: z.string().optional(), fontStyle: z.string().optional(), fontSize: z.number().optional(),
  textAlignHorizontal: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']).optional(), width: z.number().optional().describe('Fixed width, auto height'),
}, S.placement), (a) => fig('create_text', a));

tool(server, 'figma_create_vector', 'Create a vector from path data. absolute=true → path coordinates are page coordinates.', Object.assign({ paths: S.paths }, S.placement), (a) => fig('create_vector', a));

tool(server, 'figma_import_svg', 'Import an SVG (string or file path) as a frame; layer names come from SVG id attributes.', Object.assign({
  svg: z.string().optional().describe('SVG markup'), file: z.string().optional().describe('Path to an .svg file'),
  fixViewBox: z.boolean().optional().describe('Add viewBox/width/height when missing (default true)'),
  depth: z.number().int().optional().describe('Children depth in the returned tree (default 1)'),
}, S.placement), async (a) => {
  let svg = a.svg;
  if (!svg && a.file) svg = fs.readFileSync(a.file, 'utf8');
  if (!svg) throw new Error('Provide svg or file');
  if (a.fixViewBox !== false) svg = ensureViewBox(svg).svg;
  const params = Object.assign({}, a, { svg, file: undefined, name: a.name || (a.file ? path.basename(a.file) : 'Imported SVG') });
  return fig('import_svg', params, 300000);
});

tool(server, 'figma_get_vector_paths', 'Read vectorPaths of a VECTOR (or RECTANGLE) node, optionally converted to page coordinates.', {
  id: S.id, absolute: z.boolean().optional().describe('Also return absolutePaths in page space'),
}, async (a) => {
  const vp = await fig('get_vector_paths', { id: a.id });
  if (a.absolute) vp.absolutePaths = G.vectorPathsToAbsolute(vp.vectorPaths, vp.absoluteTransform);
  return vp;
});

tool(server, 'figma_set_vector_paths', 'Replace vectorPaths of a node (RECTANGLE etc. are flattened to a VECTOR first). absolute=true → data is in page coordinates.', {
  id: S.id, paths: S.paths, absolute: z.boolean().optional(),
}, (a) => fig('set_vector_paths', a));

tool(server, 'figma_boolean', 'Boolean operation on nodes (union/subtract/intersect/exclude); flatten=true returns a plain VECTOR.', {
  op: z.enum(['union', 'subtract', 'intersect', 'exclude']), ids: S.ids, flatten: z.boolean().optional(), name: z.string().optional(), parentId: z.string().optional(),
}, (a) => fig('boolean_op', a));

tool(server, 'figma_flatten', 'Flatten nodes into one VECTOR.', { ids: S.ids, name: z.string().optional(), parentId: z.string().optional() }, (a) => fig('flatten', a));
tool(server, 'figma_group', 'Group nodes.', { ids: S.ids, name: z.string().optional(), parentId: z.string().optional() }, (a) => fig('group', a));
tool(server, 'figma_ungroup', 'Ungroup a group/frame.', { id: S.id }, (a) => fig('ungroup', a));

tool(server, 'figma_export', 'Export a node to PNG/JPG/SVG/PDF. Saves a file (outPath or temp dir); PNG/JPG also returned as an image.', {
  id: S.id, format: z.enum(['PNG', 'JPG', 'SVG', 'PDF']).optional(), scale: z.number().optional().describe('PNG/JPG scale, default 1'),
  outPath: z.string().optional(), svgIdAttribute: z.boolean().optional().describe('Keep layer names as id attributes (default true)'),
  inline: z.boolean().optional().describe('SVG only: also return the first 20 KB of markup in the response (default false, the file is always written)'),
}, async (a) => {
  const res = await fig('export_node', a, 300000);
  const ext = res.format.toLowerCase();
  const file = a.outPath || outFile(`${res.name.replace(/[^\w.-]+/g, '_')}-${res.id.replace(':', '_')}.${ext}`);
  const buf = Buffer.from(res.base64, 'base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  const content = [{ type: 'text', text: JSON.stringify({ id: res.id, name: res.name, format: res.format, bytes: res.bytes, file }) }];
  if (res.format === 'PNG' || res.format === 'JPG') content.push({ type: 'image', data: res.base64, mimeType: res.format === 'PNG' ? 'image/png' : 'image/jpeg' });
  // Map SVGs run to 100+ KB: returning them inline overflows the client's tool-output limit. Opt in, capped.
  else if (res.format === 'SVG' && a.inline) content.push({ type: 'text', text: buf.toString('utf8').slice(0, 20000) });
  return { content };
});

tool(server, 'figma_set_page', 'Switch the current page.', { pageId: z.string() }, (a) => fig('set_current_page', a));
tool(server, 'figma_select', 'Select nodes and (by default) zoom the viewport to them.', { ids: z.array(z.string()), zoom: z.boolean().optional() }, (a) => fig('set_selection', a));
tool(server, 'figma_notify', 'Show a toast in Figma.', { message: z.string(), timeout: z.number().optional() }, (a) => fig('notify', a));

tool(server, 'figma_run_js', 'Run async JavaScript inside the plugin sandbox. Scope: figma (Plugin API), params, h (helpers: serialize(node,depth), byId(id), byIds(ids), parsePaints(v), loadFonts(textNode), place(node,{parentId,x,y,absolute,…})). Return a JSON-able value or a node.', {
  code: z.string().describe('Function body, may use await and return'), params: z.record(z.any()).optional(), timeoutMs: z.number().optional(),
}, (a) => fig('run_js', { code: a.code, params: a.params }, a.timeoutMs || 300000));

/* --- REST API (read-only, needs FIGMA_TOKEN) --- */
async function rest(url) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error('FIGMA_TOKEN env var is not set (Figma → Settings → Security → Personal access tokens)');
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) throw new Error(`Figma REST ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
tool(server, 'figma_rest_file', 'REST: read a file/nodes as JSON without the plugin (rate-limited, no monthly cap). fileKey is the part after /design/ in the URL.', {
  fileKey: z.string(), ids: z.array(z.string()).optional(), depth: z.number().int().optional(), geometry: z.boolean().optional().describe('Include vector paths'),
}, (a) => {
  const q = new URLSearchParams();
  if (a.depth) q.set('depth', String(a.depth));
  if (a.geometry) q.set('geometry', 'paths');
  if (a.ids && a.ids.length) { q.set('ids', a.ids.join(',')); return rest(`https://api.figma.com/v1/files/${a.fileKey}/nodes?${q}`); }
  return rest(`https://api.figma.com/v1/files/${a.fileKey}?${q}`);
});
tool(server, 'figma_rest_images', 'REST: render nodes to image URLs.', {
  fileKey: z.string(), ids: z.array(z.string()).min(1), format: z.enum(['png', 'jpg', 'svg', 'pdf']).optional(), scale: z.number().optional(),
}, (a) => rest(`https://api.figma.com/v1/images/${a.fileKey}?ids=${encodeURIComponent(a.ids.join(','))}&format=${a.format || 'png'}&scale=${a.scale || 1}`));

/* ---------------- start ---------------- */
const transport = new StdioServerTransport();
await server.connect(transport);
log(`figma-mcp ${VERSION} ready (bridge ${BRIDGE_URL})`);
bridge.ensure().catch((e) => log(e.message));
