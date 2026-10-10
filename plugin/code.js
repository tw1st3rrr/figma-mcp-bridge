// Figma MCP Bridge — plugin main thread.
// Receives {type:'cmd', id, cmd, params} from ui.html (WebSocket relay), executes on the Plugin API,
// replies {type:'result', id, ok, result|error}. Plain ES2017: no optional chaining / spread-in-objects.
var VERSION = '0.1.0';

figma.showUI(__html__, { width: 360, height: 170, title: 'Figma MCP Bridge' });

/* ---------------- helpers ---------------- */
var r3 = function (v) { return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v; };

function hexToRgb(hex) {
  var h = String(hex).replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
  var n = parseInt(h.slice(0, 6), 16);
  var out = { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  if (h.length === 8) out.a = parseInt(h.slice(6, 8), 16) / 255;
  return out;
}
function rgbToHex(c) {
  var h = function (v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + h(c.r) + h(c.g) + h(c.b);
}
/** Accepts '#RRGGBB[AA]', 'none', {r,g,b[,a]} (0..1), or a full Paint / Paint[]. */
function parsePaints(v) {
  if (v == null || v === 'none' || v === '') return [];
  if (Array.isArray(v)) return v.map(function (p) { return parsePaints(p)[0]; }).filter(Boolean);
  if (typeof v === 'string') { var c = hexToRgb(v); var p = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } }; if (c.a != null) p.opacity = c.a; return [p]; }
  if (typeof v === 'object' && v.type) return [v];
  if (typeof v === 'object' && 'r' in v) { var q = { type: 'SOLID', color: { r: v.r, g: v.g, b: v.b } }; if (v.a != null) q.opacity = v.a; return [q]; }
  throw new Error('Cannot parse paint: ' + JSON.stringify(v));
}
function paintsOut(paints) {
  if (paints === figma.mixed) return 'mixed';
  if (!paints) return [];
  return paints.map(function (p) {
    var o = { type: p.type };
    if (p.type === 'SOLID') { o.color = rgbToHex(p.color); if (p.opacity != null && p.opacity !== 1) o.opacity = r3(p.opacity); }
    if (p.visible === false) o.visible = false;
    return o;
  });
}
function box(b) { return b ? { x: r3(b.x), y: r3(b.y), width: r3(b.width), height: r3(b.height) } : null; }

function serialize(node, depth, opts) {
  opts = opts || {};
  var o = { id: node.id, name: node.name, type: node.type };
  if (node.parent) o.parentId = node.parent.id;
  if ('visible' in node && node.visible === false) o.visible = false;
  if ('locked' in node && node.locked) o.locked = true;
  if ('x' in node) { o.x = r3(node.x); o.y = r3(node.y); }
  if ('width' in node) { o.width = r3(node.width); o.height = r3(node.height); }
  if ('rotation' in node && node.rotation) o.rotation = r3(node.rotation);
  if ('opacity' in node && node.opacity !== 1) o.opacity = r3(node.opacity);
  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) o.absoluteBoundingBox = box(node.absoluteBoundingBox);
  if (!opts.compact) {
    if ('fills' in node) o.fills = paintsOut(node.fills);
    if ('strokes' in node) { o.strokes = paintsOut(node.strokes); if (node.strokes && node.strokes.length) o.strokeWeight = r3(node.strokeWeight); }
    if ('cornerRadius' in node && node.cornerRadius && node.cornerRadius !== figma.mixed) o.cornerRadius = node.cornerRadius;
    if (node.type === 'TEXT') {
      o.characters = node.characters;
      o.fontSize = node.fontSize === figma.mixed ? 'mixed' : node.fontSize;
      o.fontName = node.fontName === figma.mixed ? 'mixed' : node.fontName;
      o.textAlignHorizontal = node.textAlignHorizontal;
    }
  }
  if (opts.vectors && node.type === 'VECTOR') o.vectorPaths = node.vectorPaths;
  if ('children' in node) {
    o.childCount = node.children.length;
    if (depth > 0) o.children = node.children.slice(0, opts.maxChildren || 300).map(function (c) { return serialize(c, depth - 1, opts); });
  }
  return o;
}

async function byId(id) {
  var n = await figma.getNodeByIdAsync(String(id));
  if (!n) throw new Error('Node not found: ' + id);
  return n;
}
async function byIds(ids) { var out = []; for (var i = 0; i < ids.length; i++) out.push(await byId(ids[i])); return out; }

async function loadFonts(textNode) {
  var fonts = textNode.fontName === figma.mixed ? textNode.getRangeAllFontNames(0, textNode.characters.length) : [textNode.fontName];
  for (var i = 0; i < fonts.length; i++) await figma.loadFontAsync(fonts[i]);
}

/** Append `node` to parent (or current page) and apply x/y (relative to parent, or absolute when p.absolute). */
async function place(node, p) {
  var parent = p.parentId ? await byId(p.parentId) : figma.currentPage;
  if (!('appendChild' in parent)) throw new Error('Parent cannot have children: ' + parent.type);
  parent.appendChild(node);
  if (p.name) node.name = p.name;
  if (p.x != null || p.y != null) {
    if (p.absolute) {
      var t = node.absoluteTransform;
      if (p.x != null) node.x += p.x - t[0][2];
      if (p.y != null) node.y += p.y - t[1][2];
    } else {
      if (p.x != null) node.x = p.x;
      if (p.y != null) node.y = p.y;
    }
  }
  if (p.fill !== undefined && 'fills' in node) node.fills = parsePaints(p.fill);
  if (p.stroke !== undefined && 'strokes' in node) node.strokes = parsePaints(p.stroke);
  if (p.strokeWeight != null && 'strokeWeight' in node) node.strokeWeight = p.strokeWeight;
  if (p.opacity != null) node.opacity = p.opacity;
  return node;
}

function commit() { try { if (figma.commitUndo) figma.commitUndo(); } catch (e) { /* ignore */ } }

/** Ensure a node exposes vectorPaths (flatten shapes such as RECTANGLE into a VECTOR). Returns the (possibly new) node. */
function asVector(node) {
  if (node.type === 'VECTOR') return node;
  if (['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'BOOLEAN_OPERATION'].indexOf(node.type) >= 0) {
    var parent = node.parent, index = parent.children.indexOf(node), name = node.name;
    var v = figma.flatten([node], parent, index);
    v.name = name;
    return v;
  }
  throw new Error('Node ' + node.id + ' (' + node.type + ') has no vector geometry');
}

function localRectPath(node) {
  var w = node.width, h = node.height;
  return [{ windingRule: 'NONZERO', data: 'M 0 0 L ' + w + ' 0 L ' + w + ' ' + h + ' L 0 ' + h + ' Z' }];
}

/* ---------------- commands ---------------- */
var commands = {
  ping: async function () { return { pong: true, version: VERSION, time: Date.now() }; },

  get_document: async function () {
    var pages = figma.root.children.map(function (pg) { return { id: pg.id, name: pg.name, current: pg.id === figma.currentPage.id }; });
    return {
      file: figma.root.name,
      editorType: figma.editorType,
      currentPage: { id: figma.currentPage.id, name: figma.currentPage.name, childCount: figma.currentPage.children.length },
      pages: pages,
      selection: figma.currentPage.selection.map(function (n) { return { id: n.id, name: n.name, type: n.type }; }),
      viewport: { center: figma.viewport.center, zoom: r3(figma.viewport.zoom) },
    };
  },

  get_selection: async function (p) {
    var depth = p.depth == null ? 1 : p.depth;
    return figma.currentPage.selection.map(function (n) { return serialize(n, depth, p); });
  },

  get_node: async function (p) {
    var node = await byId(p.id);
    return serialize(node, p.depth == null ? 1 : p.depth, p);
  },

  get_page_tree: async function (p) {
    var page = p.pageId ? await byId(p.pageId) : figma.currentPage;
    if (page.type === 'PAGE') await page.loadAsync();
    return serialize(page, p.depth == null ? 2 : p.depth, Object.assign({ compact: true }, p));
  },

  find_nodes: async function (p) {
    var root = p.rootId ? await byId(p.rootId) : figma.currentPage;
    if (root.type === 'DOCUMENT') await figma.loadAllPagesAsync();
    else if (root.type === 'PAGE') await root.loadAsync();
    if (!('findAll' in root)) throw new Error('Root has no children: ' + root.type);
    var re = p.nameRegex ? new RegExp(p.nameRegex, p.flags || '') : null;
    var types = p.type ? (Array.isArray(p.type) ? p.type : [p.type]) : null;
    var limit = p.limit || 100;
    var found = root.findAll(function (n) {
      if (types && types.indexOf(n.type) < 0) return false;
      if (p.name && n.name !== p.name) return false;
      if (p.nameContains && n.name.indexOf(p.nameContains) < 0) return false;
      if (re && !re.test(n.name)) return false;
      return true;
    });
    return { total: found.length, nodes: found.slice(0, limit).map(function (n) { return serialize(n, 0, { compact: !p.full }); }) };
  },

  set_props: async function (p) {
    var node = await byId(p.id);
    var props = p.props || {};
    var applied = [];
    var keys = Object.keys(props);
    var resized = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = props[k];
      if (k === 'width' || k === 'height') {
        if (resized) continue;
        var w = props.width != null ? props.width : node.width, h = props.height != null ? props.height : node.height;
        if ('resize' in node) node.resize(w, h); else throw new Error('Node cannot be resized: ' + node.type);
        resized = true; applied.push('resize');
      } else if (k === 'fills' || k === 'strokes') { node[k] = parsePaints(v); applied.push(k); }
      else if (k === 'characters') { await loadFonts(node); node.characters = String(v); applied.push(k); }
      else if (k === 'fontSize' || k === 'textAlignHorizontal' || k === 'textAlignVertical' || k === 'letterSpacing' || k === 'lineHeight' || k === 'textCase') { await loadFonts(node); node[k] = v; applied.push(k); }
      else if (k === 'fontName') { await figma.loadFontAsync(v); node.fontName = v; applied.push(k); }
      else if (k === 'parentId') { var parent = await byId(v); parent.appendChild(node); applied.push(k); }
      else if (k === 'absoluteX' || k === 'absoluteY') { var t = node.absoluteTransform; if (k === 'absoluteX') node.x += v - t[0][2]; else node.y += v - t[1][2]; applied.push(k); }
      else { node[k] = v; applied.push(k); }
    }
    commit();
    return { applied: applied, node: serialize(node, 0) };
  },

  translate: async function (p) {
    var nodes = await byIds(p.ids);
    nodes.forEach(function (n) { n.x += p.dx || 0; n.y += p.dy || 0; });
    commit();
    return nodes.map(function (n) { return serialize(n, 0, { compact: true }); });
  },

  delete_nodes: async function (p) {
    var removed = [];
    for (var i = 0; i < p.ids.length; i++) {
      var n = await figma.getNodeByIdAsync(String(p.ids[i]));
      if (n) { removed.push({ id: n.id, name: n.name, type: n.type }); n.remove(); }
    }
    commit();
    return { removed: removed, missing: p.ids.length - removed.length };
  },

  create_rectangle: async function (p) {
    var n = figma.createRectangle();
    n.resize(p.width || 100, p.height || 100);
    if (p.cornerRadius != null) n.cornerRadius = p.cornerRadius;
    await place(n, p);
    commit();
    return serialize(n, 0);
  },

  create_frame: async function (p) {
    var n = figma.createFrame();
    n.resize(p.width || 100, p.height || 100);
    if (p.fill === undefined) n.fills = [];
    if (p.clipsContent != null) n.clipsContent = p.clipsContent;
    await place(n, p);
    commit();
    return serialize(n, 0);
  },

  create_text: async function (p) {
    var n = figma.createText();
    var font = { family: p.fontFamily || 'Inter', style: p.fontStyle || 'Regular' };
    await figma.loadFontAsync(font);
    n.fontName = font;
    n.characters = String(p.characters == null ? '' : p.characters);
    if (p.fontSize) n.fontSize = p.fontSize;
    if (p.textAlignHorizontal) n.textAlignHorizontal = p.textAlignHorizontal;
    if (p.width) { n.textAutoResize = 'HEIGHT'; n.resize(p.width, n.height); }
    await place(n, p);
    commit();
    return serialize(n, 0);
  },

  create_vector: async function (p) {
    var n = figma.createVector();
    if (p.stroke === undefined) n.strokes = []; // drop Figma's default black outline
    await place(n, { parentId: p.parentId, name: p.name, fill: p.fill, stroke: p.stroke, strokeWeight: p.strokeWeight });
    var res = await commands.set_vector_paths({ id: n.id, paths: p.paths, absolute: p.absolute });
    if (!p.absolute && (p.x != null || p.y != null)) { if (p.x != null) n.x = p.x; if (p.y != null) n.y = p.y; }
    commit();
    return res;
  },

  import_svg: async function (p) {
    if (!p.svg) throw new Error('svg string required');
    var n = figma.createNodeFromSvg(p.svg);
    await place(n, Object.assign({ name: p.name || 'Imported SVG' }, p));
    commit();
    return serialize(n, p.depth == null ? 1 : p.depth, { compact: true });
  },

  get_vector_paths: async function (p) {
    var node = await byId(p.id);
    var paths = node.type === 'VECTOR' ? node.vectorPaths : (['RECTANGLE', 'FRAME'].indexOf(node.type) >= 0 ? localRectPath(node) : null);
    if (!paths) throw new Error('Node ' + node.id + ' (' + node.type + ') has no vectorPaths');
    return {
      id: node.id, name: node.name, type: node.type,
      x: r3(node.x), y: r3(node.y), width: r3(node.width), height: r3(node.height),
      absoluteTransform: node.absoluteTransform,
      absoluteBoundingBox: box(node.absoluteBoundingBox),
      vectorPaths: paths.map(function (vp) { return { windingRule: vp.windingRule, data: vp.data }; }),
    };
  },

  /**
   * Set vectorPaths. With absolute=true the path data is in page coordinates: we set it as-is and then
   * shift the node by minus its previous absolute translation, so geometry lands exactly where the
   * numbers say regardless of how Figma re-normalises the node's bounding box.
   */
  set_vector_paths: async function (p) {
    var node = asVector(await byId(p.id));
    var paths = p.paths.map(function (vp) { return { windingRule: vp.windingRule || 'NONZERO', data: vp.data }; });
    if (p.absolute) {
      var t = node.absoluteTransform, tx = t[0][2], ty = t[1][2];
      node.vectorPaths = paths;
      node.x -= tx; node.y -= ty;
    } else {
      node.vectorPaths = paths;
    }
    commit();
    return serialize(node, 0, { vectors: true });
  },

  boolean_op: async function (p) {
    var nodes = await byIds(p.ids);
    var parent = p.parentId ? await byId(p.parentId) : nodes[0].parent;
    var fn = { union: figma.union, subtract: figma.subtract, intersect: figma.intersect, exclude: figma.exclude }[p.op];
    if (!fn) throw new Error('op must be union|subtract|intersect|exclude');
    var res = fn.call(figma, nodes, parent);
    if (p.name) res.name = p.name;
    if (p.flatten) { var name = res.name; res = figma.flatten([res], parent); res.name = name; }
    commit();
    return serialize(res, 0, { vectors: true });
  },

  flatten: async function (p) {
    var nodes = await byIds(p.ids);
    var parent = p.parentId ? await byId(p.parentId) : nodes[0].parent;
    var v = figma.flatten(nodes, parent);
    if (p.name) v.name = p.name;
    commit();
    return serialize(v, 0, { vectors: true });
  },

  group: async function (p) {
    var nodes = await byIds(p.ids);
    var parent = p.parentId ? await byId(p.parentId) : nodes[0].parent;
    var g = figma.group(nodes, parent);
    if (p.name) g.name = p.name;
    commit();
    return serialize(g, 1, { compact: true });
  },

  ungroup: async function (p) {
    var node = await byId(p.id);
    var children = figma.ungroup(node);
    commit();
    return children.map(function (n) { return serialize(n, 0, { compact: true }); });
  },

  export_node: async function (p) {
    var node = await byId(p.id);
    var format = (p.format || 'PNG').toUpperCase();
    var settings = { format: format };
    if (format === 'PNG' || format === 'JPG') settings.constraint = { type: 'SCALE', value: p.scale || 1 };
    if (format === 'SVG') { settings.svgIdAttribute = p.svgIdAttribute !== false; settings.svgOutlineText = p.svgOutlineText !== false; }
    var bytes = await node.exportAsync(settings);
    return { id: node.id, name: node.name, format: format, bytes: bytes.length, base64: figma.base64Encode(bytes) };
  },

  set_current_page: async function (p) {
    var page = await byId(p.pageId);
    if (page.type !== 'PAGE') throw new Error('Not a page: ' + page.type);
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name };
  },

  set_selection: async function (p) {
    var nodes = await byIds(p.ids || []);
    figma.currentPage.selection = nodes;
    if (p.zoom !== false && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
    return nodes.map(function (n) { return { id: n.id, name: n.name }; });
  },

  notify: async function (p) { figma.notify(String(p.message || ''), { timeout: p.timeout || 3000 }); return { ok: true }; },

  /** Place a raster image (base64) as a rectangle fill — used for floor-plan underlays. */
  create_image: async function (p) {
    var bytes = p.base64 ? figma.base64Decode(p.base64) : null;
    if (!bytes) throw new Error('base64 required');
    var image = figma.createImage(bytes);
    var size = await image.getSizeAsync();
    var rect = figma.createRectangle();
    var w = p.width || size.width, h = p.height || (p.width ? (size.height * p.width) / size.width : size.height);
    rect.resize(w, h);
    rect.fills = [{ type: 'IMAGE', scaleMode: p.scaleMode || 'FILL', imageHash: image.hash }];
    await place(rect, { parentId: p.parentId, name: p.name || 'Plan', x: p.x, y: p.y, absolute: p.absolute, opacity: p.opacity });
    if (p.locked !== false) rect.locked = true;
    commit();
    return Object.assign(serialize(rect, 0, { compact: true }), { imageSize: size });
  },

  /** Escape hatch: run arbitrary async JS with (figma, params, h) in scope. Return value is JSON-serialised. */
  run_js: async function (p) {
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    var fn;
    try { fn = new AsyncFunction('figma', 'params', 'h', p.code); }
    catch (e) { throw new Error('Cannot compile code: ' + (e && e.message)); }
    var helpers = { serialize: serialize, byId: byId, byIds: byIds, parsePaints: parsePaints, loadFonts: loadFonts, place: place, box: box, hexToRgb: hexToRgb };
    var out = await fn(figma, p.params || {}, helpers);
    commit();
    return toJson(out);
  },
};

function isNode(v) { return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.type === 'string' && 'name' in v && 'parent' in v; }
function toJson(v) {
  if (v === undefined) return null;
  if (isNode(v)) return serialize(v, 1, { compact: true });
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === 'object') {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }
  return v;
}

/* ---------------- transport ---------------- */
function send(payload) { figma.ui.postMessage({ type: 'send', payload: payload }); }
function hello() {
  return {
    type: 'hello', version: VERSION, file: figma.root.name, editorType: figma.editorType,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.map(function (n) { return n.id; }),
  };
}

figma.ui.onmessage = async function (msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ws-open') { send(hello()); return; }
  if (msg.type !== 'cmd') return;
  var handler = commands[msg.cmd];
  if (!handler) { send({ type: 'result', id: msg.id, ok: false, error: 'Unknown command: ' + msg.cmd + '. Known: ' + Object.keys(commands).join(', ') }); return; }
  try {
    var result = await handler(msg.params || {});
    send({ type: 'result', id: msg.id, ok: true, result: result });
  } catch (e) {
    send({ type: 'result', id: msg.id, ok: false, error: String(e && e.message ? e.message : e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : undefined });
  }
};

figma.on('selectionchange', function () {
  send({ type: 'event', event: 'selectionchange', selection: figma.currentPage.selection.map(function (n) { return n.id; }) });
});
figma.on('currentpagechange', function () { send(Object.assign(hello(), { type: 'event', event: 'currentpagechange' })); });
