// ============================================================
// OBSIDIAN CORE — Auto-fetch de dados em tempo real
// Carrega ./data/latest.json ao abrir e a cada 60 segundos.
// Deve ser carregado APÓS o app.js no index.html.
// ============================================================

(function () {
  const DATA_PATH  = './data/latest.json';
  const REFRESH_MS = 60_000;
  let   fetchCount = 0;

  async function loadData() {
    fetchCount++;
    const url = DATA_PATH + '?v=' + Date.now();

    try {
      const res = await fetch(url);

      if (!res.ok) {
        console.warn('[AutoFetch] HTTP', res.status, url);
        return;
      }

      const text = await res.text();

      if (!text || text.trim() === '' || text.trim() === '[]') {
        console.info('[AutoFetch] arquivo vazio — aguardando GitHub Actions gerar dados.');
        return;
      }

      // Usa o parser central do app.js
      if (typeof parseJsonText !== 'function') {
        console.error('[AutoFetch] parseJsonText não encontrado — verifique se app.js carregou.');
        return;
      }

      const assets = parseJsonText(text);

      if (!assets || assets.length === 0) {
        console.warn('[AutoFetch] parseJsonText retornou vazio. JSON recebido:', text.slice(0, 200));
        return;
      }

      // Atualiza o estado e re-renderiza
      state.assets   = assets;
      lastUpdateTime = Date.now();
      renderAll();

      console.info(`[AutoFetch #${fetchCount}] ✓ ${assets.length} ativos carregados.`);

    } catch (err) {
      console.error('[AutoFetch] Erro ao buscar dados:', err.message);
    }
  }

  // Carrega imediatamente ao abrir a página
  document.addEventListener('DOMContentLoaded', function () {
    loadData();
    setInterval(loadData, REFRESH_MS);
    console.info('[AutoFetch] Iniciado — atualiza a cada', REFRESH_MS / 1000, 'segundos.');
  });

})();
