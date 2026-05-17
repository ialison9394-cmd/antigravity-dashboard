// OBSIDIAN CORE — Auto-fetch de dados (script.js)
// Busca ./data/latest.json ao carregar e a cada 60 segundos.

const DATA_PATH  = './data/latest.json';
const REFRESH_MS = 60_000;

// ── Busca e processa os dados ─────────────────────────────────
async function fetchAndRender() {
  try {
    const res = await fetch(DATA_PATH + '?t=' + Date.now()); // bust cache
    if (!res.ok) return;

    const raw = await res.text();
    if (!raw || raw.trim() === '[]') return;

    // Reutiliza o parser central do app.js se disponível
    if (typeof parseJsonText === 'function') {
      const assets = parseJsonText(raw);
      if (!assets || !assets.length) return;
      state.assets    = assets;
      lastUpdateTime  = Date.now();
      renderAll();
      return;
    }

    // Fallback: injeta direto no modal e aciona syncJson
    const textarea = document.getElementById('json-input-area');
    if (textarea && typeof syncJson === 'function') {
      textarea.value = raw;
      syncJson();
    }
  } catch (_) {
    // silencioso se offline ou arquivo inexistente
  }
}

// ── Inicia ao carregar a página ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchAndRender();
  setInterval(fetchAndRender, REFRESH_MS);
});
