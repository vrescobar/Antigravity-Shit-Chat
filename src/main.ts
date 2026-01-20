// Antigravity Shit-Chat Client

interface Cascade {
    id: string;
    title: string;
    active: boolean;
    // other properties if needed
}

interface SnapshotUpdate {
    type: 'snapshot_update';
    cascadeId: string;
}

interface CascadeListUpdate {
    type: 'cascade_list';
    cascades: Cascade[];
}

type WebSocketMessage = SnapshotUpdate | CascadeListUpdate;

const tabsContainer = document.getElementById('tabsContainer') as HTMLDivElement;
const chatContent = document.getElementById('chatContent') as HTMLDivElement;
const chatContainer = document.getElementById('chatContainer') as HTMLDivElement;
const messageInput = document.getElementById('messageInput') as HTMLTextAreaElement;
const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;

let cascades: Cascade[] = [];
let currentCascadeId: string | null = null;
let ws: WebSocket | null = null;

function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Connect WebSocket directly to backend (Vite doesn't proxy WS well)
    const wsHost = location.hostname + ':3001';
    ws = new WebSocket(`${protocol}//${wsHost}`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data) as WebSocketMessage;

        if (data.type === 'cascade_list') {
            cascades = data.cascades;
            renderTabs();

            // Auto-select first if none selected
            if (!currentCascadeId && cascades.length > 0) {
                selectCascade(cascades[0].id);
            }
        }

        if (data.type === 'snapshot_update') {
            if (data.cascadeId === currentCascadeId) {
                updateContentOnly(currentCascadeId);
            }
        }
    };

    ws.onclose = () => setTimeout(connect, 2000);
}

function renderTabs() {
    tabsContainer.innerHTML = cascades.map(c => `
        <div class="cascade-tab ${c.id === currentCascadeId ? 'active' : ''} ${c.active ? 'active-window' : ''}" 
             data-id="${c.id}">
            <div class="status"></div>
            ${c.title || 'Untitled'}
        </div>
    `).join('');

    // Add click handlers
    tabsContainer.querySelectorAll('.cascade-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const id = (tab as HTMLElement).dataset.id;
            if (id) selectCascade(id);
        });
    });

    if (cascades.length === 0) {
        tabsContainer.innerHTML = '<div class="cascade-tab">No chats found</div>';
        showEmptyState();
    }
}

function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <p>No hay conversaciones activas</p>
            <button onclick="doAction('new')">➕ Nueva conversación</button>
            <button onclick="doAction('history')" style="background: #6366f1;">🕐 Ver historial</button>
        </div>
    `;
}

// Global function needs to be explicitly typed on window if used in HTML
// But better to attach to window explicitly for TS
(window as any).doAction = async function(action: string) {
    if (!currentCascadeId && action !== 'new' && action !== 'history') {
        alert('Selecciona una conversación primero');
        return;
    }

    const toolbar = document.getElementById('actionToolbar');
    if (toolbar) {
        const buttons = toolbar.querySelectorAll('button');
        buttons.forEach(b => b.disabled = true);
    }

    try {
        // For new/history when no cascade, use first available or trigger anyway
        const targetId = currentCascadeId || (cascades[0]?.id);
        if (!targetId) {
            alert('No hay conexión con Antigravity. Asegúrate de que esté ejecutándose con --remote-debugging-port=9000');
            return;
        }

        const res = await fetch(`/action/${targetId}/${action}`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok) {
            console.error('Action failed:', data);
            alert('Error: ' + (data.reason || data.error || 'Unknown error'));
        }

        // Refresh after action
        if (action === 'close') {
            currentCascadeId = null;
        }
    } catch (e: any) {
        console.error('Action error:', e);
        alert('Error de conexión: ' + e.message);
    } finally {
        if (toolbar) {
             const buttons = toolbar.querySelectorAll('button');
             buttons.forEach(b => b.disabled = false);
        }
    }
}


function selectCascade(id: string) {
    currentCascadeId = id;
    renderTabs();
    loadCascade(id);
}

// Make accessible to console/other scripts if needed, though mostly internal
(window as any).selectCascade = selectCascade;

async function loadCascade(id: string) {
    try {
        // 1. Fetch Styles (Once)
        const styleRes = await fetch(`/styles/${id}`);
        if (styleRes.ok) {
            const styleData = await styleRes.json();
            const styleEl = document.getElementById('cascade-style');
            if (styleEl) {
                styleEl.textContent = `
                    ${styleData.css}
                    #cascade { 
                        background: transparent !important; 
                        color: white !important; 
                    }
                    #cascade .prose {
                        --tw-prose-body: #e5e7eb !important;
                        --tw-prose-headings: #f3f4f6 !important;
                        --tw-prose-lead: #e5e7eb !important;
                        --tw-prose-links: #60a5fa !important;
                        --tw-prose-bold: #f3f4f6 !important;
                        --tw-prose-counters: #9ca3af !important;
                        --tw-prose-bullets: #d1d5db !important;
                        --tw-prose-hr: #374151 !important;
                        --tw-prose-quotes: #f3f4f6 !important;
                        --tw-prose-quote-borders: #374151 !important;
                        --tw-prose-captions: #9ca3af !important;
                        --tw-prose-code: #f3f4f6 !important;
                        --tw-prose-pre-code: #e5e7eb !important;
                        --tw-prose-pre-bg: #1f2937 !important;
                        --tw-prose-th-borders: #374151 !important;
                        --tw-prose-td-borders: #374151 !important;
                        color: #e5e7eb !important;
                    }
                    /* Ensure code blocks are readable */
                    pre, code { background: #111 !important; color: #ddd !important; }
                `;
            }
        }

        // 2. Fetch Content
        await updateContentOnly(id);
    } catch (e) { console.error(e); }
}

async function updateContentOnly(id: string) {
    try {
        const res = await fetch(`/snapshot/${id}`);
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();

        // Preserve Scroll
        const isAtBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 50;

        document.body.style.backgroundColor = data.bodyBg || '#1a1a1a';
        chatContent.innerHTML = data.html;

        if (isAtBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
    } catch (e) { }
}

async function sendMessage() {
    const text = messageInput.value;
    if (!text || !currentCascadeId) return;

    // Clear immediately to feel responsive
    messageInput.value = '';

    try {
        await fetch(`/send/${currentCascadeId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        updateContentOnly(currentCascadeId); // Immediate refresh try
    } catch (e: any) {
        console.error("Send failed", e);
        messageInput.value = text; // Restore on fail
        alert("Failed to send message: " + e.message);
    }
}

sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

connect();
