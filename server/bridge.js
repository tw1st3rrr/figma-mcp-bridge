#!/usr/bin/env node
// Long-lived local relay:  Figma plugin  <-ws://localhost:PORT/plugin->  bridge  <-ws://localhost:PORT/mcp->  MCP server(s)
// Runs detached so the plugin stays connected across Claude Code restarts. Several MCP controllers may share one plugin.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

export function startBridge({ port = 3055, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let plugin = null, pluginInfo = null, seq = 0, lastPluginDisconnect = null;
    const controllers = new Set();
    const pending = new Map(); // gid -> { ws, id, timer, cmd }
    const startedAt = Date.now();

    const status = () => ({
      bridge: 'ok', port, pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      pluginConnected: !!plugin, plugin: pluginInfo, lastPluginDisconnect, controllers: controllers.size, pending: pending.size,
    });
    const sendJson = (ws, obj) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const broadcastStatus = () => { for (const c of controllers) sendJson(c, Object.assign({ type: 'status' }, status())); };
    const failPending = (reason, filter) => {
      for (const [gid, p] of pending) {
        if (filter && !filter(p)) continue;
        clearTimeout(p.timer); pending.delete(gid);
        sendJson(p.ws, { type: 'result', id: p.id, ok: false, error: reason });
      }
    };

    function onPlugin(ws) {
      if (plugin && plugin !== ws) { log('replacing previous plugin connection'); try { plugin.close(4000, 'replaced'); } catch { /* ignore */ } }
      plugin = ws; pluginInfo = { connectedAt: new Date().toISOString() };
      log('plugin connected');
      broadcastStatus();
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'hello') { const h = Object.assign({}, msg); delete h.type; Object.assign(pluginInfo, h); broadcastStatus(); }
        else if (msg.type === 'event') {
          if (msg.event === 'selectionchange') pluginInfo.selection = msg.selection;
          if (msg.event === 'currentpagechange') { pluginInfo.page = msg.page; pluginInfo.selection = msg.selection; }
          for (const c of controllers) sendJson(c, msg);
        } else if (msg.type === 'result') {
          const p = pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer); pending.delete(msg.id);
          sendJson(p.ws, Object.assign({}, msg, { id: p.id }));
        }
      });
      ws.on('close', (code, reason) => {
        if (plugin !== ws) return;
        lastPluginDisconnect = { at: new Date().toISOString(), code, reason: reason ? reason.toString() : '', file: pluginInfo && pluginInfo.file, byHeartbeat: !!ws.killedByHeartbeat };
        plugin = null; pluginInfo = null;
        failPending('Figma plugin disconnected while the command was running');
        log('plugin disconnected code=' + code + (ws.killedByHeartbeat ? ' (heartbeat)' : ''));
        broadcastStatus();
      });
      ws.on('error', () => {});
    }

    function onController(ws) {
      controllers.add(ws);
      sendJson(ws, Object.assign({ type: 'status' }, status()));
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'status') { sendJson(ws, Object.assign({ type: 'status', id: msg.id }, status())); return; }
        if (msg.type !== 'cmd') return;
        if (!plugin) {
          sendJson(ws, { type: 'result', id: msg.id, ok: false, error: 'Figma plugin is not connected. In Figma Desktop open the file, then Plugins → Development → "Figma MCP Bridge" and keep its window open.' });
          return;
        }
        const gid = 'g' + (++seq);
        const timeoutMs = msg.timeoutMs || 120000;
        const timer = setTimeout(() => {
          if (pending.delete(gid)) sendJson(ws, { type: 'result', id: msg.id, ok: false, error: 'Timeout after ' + timeoutMs + 'ms waiting for Figma (' + msg.cmd + ')' });
        }, timeoutMs);
        pending.set(gid, { ws, id: msg.id, timer, cmd: msg.cmd });
        sendJson(plugin, { type: 'cmd', id: gid, cmd: msg.cmd, params: msg.params || {} });
      });
      ws.on('close', () => { controllers.delete(ws); failPending('controller closed', (p) => p.ws === ws); });
      ws.on('error', () => {});
    }

    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    // Liveness: any frame (pong or app message) resets the counter; a socket is dropped only after 3 silent intervals (~60 s).
    wss.on('connection', (ws, req) => {
      ws.missed = 0;
      ws.on('pong', () => { ws.missed = 0; });
      ws.on('message', () => { ws.missed = 0; });
      const pathname = new URL(req.url || '/', 'http://x').pathname;
      if (pathname === '/plugin') onPlugin(ws); else onController(ws);
    });
    const hb = setInterval(() => {
      for (const ws of wss.clients) {
        if (++ws.missed > 3) { ws.killedByHeartbeat = true; ws.terminate(); continue; }
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, 20000);

    // Listen on both loopback families so "localhost" resolves either way; nothing is exposed to the LAN.
    const handler = (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); };
    const servers = [];
    const listen = (host) => new Promise((res, rej) => {
      const srv = http.createServer(handler);
      srv.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req)));
      srv.once('error', rej);
      srv.listen(port, host, () => { servers.push(srv); res(srv); });
    });
    listen('127.0.0.1').then(
      () => listen('::1').catch(() => log('IPv6 loopback unavailable, IPv4 only')).then(() => {
        log('listening on ws://localhost:' + port + '  (plugin: /plugin, mcp: /mcp)');
        resolve({
          port, status,
          close: () => new Promise((res) => {
            clearInterval(hb);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            let n = servers.length;
            if (!n) return res();
            for (const s of servers) s.close(() => { if (--n === 0) res(); });
          }),
        });
      }),
      (e) => reject(e),
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FIGMA_BRIDGE_PORT || process.argv[2] || 3055);
  startBridge({ port, log: (s) => console.error('[bridge] ' + s) }).catch((e) => {
    console.error('[bridge] failed to start on port ' + port + ': ' + e.message);
    process.exit(1);
  });
}
