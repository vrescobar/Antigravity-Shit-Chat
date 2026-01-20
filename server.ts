#!/usr/bin/env node
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// --- Interfaces ---

interface Snapshot {
    html: string;
    bodyBg: string;
    bodyColor: string;
}

interface Metadata {
    windowTitle: string;
    chatTitle: string;
    isActive: boolean;
    contextId?: number;
}

interface CDPContext {
    id: number;
    // other properties if needed
}

interface CDPConnection {
    ws: WebSocket;
    call: (method: string, params: any) => Promise<any>;
    contexts: CDPContext[];
    rootContextId: number | null;
}

interface Cascade {
    id: string;
    cdp: CDPConnection;
    metadata: Metadata;
    snapshot: Snapshot | null;
    css: string;
    snapshotHash: string | null;
}

interface CDPTarget {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
    port: number;
}

// Application State
let cascades = new Map<string, Cascade>(); 
let wss: WebSocketServer | null = null;

// --- Helpers ---

// Simple hash function
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// HTTP GET JSON
function getJson(url: string): Promise<any> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve([]);
        } // return empty on parse error
      });
    });
    req.on("error", () => resolve([])); // return empty on network error
    req.setTimeout(2000, () => {
      req.destroy();
      resolve([]);
    });
  });
}

// --- CDP Logic ---

async function connectCDP(url: string): Promise<CDPConnection> {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  let idCounter = 1;
  const call = (method: string, params: any): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = idCounter++;
      const handler = (msg: any) => {
        const data = JSON.parse(msg.toString());
        if (data.id === id) {
          ws.off("message", handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const contexts: CDPContext[] = [];
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.method === "Runtime.executionContextCreated") {
        contexts.push(data.params.context);
      } else if (data.method === "Runtime.executionContextDestroyed") {
        const idx = contexts.findIndex(
          (c) => c.id === data.params.executionContextId,
        );
        if (idx !== -1) contexts.splice(idx, 1);
      }
    } catch (e) {}
  });

  await call("Runtime.enable", {});
  await new Promise((r) => setTimeout(r, 500)); // give time for contexts to load

  return { ws, call, contexts, rootContextId: null };
}

async function extractMetadata(cdp: CDPConnection): Promise<{ found: boolean; chatTitle: string; isActive: boolean; contextId?: number } | null> {
  const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { found: false };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
        for (const sel of possibleTitleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                chatTitle = el.textContent.trim();
                break;
            }
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus()
        };
    })()`;

  // Try finding context first if not known
  if (cdp.rootContextId) {
    try {
      const res = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: cdp.rootContextId,
      });
      if (res.result?.value?.found)
        return { ...res.result.value, contextId: cdp.rootContextId };
    } catch (e) {
      cdp.rootContextId = null;
    } // reset if stale
  }

  // Search all contexts
  for (const ctx of cdp.contexts) {
    try {
      const result = await cdp.call("Runtime.evaluate", {
        expression: SCRIPT,
        returnByValue: true,
        contextId: ctx.id,
      });
      if (result.result?.value?.found) {
        return { ...result.result.value, contextId: ctx.id };
      }
    } catch (e) {}
  }
  return null;
}

async function captureCSS(cdp: CDPConnection): Promise<string> {
  const SCRIPT = `(() => {
        // Gather CSS and namespace it basic way to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with #cascade locator
                    // This prevents the monitored app's global backgrounds from overriding our monitor's body
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#cascade');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#cascade');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
    })()`;

  const contextId = cdp.rootContextId;
  if (!contextId) return "";

  try {
    const result = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      contextId: contextId,
    });
    return result.result?.value?.css || "";
  } catch (e) {
    return "";
  }
}

async function captureHTML(cdp: CDPConnection): Promise<Snapshot | null> {
  const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { error: 'cascade not found' };
        
        const clone = cascade.cloneNode(true);
        // Remove input box to keep snapshot clean
        const input = clone.querySelector('[contenteditable="true"]')?.closest('div[id^="cascade"] > div');
        if (input) input.remove();
        
        const bodyStyles = window.getComputedStyle(document.body);

        return {
            html: clone.outerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color
        };
    })()`;

  const contextId = cdp.rootContextId;
  if (!contextId) return null;

  try {
    const result = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      contextId: contextId,
    });
    if (result.result?.value && !result.result.value.error) {
      return result.result.value;
    }
  } catch (e) {}
  return null;
}

// --- Main App Logic ---

async function discover() {
  // 1. Find all targets
  const allTargets: CDPTarget[] = [];
  await Promise.all(
    PORTS.map(async (port) => {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const workbenches = list.filter(
        (t: any) =>
          t.url?.includes("workbench.html") || t.title?.includes("workbench"),
      );
      workbenches.forEach((t: any) => allTargets.push({ ...t, port }));
    }),
  );

  const newCascades = new Map<string, Cascade>();

  // 2. Connect/Refresh
  for (const target of allTargets) {
    const id = hashString(target.webSocketDebuggerUrl);

    // Reuse existing
    if (cascades.has(id)) {
      const existing = cascades.get(id)!;
      if (existing.cdp.ws.readyState === WebSocket.OPEN) {
        // Refresh metadata
        const meta = await extractMetadata(existing.cdp);
        if (meta) {
          existing.metadata = { ...existing.metadata, ...meta };
          if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
          newCascades.set(id, existing);
          continue;
        }
      }
    }

    // New connection
    try {
      console.log(`🔌 Connecting to ${target.title}`);
      const cdp = await connectCDP(target.webSocketDebuggerUrl);
      const meta = await extractMetadata(cdp);

      if (meta) {
        if (meta.contextId) cdp.rootContextId = meta.contextId;
        const cascade: Cascade = {
          id,
          cdp,
          metadata: {
            windowTitle: target.title,
            chatTitle: meta.chatTitle,
            isActive: meta.isActive,
          },
          snapshot: null,
          css: await captureCSS(cdp), //only on init bc its huge
          snapshotHash: null,
        };
        newCascades.set(id, cascade);
        console.log(`✨ Added cascade: ${meta.chatTitle}`);
      } else {
        cdp.ws.close();
      }
    } catch (e) {
      // console.error(`Failed to connect to ${target.title}: ${e.message}`);
    }
  }

  // 3. Cleanup old
  for (const [id, c] of cascades.entries()) {
    if (!newCascades.has(id)) {
      console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
      try {
        c.cdp.ws.close();
      } catch (e) {}
    }
  }

  const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
  cascades = newCascades;

  if (changed) broadcastCascadeList();
}

async function updateSnapshots() {
  // Parallel updates
  await Promise.all(
    Array.from(cascades.values()).map(async (c) => {
      try {
        const snap = await captureHTML(c.cdp); // Only capture HTML
        if (snap) {
          const hash = hashString(snap.html);
          if (hash !== c.snapshotHash) {
            c.snapshot = snap;
            c.snapshotHash = hash;
            broadcast({ type: "snapshot_update", cascadeId: c.id });
            // console.log(`📸 Updated ${c.metadata.chatTitle}`);
          }
        }
      } catch (e) {}
    }),
  );
}

function broadcast(msg: any) {
  if (!wss) return;
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
  });
}

function broadcastCascadeList() {
  const list = Array.from(cascades.values()).map((c) => ({
    id: c.id,
    title: c.metadata.chatTitle,
    window: c.metadata.windowTitle,
    active: c.metadata.isActive,
  }));
  broadcast({ type: "cascade_list", cascades: list });
}

// --- Server Setup ---

async function main() {
  const app = express();
  const server = http.createServer(app);
  wss = new WebSocketServer({ server });

  app.use(express.json());
  app.use(express.static(join(__dirname, "public")));

  // API Routes
  app.get("/cascades", (req, res) => {
    res.json(
      Array.from(cascades.values()).map((c) => ({
        id: c.id,
        title: c.metadata.chatTitle,
        active: c.metadata.isActive,
      })),
    );
  });

  app.get("/snapshot/:id", (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c || !c.snapshot) return res.status(404).json({ error: "Not found" });
    res.json(c.snapshot);
  });

  app.get("/styles/:id", (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json({ css: c.css || "" });
  });

  // Alias for simple single-view clients (returns first active or first available)
  app.get("/snapshot", (req, res) => {
    const active =
      Array.from(cascades.values()).find((c) => c.metadata.isActive) ||
      cascades.values().next().value;
    if (!active || !active.snapshot)
      return res.status(503).json({ error: "No snapshot" });
    res.json(active.snapshot);
  });

  app.post("/send/:id", async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: "Cascade not found" });

    console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);

    const result = await injectMessage(c.cdp, req.body.message);
    if (result.ok) res.json({ success: true });
    else res.status(500).json(result);
  });

  // Action endpoint for conversation controls
  app.post("/action/:id/:action", async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: "Cascade not found" });

    const action = req.params.action;
    const result = await performAction(c.cdp, action);

    if (result.ok) {
      // Trigger discovery after close to update cascade list
      if (action === "close") {
        setTimeout(() => discover(), 500);
      }
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json(result);
    }
  });

  wss.on("connection", (ws) => {
    broadcastCascadeList(); // Send list on connect
  });

  const PORT = Number(process.env.PORT) || 3001;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Backend API running on port ${PORT}`);
    
    // Log local IPs
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    if (ips.length > 0) {
        console.log(`📡 Local Network: http://${ips[0]}:${PORT}`);
        if (ips.length > 1) {
            console.log(`   (Other IPs: ${ips.slice(1).join(', ')})`);
        }
    }
  });

  // Start Loops
  discover();
  setInterval(discover, DISCOVERY_INTERVAL);
  setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp: CDPConnection, text: string) {
  const SCRIPT = `(async () => {
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, "${text.replace(/"/g, '\\"')}");
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${text.replace(/"/g, '\\"')}");
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter" }));
        }
        return { ok: true };
    })()`;

  try {
    const res = await cdp.call("Runtime.evaluate", {
      expression: SCRIPT,
      returnByValue: true,
      contextId: cdp.rootContextId,
    });
    return res.result?.value || { ok: false };
  } catch (e: any) {
    return { ok: false, reason: e.message };
  }
}

// Action Helper for conversation controls
async function performAction(cdp: CDPConnection, action: string) {
  const SCRIPTS: Record<string, string> = {
    // New conversation: click the + button
    new: `(() => {
      const selectors = [
        'button[aria-label*="New"]',
        'button[aria-label*="new"]',
        'button[title*="New"]',
        '[data-testid*="new"]'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return { ok: true, message: 'Clicked new' }; }
        } catch (e) {}
      }
      // Fallback: look for + button in header
      const headerBtns = document.querySelectorAll('header button, [class*="titlebar"] button, [class*="header"] button');
      for (const btn of headerBtns) {
        const svg = btn.querySelector('svg');
        if (svg) {
          const paths = svg.querySelectorAll('path');
          for (const p of paths) {
            const d = p.getAttribute('d') || '';
            if (d.includes('M12') && (d.includes('v14') || d.includes('V19'))) {
              btn.click();
              return { ok: true, message: 'Clicked new (svg fallback)' };
            }
          }
        }
      }
      return { ok: false, reason: 'New button not found' };
    })()`,

    // History: click the clock/history button  
    history: `(() => {
      const selectors = [
        'button[aria-label*="History"]',
        'button[aria-label*="history"]',
        'button[aria-label*="Previous"]',
        'button[title*="History"]',
        '[data-testid*="history"]'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return { ok: true, message: 'Clicked history' }; }
        } catch (e) {}
      }
      // Fallback: look for clock-like SVG in header
      const headerBtns = document.querySelectorAll('header button, [class*="titlebar"] button, [class*="header"] button');
      for (const btn of headerBtns) {
        const svg = btn.querySelector('svg');
        if (svg && svg.innerHTML.includes('circle')) {
          btn.click();
          return { ok: true, message: 'Clicked history (svg fallback)' };
        }
      }
      return { ok: false, reason: 'History button not found' };
    })()`,

    // Close: click the X button
    close: `(() => {
      const selectors = [
        'button[aria-label*="Close"]',
        'button[aria-label*="close"]',
        'button[title*="Close"]',
        '[data-testid*="close"]'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return { ok: true, message: 'Clicked close' }; }
        } catch (e) {}
      }
      // Fallback: rightmost button in header
      const headerBtns = Array.from(document.querySelectorAll('header button, [class*="titlebar"] button, [class*="header"] button'));
      const lastBtn = headerBtns[headerBtns.length - 1];
      if (lastBtn) {
        lastBtn.click();
        return { ok: true, message: 'Clicked close (fallback)' };
      }
      return { ok: false, reason: 'Close button not found' };
    })()`
  };

  const script = SCRIPTS[action];
  if (!script) return { ok: false, reason: 'Unknown action: ' + action };

  try {
    const res = await cdp.call("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      contextId: cdp.rootContextId,
    });
    return res.result?.value || { ok: false, reason: 'No result' };
  } catch (e: any) {
    return { ok: false, reason: e.message };
  }
}

main();
