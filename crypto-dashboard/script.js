// ============================================================
// OBSIDIAN CORE — Auto-fetch + WebSocket de preço em tempo real
// Auto-fetch: carrega ./data/latest.json ao abrir e a cada 60s.
// WebSocket:  conecta ao aggTrade da Binance Futures por símbolo.
// Deve ser carregado APÓS o app.js no index.html.
// ============================================================

(function () {
  const DATA_PATH  = './data/latest.json';
  const REFRESH_MS = 60_000;
  const WS_BASE    = 'wss://fstream.binance.com/stream?streams=';

  let fetchCount   = 0;
  let _ws          = null;
  let _wsSymbolKey = '';
  let _interval    = null;

  // ── Auto-fetch do latest.json ──────────────────────────────
  async function loadData() {
    fetchCount++;
    const url = DATA_PATH + '?v=' + Date.now();
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn('[AutoFetch] HTTP', res.status, url); return; }
      const text = await res.text();
      if (!text || text.trim() === '' || text.trim() === '[]') {
        console.info('[AutoFetch] arquivo vazio — aguardando GitHub Actions gerar dados.');
        return;
      }
      if (typeof parseJsonText !== 'function') {
        console.error('[AutoFetch] parseJsonText não encontrado — verifique se app.js carregou.');
        return;
      }
      const assets = parseJsonText(text);
      if (!assets || assets.length === 0) {
        console.warn('[AutoFetch] parseJsonText retornou vazio. JSON recebido:', text.slice(0, 200));
        return;
      }
      state.assets   = assets;
      lastUpdateTime = Date.now();
      renderAll();
      connectPriceWs(assets.map(a => a.symbol));
      console.info(`[AutoFetch #${fetchCount}] ✓ ${assets.length} ativos carregados.`);
    } catch (err) {
      console.error('[AutoFetch] Erro ao buscar dados:', err.message);
    }
  }

  // ── WebSocket de preço em tempo real ──────────────────────
  function connectPriceWs(symbols) {
    const key = symbols.slice().sort().join(',');
    if (_ws && _ws.readyState < 2 && key === _wsSymbolKey) return;
    _wsSymbolKey = key;
    if (_ws) { try { _ws.close(); } catch (e) {} _ws = null; }

    const streams = symbols.map(s => s.toLowerCase() + '@aggTrade').join('/');

    function open() {
      const ws = new WebSocket(WS_BASE + streams);
      _ws = ws;

      ws.onmessage = function (evt) {
        try {
          const msg   = JSON.parse(evt.data);
          const data  = msg.data || msg;
          const sym   = (data.s || '').toUpperCase();
          const price = parseFloat(data.p);
          if (!sym || isNaN(price)) return;
          flashPrice(sym, price);
        } catch (e) {}
      };

      ws.onclose = function () {
        if (_ws === ws) setTimeout(open, 3000);
      };

      ws.onerror = function () { ws.close(); };
      console.info('[WS] Conectado — streams aggTrade:', symbols.length, 'ativos.');
    }

    open();
  }

  // ── Atualiza o preço no DOM com flash verde/vermelho ───────
  function flashPrice(symbol, newPrice) {
    const el = document.querySelector('.price-display[data-symbol="' + symbol + '"]');
    if (!el) return;

    const prev = parseFloat(el.dataset.lastPrice);
    const fmt  = p => p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2);
    el.textContent = '$' + fmt(newPrice);

    if (!isNaN(prev) && newPrice !== prev) {
      const cls = newPrice > prev ? 'price-flash-up' : 'price-flash-down';
      el.classList.remove('price-flash-up', 'price-flash-down');
      void el.offsetWidth; // reflow para reiniciar a animação CSS
      el.classList.add(cls);
      setTimeout(() => el.classList.remove('price-flash-up', 'price-flash-down'), 650);
    }

    el.dataset.lastPrice = newPrice;

    // Mantém o estado em memória sincronizado (geral e laboratório)
    const asset = state.assets.find(a => a.symbol === symbol)
               || state.labAssets.find(a => a.symbol === symbol);
    if (asset) asset.price = parseFloat(newPrice.toFixed(6));
  }

  // Expõe connectPriceWs para o app.js usar na troca de aba
  window.connectPriceWs = connectPriceWs;

  // Pausa: cancela intervalo e fecha WebSocket
  window.pauseMonitoring = function () {
    if (_interval) { clearInterval(_interval); _interval = null; }
    if (_ws) { try { _ws.close(); } catch (e) {} _ws = null; _wsSymbolKey = ''; }
    console.info('[System] Monitoramento pausado.');
  };

  // Retoma: reconecta imediatamente e reinicia intervalo
  window.resumeMonitoring = function () {
    if (!_interval) _interval = setInterval(loadData, REFRESH_MS);
    loadData();
    console.info('[System] Monitoramento retomado.');
  };

  // ── Init ───────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    loadData();
    _interval = setInterval(loadData, REFRESH_MS);
    console.info('[AutoFetch] Iniciado — atualiza a cada', REFRESH_MS / 1000, 'segundos.');
  });

})();
