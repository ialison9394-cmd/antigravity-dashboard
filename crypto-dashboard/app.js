// ============================================================
// F1 ANÁLISE — app.js
// ============================================================

// URL do arquivo gerado pelo GitHub Actions.
// Em produção (Netlify) usa o caminho relativo — funciona automaticamente.
const DATA_URL = './data/latest.json';

// ===== ESTADO =====
const state = {
  assets: [],       // auto-fetch (Bloco D / sentiment)
  labAssets: [],    // legacy compat
  activeTab: 'geral',
  activeMainTab: 'toptrader',
  isPaused: false,
  expandedCard: null,
  tabs: {
    toptrader:  { assets: [] },
    acumulacao: { assets: [] },
    f1rapido:   { assets: [] },
    sentimento: { assets: [] },
  },
  sentiment: {
    btcChange:   null,
    btcdChange:  null,
    usdtdChange: null,
  }
};

// Extrai o último valor de uma série temporal [[ts,val],...] ou retorna o valor direto
function extractLatest(val) {
  if (!Array.isArray(val)) return val;
  if (!val.length) return null;
  const last = val[val.length - 1];
  return (Array.isArray(last) && last.length >= 2) ? last[1] : last;
}

// ============================================================
// SISTEMA LIVE / PAUSADO
// ============================================================
function togglePause() {
  state.isPaused = !state.isPaused;
  const btn     = document.getElementById('pause-btn');
  const pill    = document.getElementById('live-pill');
  const overlay = document.getElementById('pause-overlay');

  if (state.isPaused) {
    if (typeof window.pauseMonitoring === 'function') window.pauseMonitoring();
    document.body.classList.add('is-paused');
    if (btn) { btn.textContent = '▶ ATIVAR'; btn.classList.replace('live', 'paused'); }
    if (pill) pill.classList.add('stale');
    if (overlay) overlay.classList.remove('hidden');
  } else {
    if (typeof window.resumeMonitoring === 'function') window.resumeMonitoring();
    document.body.classList.remove('is-paused');
    if (btn) { btn.textContent = '⏸ PAUSAR'; btn.classList.replace('paused', 'live'); }
    if (pill) pill.classList.remove('stale');
    if (overlay) overlay.classList.add('hidden');
  }
}

function toggleCard(symbol) {
  state.expandedCard = state.expandedCard === symbol ? null : symbol;
  renderRankingList();
}

// ============================================================
// SETUP SCORE E PERSISTÊNCIA
// ============================================================

// Cache em memória — evita ler localStorage para cada símbolo a cada import
const _historyCache = {};

function getAssetHistory(symbol) {
  if (symbol in _historyCache) return _historyCache[symbol];
  const historyRaw = localStorage.getItem('phoenix_history_' + symbol);
  if (!historyRaw) { _historyCache[symbol] = []; return []; }
  try {
    const history = JSON.parse(historyRaw);
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const filtered = history.filter(ts => ts > oneDayAgo);
    _historyCache[symbol] = filtered;
    return filtered;
  } catch(e) { _historyCache[symbol] = []; return []; }
}

function recordAssetAppearance(symbol) {
  const history = getAssetHistory(symbol);
  const now = Date.now();
  // Dedup de 30s — evita duplo clique no PROCESSAR contar duas vezes
  if (history.length > 0 && now - history[history.length - 1] < 30000) {
    return history.length;
  }
  history.push(now);
  _historyCache[symbol] = history;
  localStorage.setItem('phoenix_history_' + symbol, JSON.stringify(history));
  return history.length;
}

function clearRadar() {
  Object.keys(localStorage).filter(k => k.startsWith('phoenix_history_')).forEach(k => localStorage.removeItem(k));
  Object.keys(_historyCache).forEach(k => delete _historyCache[k]);
  ALL_TAB_KEYS.forEach(k => {
    if (state.tabs[k] && state.tabs[k].assets.length) {
      state.tabs[k].assets.forEach(a => { a.appearances = 1; });
    }
  });
  renderAll();
}

function calculateSetupScore(a) {
  var raw  = a.raw || {};
  var lsr  = parseFloat(a.lsr) || 1;
  var fr   = parseFloat(a.fr)  || 0;

  // ── 1. Velocidade de Agressão (25%) — usa Trades 1h do raw
  var tpm1h = parseFloat(extractLatest(raw['trades_minute:1h']));
  if (isNaN(tpm1h) || tpm1h <= 0) tpm1h = parseFloat(a.tpm) || 0;
  var s_agr = tpm1h >= 1000 ? 25 : tpm1h >= 700 ? 15 : 0;

  // ── 2. Resiliência Exponencial (20%) — EXP 1h
  var exp1h = parseFloat(extractLatest(raw['exp_btc:1h']));
  if (isNaN(exp1h)) exp1h = parseFloat(a.exp) || 0;
  var s_exp = exp1h > 65 ? 20 : exp1h > 35 ? 10 : 0;

  // ── 3. Acumulação e Pressão (15%) — Range Level 1h
  var rl1h = parseFloat(extractLatest(raw['range_level:1h']));
  if (isNaN(rl1h) || rl1h <= 0) rl1h = parseFloat(a.range_level) || 0;
  var s_rl = (rl1h >= 8) ? 15 : (rl1h >= 5) ? 10 : 0;

  // ── 4. Gatilho Técnico RSI (15%) — RSI 1h
  var rsi1h = parseFloat(extractLatest(raw['rsi:1h']));
  if (isNaN(rsi1h) || rsi1h <= 0) rsi1h = parseFloat(a.rsi) || 50;
  var s_rsi = (rsi1h >= 60 && rsi1h <= 69) ? 15 : rsi1h > 70 ? 10 : 0;

  // ── 5. Tríade de Sentimento (25%)
  var s_tri = 0;
  if (lsr < 0.8)              s_tri += 10;
  if (a.oi === 'subindo')     s_tri += 10;
  if (fr < 0)                 s_tri += 5;

  var total = s_agr + s_exp + s_rl + s_rsi + s_tri;

  // Trava RSI > 85 (Exaustão)
  if (rsi1h > 85) total -= 30;

  // Trend Breakout macro — bônus extra quando confirmado
  if (a.break1d || a.break4h || a.break1h) total += 15;

  // ── 6. Bônus de Sobrevivência: > 3h no radar → +10%
  if ((a.appearances || 1) > 3) total = Math.round(total * 1.10);

  // Bônus Macro ALTSEASON: +20% quando BTC↑ BTC.D↓ + EXP+ + LSR caindo
  if (state.sentiment.btcChange !== null && state.sentiment.btcdChange !== null) {
    var _bDir = state.sentiment.btcChange  >  1.5 ? 'up' : state.sentiment.btcChange  < -1.5 ? 'down' : 'flat';
    var _dDir = state.sentiment.btcdChange >  0.3 ? 'up' : state.sentiment.btcdChange < -0.3 ? 'down' : 'flat';
    if (_bDir === 'up' && _dDir === 'down' && exp1h > 0 && lsr < 1.0) {
      total = Math.round(total * 1.2);
    }
  }

  // Guarda dados 1h calculados no asset para uso no breakdown
  a._tpm1h = tpm1h; a._exp1h = exp1h; a._rl1h = rl1h; a._rsi1h = rsi1h;

  return Math.min(Math.max(total, 0), 100);
}

function getScoreStatus(score) {
  if (score >= 86) return { label: 'Fortona: Entrada Confirmada',     color: '#00FFFF' };
  if (score >= 70) return { label: 'Gatilho F1: Rompimento Iminente', color: '#00FF88' };
  if (score >= 40) return { label: 'Mola Encolhida: Monitorar',       color: '#FFB800' };
  return              { label: 'Reset / Descarte',                    color: '#555570' };
}

function getMacroState() {
  var bc = state.sentiment.btcChange;
  var dc = state.sentiment.btcdChange;
  if (bc === null || dc === null) return 'AWAITING';
  var bDir = bc >  1.5 ? 'up' : bc < -1.5 ? 'down' : 'flat';
  var dDir = dc >  0.3 ? 'up' : dc < -0.3 ? 'down' : 'flat';
  if (bDir === 'up'   && dDir === 'down') return 'ALTSEASON';
  if (bDir === 'down' && dDir === 'up')   return 'FLIGHT_SAFETY';
  if (bDir === 'down' && dDir === 'down') return 'CAPITULATION';
  if (bDir === 'up'   && dDir === 'up')   return 'INSTITUTIONAL_BTC';
  if (bDir === 'flat' && dDir === 'down') return 'ALTS_GAINING';
  if (bDir === 'flat' && dDir === 'up')   return 'BTC_ABSORBING';
  return 'NEUTRAL';
}

// ============================================================
// BTC RESILIENCE SCORE (Barra Roxa)
// ============================================================
function getBtcResilience(asset) {
  let s = 0;
  const lsr = parseFloat(asset.lsr) || 1;
  const fr  = parseFloat(asset.fr)  || 0;

  // LSR baixo = varejo preso em short, ativo absorve pressão vendedora
  if (lsr < 0.8)       s += 45;
  else if (lsr < 1.0)  s += 25;

  // Funding negativo = shorts pagando = acumulação institucional
  if (fr < -0.0003)      s += 35;
  else if (fr < -0.0001) s += 20;
  else if (fr < 0)       s += 10;

  // OI subindo = capital entrando mesmo com BTC lateral/queda
  if (asset.oi === 'subindo') s += 20;

  // Ajuste macro: usa contexto real do lastro (aba Sentimento)
  const macro = getMacroState();
  if (macro === 'ALTSEASON' || macro === 'ALTS_GAINING') s = Math.min(Math.round(s * 1.15), 100);
  else if (macro === 'FLIGHT_SAFETY' || macro === 'CAPITULATION') s = Math.round(s * 0.8);

  return Math.min(s, 100);
}

// ============================================================
// SMART MONEY METRICS
// ============================================================

// Range Level 0-5: quão comprimida está a mola (alta = pronto para explodir)
function calcRangeLevel(asset) {
  let pts = 0;
  const rsi = parseFloat(asset.rsi) || 50;
  const fr  = parseFloat(asset.fr)  || 0;
  const lsr = parseFloat(asset.lsr) || 1;

  if      (rsi < 35) pts += 2.5;
  else if (rsi < 45) pts += 1.5;
  else if (rsi < 55) pts += 0.5;

  if      (fr < -0.0003) pts += 1.5;
  else if (fr < -0.0001) pts += 1.0;
  else if (fr < 0)       pts += 0.5;

  if      (lsr < 0.7) pts += 1.0;
  else if (lsr < 0.9) pts += 0.5;

  return Math.min(Math.round(pts), 5);
}

// Labels Institucionais — substituem Tração
function getInstitutionalLabels(asset) {
  const labels = [];
  if (asset.tpm >= 1000)
    labels.push({ key: 'HFT DOMINA',   color: '#00D2FF' });
  if (asset.lsr < 1.0 && asset.oi === 'subindo')
    labels.push({ key: 'SHORT FUEL',   color: '#FFB800' });
  if ((asset.exp || 0) > 0 && asset.oi === 'subindo')
    labels.push({ key: 'FORÇA ESTRU',  color: '#00FF88' });
  if (asset.rsi < 45 && asset.oi === 'subindo')
    labels.push({ key: 'ACUM 1D',      color: '#A855F7' });
  return labels;
}

// Tração: mantida para uso interno em calcRangeLevel
function calcTracao(asset) {
  const rsi = parseFloat(asset.rsi) || 50;
  const tpm = parseFloat(asset.tpm) || 0;
  const pts = (rsi > 55 ? 2 : rsi > 45 ? 1 : 0)
            + (tpm >= 1000 ? 2 : tpm >= 700 ? 1 : 0)
            + (asset.oi === 'subindo' ? 1 : 0);
  if (pts >= 4) return { label: 'FORTE', color: '#00FF88' };
  if (pts >= 2) return { label: 'MÉDIA', color: '#FFB800' };
  return           { label: 'FRACA',  color: '#555570' };
}

// Arrancada: rompimento com OI explodindo + momentum alto
function isArrancada(asset) {
  const rsi = parseFloat(asset.rsi) || 50;
  const tpm = parseFloat(asset.tpm) || 0;
  return rsi >= 62 && asset.oi === 'subindo' && tpm >= 1000;
}

// ============================================================
// TAB SWITCHING — 3 abas principais
// ============================================================
const TAB_KEYS     = ['toptrader', 'acumulacao', 'f1rapido'];
const ALL_TAB_KEYS = ['toptrader', 'acumulacao', 'f1rapido', 'sentimento'];

function switchMainTab(key) {
  state.activeMainTab = key;
  ALL_TAB_KEYS.forEach(k => {
    const btn  = document.getElementById('tab-btn-' + k);
    const view = document.getElementById('view-' + k);
    if (btn)  btn.classList.toggle('active', k === key);
    if (view) view.classList.toggle('view-hidden', k !== key);
  });
  if (key === 'sentimento') renderSentimentoTab();
  const symbols = (state.tabs[key] ? state.tabs[key].assets : []).map(a => a.symbol);
  if (symbols.length && typeof window.connectPriceWs === 'function') {
    window.connectPriceWs(symbols);
  }
}

// Legacy no-op kept for script.js compat
function switchTab() {}
function loadLabFromStorage() {}
function updateLabCount() {}

// ── Per-tab JSON processing ───────────────────────────────
function processTabJson(key) {
  const textarea = document.getElementById('json-' + key);
  const fb       = document.getElementById('fb-' + key);
  const raw      = (textarea ? textarea.value : '').trim();

  if (!raw) {
    fb.textContent = '⚠ Cole um JSON antes de processar.';
    fb.className = 'lab-feedback error';
    return;
  }
  fb.textContent = '⚡ Processando...';
  fb.className = 'lab-feedback';

  setTimeout(function () {
    // Para a aba Sentimento: reseta macro antes de parsear (ela é a âncora)
    if (key === 'sentimento') {
      state.sentiment = { btcChange: null, btcdChange: null, usdtdChange: null };
    }

    const assets = parseJsonText(raw);
    if (!assets) {
      fb.textContent = '✗ JSON inválido ou nenhum ativo encontrado.';
      fb.className = 'lab-feedback error';
      return;
    }
    state.tabs[key].assets = assets;

    // USDT.D detection (exclusivo da aba sentimento)
    if (key === 'sentimento') {
      const usdtdA = assets.find(function(a) {
        return a.symbol === 'USDTDOMUSDT' || a.symbol === 'USDTDOM' || a.symbol === 'USDT.D';
      });
      if (usdtdA && usdtdA.raw) {
        var pct = parseFloat(extractLatest(usdtdA.raw['price_change:1D']));
        if (!isNaN(pct)) state.sentiment.usdtdChange = pct;
      }
    }

    const countEl = document.getElementById('count-' + key);
    if (countEl) countEl.textContent = assets.length + ' ativo' + (assets.length !== 1 ? 's' : '');

    if (key === 'sentimento') {
      renderSentimentoTab();
    } else {
      renderTabGrid(key);
    }
    renderKpiBar();
    renderSentimentBlock();
    renderMacroAlert();
    renderConvergencia();
    // Re-render all grids para atualizar Resiliência vs BTC com novo contexto macro
    if (key === 'sentimento') {
      TAB_KEYS.forEach(k => { if (state.tabs[k].assets.length) renderTabGrid(k); });
    }
    if (key === 'toptrader') {
      renderTechBlock();
      renderLiquidityBlock();
    }
    if (typeof window.connectPriceWs === 'function') {
      window.connectPriceWs(assets.map(a => a.symbol));
    }
    fb.textContent = '✓ ' + assets.length + ' ativo(s) sincronizado(s)!';
    fb.className = 'lab-feedback success';
    collapseJsonPanel(key);
  }, 0);
}

function toggleJsonPanel(key) {
  const body   = document.getElementById('json-body-' + key);
  const btn    = document.getElementById('json-toggle-' + key);
  const hidden = body && body.classList.toggle('json-body-hidden');
  if (btn) btn.textContent = hidden ? '▼ EXPANDIR' : '▲ OCULTAR';
}

function collapseJsonPanel(key) {
  const body = document.getElementById('json-body-' + key);
  const btn  = document.getElementById('json-toggle-' + key);
  if (body) body.classList.add('json-body-hidden');
  if (btn)  btn.textContent = '▼ EXPANDIR';
}

function clearTabJson(key) {
  const textarea = document.getElementById('json-' + key);
  const fb       = document.getElementById('fb-' + key);
  const countEl  = document.getElementById('count-' + key);
  if (textarea) textarea.value = '';
  if (fb)       { fb.textContent = ''; fb.className = 'lab-feedback'; }
  if (state.tabs[key]) state.tabs[key].assets = [];
  if (countEl) countEl.textContent = '0 ativos';

  if (key === 'sentimento') {
    state.sentiment = { btcChange: null, btcdChange: null, usdtdChange: null };
    renderSentimentoTab();
    renderSentimentBlock();
    renderMacroAlert();
    TAB_KEYS.forEach(k => { if (state.tabs[k].assets.length) renderTabGrid(k); });
  } else {
    renderTabGrid(key);
    renderConvergencia();
  }
  // Re-expand the panel so user can paste new JSON
  const body = document.getElementById('json-body-' + key);
  const btn  = document.getElementById('json-toggle-' + key);
  if (body) body.classList.remove('json-body-hidden');
  if (btn)  btn.textContent = '▲ OCULTAR';
}

function renderTabGrid(key) {
  const emptyMsgs = {
    toptrader:  'Cole um JSON e clique em PROCESSAR para ver o ranking TOP TRADER.',
    acumulacao: 'Cole um JSON e clique em PROCESSAR para ver os ativos em Acumulação.',
    f1rapido:   'Cole um JSON e clique em PROCESSAR para ver os ativos F1 Rápido.',
  };
  _renderAssetsGrid('grid-' + key, null, state.tabs[key].assets, emptyMsgs[key] || '...', key);
}

// ── Convergência PHOENIX ──────────────────────────────────
function getConvergencia() {
  const sets = TAB_KEYS.map(k => new Set(state.tabs[k].assets.map(a => a.symbol)));
  if (!sets[0].size || !sets[1].size || !sets[2].size) return [];

  const common = [...sets[0]].filter(s => sets[1].has(s) && sets[2].has(s));

  return common.map(sym => {
    const scores = TAB_KEYS.map(k => {
      const a = state.tabs[k].assets.find(x => x.symbol === sym);
      return a ? (a._score || 0) : 0;
    });
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / 3);
    const bestAsset = state.tabs.toptrader.assets.find(x => x.symbol === sym)
                   || state.tabs.acumulacao.assets.find(x => x.symbol === sym)
                   || state.tabs.f1rapido.assets.find(x => x.symbol === sym);
    return { symbol: sym, avgScore, scores, asset: bestAsset };
  }).sort((a, b) => b.avgScore - a.avgScore).slice(0, 10);
}

function renderConvergencia() {
  const panel   = document.getElementById('convergencia-panel');
  const grid    = document.getElementById('convergencia-grid');
  const countEl = document.getElementById('convergencia-count');
  if (!panel || !grid) return;

  const list = getConvergencia();

  if (countEl) countEl.textContent = list.length + ' convergência' + (list.length !== 1 ? 's' : '');

  if (!list.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const tabLabels = ['TT', 'AC', 'F1'];
  grid.innerHTML = list.map((item, idx) => {
    const status = getScoreStatus(item.avgScore);
    const medal  = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1);
    const scoresHtml = item.scores.map((s, i) =>
      `<span class="cvg-score-tab" style="color:${getScoreStatus(s).color}">${tabLabels[i]}: ${s}%</span>`
    ).join('');
    const fmt = item.asset ? (p => p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2)) : null;
    const priceStr = (item.asset && item.asset.price > 0) ? '$' + fmt(item.asset.price) : '';
    return `
      <div class="cvg-item">
        <div class="cvg-rank">${medal}</div>
        <div class="cvg-sym">
          <span class="cvg-symbol">${item.symbol}</span>
          <span class="cvg-badge">[TRIAD]</span>
          ${priceStr ? `<span class="cvg-price" data-symbol="${item.symbol}">${priceStr}</span>` : ''}
        </div>
        <div class="cvg-scores">${scoresHtml}</div>
        <div class="cvg-avg" style="color:${status.color};text-shadow:0 0 8px ${status.color}66">${item.avgScore}%</div>
      </div>`;
  }).join('');
}

// ============================================================
// RENDER RANKING (Geral) — com breakdown por componente
// ============================================================
function getComponentScores(a) {
  var lsr   = parseFloat(a.lsr) || 1;
  var fr    = parseFloat(a.fr)  || 0;
  var tpm1h = a._tpm1h !== undefined ? a._tpm1h : (parseFloat(a.tpm) || 0);
  var exp1h = a._exp1h !== undefined ? a._exp1h : (parseFloat(a.exp) || 0);
  var rl1h  = a._rl1h  !== undefined ? a._rl1h  : (parseFloat(a.range_level) || 0);
  var rsi1h = a._rsi1h !== undefined ? a._rsi1h : (parseFloat(a.rsi) || 50);

  var agr = tpm1h >= 1000 ? 25 : tpm1h >= 700 ? 15 : 0;
  var exp = exp1h > 65 ? 20 : exp1h > 35 ? 10 : 0;
  var rl  = rl1h  >= 8 ? 15 : rl1h >= 5 ? 10 : 0;
  var rsi = (rsi1h >= 60 && rsi1h <= 69) ? 15 : rsi1h > 70 ? 10 : 0;
  var lsrPts = lsr < 0.8 ? 10 : 0;
  var oiPts  = a.oi === 'subindo' ? 10 : 0;
  var frPts  = fr < 0 ? 5 : 0;

  return [
    { key: 'AGRESSÃO 1H', val: tpm1h >= 1000 ? (tpm1h/1000).toFixed(1)+'K t/m' : Math.round(tpm1h)+' t/m',
      got: agr, max: 25,
      label: tpm1h >= 1000 ? 'FORTONA ATIVA' : tpm1h >= 700 ? 'AQUECENDO' : 'FRIO',
      color: tpm1h >= 1000 ? '#00FFFF' : tpm1h >= 700 ? '#FFB800' : '#555570' },
    { key: 'EXP 1H',      val: (exp1h > 0 ? '+' : '') + parseFloat(exp1h).toFixed(1),
      got: exp, max: 20,
      label: exp1h > 65 ? 'ABSORÇÃO FORTE' : exp1h > 35 ? 'RESILIÊNCIA+' : 'FRACO',
      color: exp1h > 65 ? '#00FFFF' : exp1h > 35 ? '#00FF88' : '#555570' },
    { key: 'RANGE 1H',    val: parseFloat(rl1h).toFixed(1) + '/10',
      got: rl, max: 15,
      label: rl1h >= 8 ? 'MOLA MÁXIMA' : rl1h >= 5 ? 'ACUM MADURA' : 'SEM PRESSÃO',
      color: rl1h >= 8 ? '#00FF88' : rl1h >= 5 ? '#FFB800' : '#555570' },
    { key: 'RSI 1H',      val: parseFloat(rsi1h).toFixed(1),
      got: rsi, max: 15,
      label: rsi1h > 85 ? '⚠ EXAUSTÃO -30' : (rsi1h >= 60 && rsi1h <= 69) ? 'IMINENTE' : rsi1h > 70 ? 'BREAKOUT' : 'AGUARDANDO',
      color: rsi1h > 85 ? '#E10600' : (rsi1h >= 60 && rsi1h <= 69) ? '#00FFFF' : rsi1h > 70 ? '#00FF88' : '#555570' },
    { key: 'TRÍADE',      val: 'LSR ' + lsr.toFixed(2) + ' · ' + a.oi.toUpperCase(),
      got: lsrPts + oiPts + frPts, max: 25,
      label: (lsrPts ? 'SQUEEZE ' : '') + (oiPts ? 'OI+ ' : '') + (frPts ? 'FR-' : '') || 'NEUTRO',
      color: (lsrPts + oiPts + frPts) >= 20 ? '#00FFFF' : (lsrPts + oiPts + frPts) >= 10 ? '#FFB800' : '#555570' },
  ];
}

function renderRankingList() {
  renderTabGrid('toptrader');
}

function renderLabList() {
  // legacy no-op; use renderTabGrid instead
}

function _renderAssetsGrid(gridId, countEl, displayAssets, emptyMsg, mode) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (!displayAssets.length) {
    grid.innerHTML = `<p class="ranking-empty" style="grid-column:1/-1">${emptyMsg}</p>`;
    if (countEl) countEl.textContent = '0 ativos';
    return;
  }

  const scored = displayAssets.map(a => ({ asset: a, score: a._score !== undefined ? a._score : calculateSetupScore(a) }));
  scored.sort((a, b) => b.score - a.score);

  const displayLimit = 30;
  const displayRanking = scored.slice(0, displayLimit);
  const triadSet = new Set(getConvergencia().map(c => c.symbol));

  if (countEl) {
    if (scored.length > displayLimit) {
      countEl.innerHTML = `<span style="color:#00FF88;">${scored.length} PROCESSADOS</span> • EXIBINDO TOP ${displayRanking.length}`;
    } else {
      countEl.textContent = `${scored.length} ativos`;
    }
  }

  const rows = displayRanking.map(({ asset, score }, idx) => {
    const status     = getScoreStatus(score);
    const missing    = 100 - score;
    const medal      = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;

    const tpmLabel = asset.tpm >= 1000 ? (asset.tpm / 1000).toFixed(1) + 'K' : String(asset.tpm);

    // Smart Money
    const selo1k    = asset.tpm >= 1000 ? '<span class="selo-1k">1K ⚡</span>' : '';
    const rl        = calcRangeLevel(asset);
    const rlColor   = rl >= 4 ? '#00FF88' : rl >= 2 ? '#00D2FF' : '#555570';
    const rlDots    = Array.from({length: 5}, (_, i) =>
      `<span class="range-dot" style="${i < rl ? `background:${rlColor};box-shadow:0 0 5px ${rlColor}66` : ''}"></span>`
    ).join('');
    const arrancada   = isArrancada(asset);
    const instLabels  = getInstitutionalLabels(asset);

    // AI SIGNAL ENGINE
    let signalsHtml = '';
    
    let hasMacroBreakout = asset.break1h || asset.break4h || asset.break1d;
    if (hasMacroBreakout) {
      let tfs = [];
      if (asset.break1d) tfs.push('1D');
      if (asset.break4h) tfs.push('4H');
      if (asset.break1h) tfs.push('1H');
      signalsHtml += `
        <div class="signal-box" style="border-color:#00FFFF; background: rgba(0, 255, 255, 0.1);">
          <div class="sig-type" style="color:#00FFFF; text-shadow: 0 0 5px #00FFFF; font-weight: 800;">🚀 MACRO TREND BREAKOUT (${tfs.join(', ')})</div>
          <div class="sig-conf" style="color:#00FFFF;">CONFIDENCE 99% - GATILHO F1 MÁXIMO</div>
          <div class="sig-desc">Ativo rompendo LTB/LTA em tempo gráfico maior (${tfs.join(', ')}). Capturado na mira, tendência de forte expansão direcional.</div>
        </div>`;
    }

    if (asset.oi === 'subindo' && asset.lsr < 0.8) {
      signalsHtml += `
        <div class="signal-box" style="border-color:#00FF66;">
          <div class="sig-type" style="color:#00FF66;">🔥 SQUEEZE ATROPELADOR</div>
          <div class="sig-conf">CONFIDENCE 95%</div>
          <div class="sig-desc">Massa presa em short (LSR < 0.8) com Open Interest agredindo. Ignição validada.</div>
        </div>`;
    }
    
    if (asset.cvd && asset.cvd > 0 && asset.tpm >= 700) {
       signalsHtml += `
        <div class="signal-box" style="border-color:#B200FF;">
          <div class="sig-type" style="color:#B200FF;">AGRESSÃO REAL (CVD+)</div>
          <div class="sig-desc">Compradores institucionais agredindo a mercado (Delta Positivo). Subida estruturada com volume.</div>
        </div>`;
    }
    
    if (asset.liq_dist !== null && asset.liq_dist < 3 && asset.liq_dist >= 0) {
       signalsHtml += `
        <div class="signal-box" style="border-color:#FFB800;">
          <div class="sig-type" style="color:#FFB800;">🧲 ÍMÃ DE LIQUIDEZ (${asset.liq_dist}%)</div>
          <div class="sig-desc">Cluster de liquidação muito próximo. Preço sendo gravitacionalmente puxado para acionar stops e gerar combustível.</div>
        </div>`;
    }
    
    if (asset.ma99 === 'muito_acima') {
       signalsHtml += `
        <div class="signal-box" style="border-color:#E10600; opacity: 0.9; border-style: dashed;">
          <div class="sig-type" style="color:#E10600;">⚠️ FOMO TRAP (MA99)</div>
          <div class="sig-conf" style="color:#E10600;">ALERTA DE ATRASO</div>
          <div class="sig-desc">Ativo esticado demais da Média 99. Entrada na "euforia" com alta probabilidade de reset na cara. ABORTAR!</div>
        </div>`;
    }
    if (asset.rsi >= 40 && asset.rsi <= 65 && asset.tpm >= 700) {
      signalsHtml += `
        <div class="signal-box" style="border-color:#FF8800;">
          <div class="sig-type" style="color:#FF8800;">MOMENTUM EXPANSION / MOLA</div>
          <div class="sig-conf">CONFIDENCE 85%</div>
          <div class="sig-desc">Ativo comprimido (Slow-cook). Alta atividade (T/MIN ${tpmLabel}) em zona de RSI favorável aguardando gatilho direcional.</div>
        </div>`;
    }
    if (asset.rsi > 80) {
      signalsHtml += `
        <div class="signal-box" style="border-color:#FF0055;">
          <div class="sig-type" style="color:#FF0055;">OVERHEATED TREND</div>
          <div class="sig-conf">RISK LEVEL 95%</div>
          <div class="sig-desc">RSI Esticado. Possível fundo de overbought detectado. Cooldown ou risco de cauda provável.</div>
        </div>`;
    }
    if (asset.fr > 0.0005) {
       signalsHtml += `
        <div class="signal-box" style="border-color:#FF0055;">
          <div class="sig-type" style="color:#FF0055;">FUNDING EXTREME</div>
          <div class="sig-desc">Longs pagando taxa elevadíssima para manter posição. Risco de liquidação em cascata se o preço recuar.</div>
        </div>`;
    }

    // ── Rótulos Institucionais ──────────────────────────────
    if (asset.lsr < 1.0 && asset.oi === 'subindo') {
      signalsHtml += `
        <div class="signal-box" style="border-color:#FFB800;background:rgba(255,184,0,0.07);">
          <div class="sig-type" style="color:#FFB800;">⚡ SHORT FUEL</div>
          <div class="sig-conf" style="color:#FFB800;">LSR ${asset.lsr.toFixed(2)} · OI CRESCENDO</div>
          <div class="sig-desc">Shorts dominantes com Open Interest injetando. Combustível para squeeze montado — varejo preso no lado errado.</div>
        </div>`;
    }
    if (asset.tpm >= 1000 && !(asset.oi === 'subindo' && asset.lsr < 0.8)) {
      signalsHtml += `
        <div class="signal-box" style="border-color:#00D2FF;background:rgba(0,210,255,0.06);">
          <div class="sig-type" style="color:#00D2FF;">HFT / SQUEEZE</div>
          <div class="sig-conf" style="color:#00D2FF;">${(asset.tpm/1000).toFixed(1)}K TRADES/MIN</div>
          <div class="sig-desc">Alta frequência detectada — algoritmos agredindo. Pressão direcional concentrada de robôs institucionais.</div>
        </div>`;
    }
    if (asset.oi_usd !== null && asset.oi_usd > 0 && asset.oi_usd < 2_000_000) {
      signalsHtml += `
        <div class="signal-box" style="border-color:#E10600;border-style:dashed;opacity:0.85;">
          <div class="sig-type" style="color:#E10600;">⚠️ OI BAIXO</div>
          <div class="sig-desc">Open Interest abaixo de $2M. Liquidez reduzida — spread elevado e risco de manipulação aumentado.</div>
        </div>`;
    }
    // Macro bonus ativo? Destaca no topo dos sinais
    if (getMacroState() === 'ALTSEASON' && (asset.exp || 0) > 0 && asset.lsr < 1.0) {
      signalsHtml = `
        <div class="signal-box signal-altseason-bonus">
          <div class="sig-type" style="color:#00FF88;">ALTSEASON BONUS +20%</div>
          <div class="sig-conf" style="color:#00FF88;">MACRO FAVORÁVEL · EXP+ · SHORT FUEL</div>
          <div class="sig-desc">Score amplificado pelo cenário macro (BTC↑ / BTC.D↓). Momentum positivo com shorts posicionados — máxima oportunidade.</div>
        </div>` + signalsHtml;
    }

    // PHOENIX CAIXA DE OPERAÇÃO
    let opBoxHtml = '';
    if (asset.price && asset.price > 0) {
      const stop = asset.price * 0.97;
      const tp1 = asset.price * 1.05;
      const tp2 = asset.price * 1.10;
      const formatPrice = (p) => p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2);

      opBoxHtml = `
        <div class="phoenix-op-box">
          <div class="ai-op-item"><div class="op-lbl">🛑 Stop (-3%)</div><div class="op-val op-stop">${formatPrice(stop)}</div></div>
          <div class="ai-op-item"><div class="op-lbl">💰 Alvo 1 (+5%)</div><div class="op-val op-tp1">${formatPrice(tp1)}</div></div>
          <div class="ai-op-item"><div class="op-lbl">🏆 Alvo 2 (+10%)</div><div class="op-val op-tp2">${formatPrice(tp2)}</div></div>
        </div>
      `;
    }

    const formatPriceDisplay = (p) => p ? (p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2)) : 'N/A';
    const appText = asset.appearances > 0 ? `<span class="badge-radar-fire">🔥 ${asset.appearances}x</span>` : '';

    const isExpanded = state.expandedCard === asset.symbol;
    const bodyDisplay = isExpanded ? 'grid' : 'none';
    const chevron = isExpanded ? '▲' : '▼';

    // Valores formatados (sem excesso de casas decimais)
    const lsrDisplay = parseFloat(asset.lsr).toFixed(2);
    const frDisplay  = parseFloat(asset.fr).toFixed(6);
    const rsiDisplay = parseFloat(asset.rsi).toFixed(1);

    // Cores originais da Tríade
    const lsrColor = asset.lsr < 0.8 ? '#00FF88' : asset.lsr > 2.0 ? '#E10600' : '#00D2FF';
    const frColor  = asset.fr < 0 ? '#00FF88' : Math.abs(asset.fr) <= 0.0001 ? '#FFB800' : '#E10600';
    const oiColor  = asset.oi === 'subindo' ? '#00FF88' : asset.oi === 'caindo' ? '#E10600' : '#FFB800';
    const tpmColor = asset.tpm >= 1000 ? '#00FF88' : asset.tpm >= 700 ? '#FFB800' : '#666680';
    const rsiColor = asset.rsi >= 65 && asset.rsi <= 75 ? '#00FF88' : asset.rsi > 85 ? '#E10600' : '#FFB800';
    const oiLabel  = asset.oi === 'subindo' ? '↑' : asset.oi === 'caindo' ? '↓' : '→';

    // Mode highlight keys
    const hlMap = { toptrader: ['OI','LSR','T/MIN'], acumulacao: ['RSI','FUNDING'], f1rapido: ['T/MIN'] };
    const hlKeys = (mode && hlMap[mode]) || [];
    const hl = key => hlKeys.includes(key) ? ' metric-hl' : '';
    const rlModeClass = mode === 'acumulacao' ? ' rl-mode-hl' : '';
    const tpmModeClass = mode === 'f1rapido' ? ' tpm-mode-hl' : '';

    // StrengthBar — resiliência vs BTC
    const resilience     = getBtcResilience(asset);
    const strengthGlow   = resilience >= 60 ? ' strength-glow' : '';
    const strengthLabel  = resilience >= 80 ? 'ABSORÇÃO FORTE' : resilience >= 50 ? 'SEGURANDO' : 'FRACA';

    // Hierarquia visual — borda pulsante para Fortona
    const fortonaClass = score >= 85 ? ' card-fortona' : '';

    // Breakdown do Score (BdRow) com Barras de Evolução
    const breakdown = getComponentScores(asset);
    const breakdownHtml = breakdown.map(b => {
      const pct = (b.got / b.max) * 100;
      return `
      <div style="margin-bottom: 12px;">
        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom: 6px;">
          <span style="color:var(--dim); font-weight:700;">${b.key} <span style="color:#fff; font-family:var(--mono); margin-left:4px;">${b.val}</span></span>
          <span style="color:${b.color}; font-weight:700;">+${b.got} <span style="font-size:9px;color:var(--dim)">/ ${b.max}</span> • ${b.label}</span>
        </div>
        <div style="width: 100%; height: 5px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
          <div style="width: ${pct}%; height: 100%; background: ${b.color}; border-radius: 3px; box-shadow: 0 0 5px ${b.color};"></div>
        </div>
      </div>
    `}).join('');

    return `
      <div class="card${fortonaClass}" data-symbol="${asset.symbol}" style="cursor:pointer; position:relative; overflow:hidden; margin-bottom:0;" onclick="toggleCard('${asset.symbol}')">
        <div class="ti-top">
          <div>
            <div class="ti-symbol">${asset.symbol} ${triadSet.has(asset.symbol) ? '<span class="ti-triad-badge">[TRIAD]</span>' : ''} ${selo1k}<span class="price-display" data-symbol="${asset.symbol}" style="font-size:10px; color:var(--dim); margin-left:6px;">$${formatPriceDisplay(asset.price)}</span></div>
            <div class="ti-status" style="color:${status.color}">${status.label} ${appText}</div>
          </div>
          <div class="ti-score-wrap">
            <div class="ti-score-val" style="color:${status.color}">${score}%</div>
            <div class="ti-score-lbl">SETUP SCORE</div>
          </div>
          <div style="color:var(--dim); font-size:12px; margin-left:16px;">
            ${chevron}
          </div>
        </div>

        <div class="ti-bar-bg">
          <div class="ti-bar-fill" style="width:${score}%;background:${status.color};"></div>
        </div>

        <div class="strength-wrap">
          <div class="strength-label-row">
            <span>RESILIÊNCIA vs BTC</span>
            <span>${resilience}% — ${strengthLabel}</span>
          </div>
          <div class="strength-bg">
            <div class="strength-fill${strengthGlow}" style="width:${resilience}%;"></div>
          </div>
        </div>

        <div class="smart-badges">
          ${instLabels.length
            ? instLabels.map(l => `<span class="badge-inst" style="color:${l.color};border-color:${l.color}44;box-shadow:0 0 8px ${l.color}22;text-shadow:0 0 8px ${l.color}88">${l.key}</span>`).join('')
            : '<span class="badge-inst badge-inst-neutral">MONITORANDO</span>'}
          ${arrancada ? '<span class="badge-arrancada">⚡ ARRANCADA</span>' : ''}
          ${asset.ma99 === 'muito_acima' ? '<span class="badge-ma99-late">⚠ MA99 ATRASADO</span>' : ''}
          ${asset.appearances > 5 && score > 80 ? '<span class="badge-phoenix-insist">INSISTÊNCIA PHOENIX</span>' : ''}
        </div>

        <div class="ai-card-body" style="display:${bodyDisplay}; margin-top: 20px; padding-top: 16px; border-top: 1px dashed rgba(255,255,255,0.05); text-align:left; cursor:default;" onclick="event.stopPropagation()">
          <div class="ai-col-left">
            <div class="range-level-wrap${rlModeClass}" style="margin-bottom:12px;">
              <span class="rl-label">MOLA</span>
              <div class="range-dots">${rlDots}</div>
              <span class="rl-num" style="color:${rlColor}">${rl}/5</span>
            </div>
            <div class="ti-metrics" style="margin-bottom:16px;">
              <div class="ti-metric${hl('OI')}"><div class="ti-metric-lbl">OI</div><div class="ti-metric-val" style="color:${oiColor}">${oiLabel} ${asset.oi.toUpperCase()}</div></div>
              <div class="ti-metric${hl('LSR')}"><div class="ti-metric-lbl">LSR</div><div class="ti-metric-val" style="color:${lsrColor}">${lsrDisplay}</div></div>
              <div class="ti-metric${hl('FUNDING')}"><div class="ti-metric-lbl">FUNDING</div><div class="ti-metric-val" style="color:${frColor}">${frDisplay}</div></div>
              <div class="ti-metric${hl('RSI')}"><div class="ti-metric-lbl">RSI</div><div class="ti-metric-val" style="color:${rsiColor}">${rsiDisplay}</div></div>
              <div class="ti-metric${hl('T/MIN') + tpmModeClass}"><div class="ti-metric-lbl">T/MIN</div><div class="ti-metric-val" style="color:${tpmColor}">${tpmLabel}</div></div>
            </div>
            <div class="ai-panel-title">BREAKDOWN DE SCORE (TRÍADE)</div>
            <div style="background:#0B1118; border:1px solid rgba(255,255,255,0.05); border-radius:6px; margin-bottom:16px;">
              ${breakdownHtml}
            </div>

            <div style="margin-top:16px;"></div>
            <div class="ai-panel-title">MINITIMELINE (HISTÓRICO) / KPI CARDS</div>
            <div class="ai-kpi-grid">
              <div class="ai-kpi">
                <div class="kpi-lbl" style="color:#00D2FF">APARIÇÕES</div>
                <div class="kpi-val" style="color:${asset.appearances>1?'#00D2FF':'#fff'}">🔥 ${asset.appearances}x</div>
              </div>
              <div class="ai-kpi">
                <div class="kpi-lbl">PRICE</div>
                <div class="kpi-val" style="color:#fff">${formatPriceDisplay(asset.price)}</div>
              </div>
              <div class="ai-kpi">
                <div class="kpi-lbl" style="color:#00D2FF">OI TREND</div>
                <div class="kpi-val" style="color:${asset.oi==='subindo'?'#00FF66':'#fff'}">${asset.oi.toUpperCase()}</div>
              </div>
              <div class="ai-kpi">
                <div class="kpi-lbl" style="color:#FF8800">LSR</div>
                <div class="kpi-val" style="color:${asset.lsr<0.8?'#00FF66':'#fff'}">${asset.lsr}</div>
              </div>
              <div class="ai-kpi">
                <div class="kpi-lbl" style="color:#00FF66">T/MIN</div>
                <div class="kpi-val" style="color:${asset.tpm>=1000?'#00FF66':'#fff'}">${tpmLabel}</div>
              </div>
              <div class="ai-kpi">
                <div class="kpi-lbl" style="color:#B200FF">FUNDING</div>
                <div class="kpi-val" style="color:${asset.fr<0?'#00FF66':'#fff'}">${asset.fr}</div>
              </div>
            </div>
          </div>

          <div class="ai-col-right">
            <div class="ai-panel-title">SINAIS ATIVOS (SIGNAL ENGINE)</div>
            <div class="ai-signals-list">
              ${signalsHtml || '<div style="color:var(--dim);font-size:11px;padding:10px;border:1px dashed rgba(255,255,255,0.1);border-radius:6px;text-align:center;">Aguardando alinhamento de momentum...</div>'}
            </div>
            ${opBoxHtml}
          </div>
        </div>
      </div>`;
  }).join('');

  grid.innerHTML = rows;
}

// ============================================================
// RENDER BLOCO B — Gatilhos Técnicos
// ============================================================
let _techBlockDone = false;
function renderTechBlock() {
  if (_techBlockDone) return;
  const grid = document.getElementById('tech-grid');
  if (!grid) return;
  _techBlockDone = true;
  const items = [
    { label: 'MÉDIA MÓVEL 99',  title: 'Régua de Atraso',         desc: 'Se o preço já passou muito da MA99, você está atrasado. Risco de entrada elevado.' },
    { label: 'TRENDLINES',      title: 'Acumulações & Diagonais', desc: 'Marque os rompimentos de trendline. O estouro geralmente antecipa a média móvel.' },
    { label: 'RSI BREAKOUT',    title: 'Confirmação de Força',     desc: 'RSI cruzando 65–70 enquanto médias ainda apontam para baixo = gatilho de alta.' },
  ];
  grid.innerHTML = items.map(i => `
    <div class="tech-item">
      <div class="tech-item-label">${i.label}</div>
      <div class="tech-item-title">${i.title}</div>
      <div class="tech-item-desc">${i.desc}</div>
    </div>`).join('');
}

// ============================================================
// RENDER BLOCO C — Liquidez
// ============================================================
function renderLiquidityBlock() {
  const grid = document.getElementById('liquidity-grid');
  if (!grid) return;

  const allForLiq = [
    ...state.tabs.toptrader.assets,
    ...state.tabs.acumulacao.assets,
    ...state.tabs.f1rapido.assets,
    ...state.assets,
  ];
  const seen = new Set();
  const deduped = allForLiq.filter(a => seen.has(a.symbol) ? false : (seen.add(a.symbol), true));
  const topByTpm = [...deduped].sort((a, b) => b.tpm - a.tpm).slice(0, 6);

  const gaugeHtml = topByTpm.length ? topByTpm.map(a => {
    const pct   = Math.min((a.tpm / 1500) * 100, 100).toFixed(1);
    const color = a.tpm >= 1000 ? '#00FF88' : a.tpm >= 700 ? '#FFB800' : '#666680';
    const tag   = a.tpm >= 1000 ? 'FORTONA' : a.tpm >= 700 ? 'AQUECENDO' : 'FRIO';
    const label = a.tpm >= 1000 ? (a.tpm / 1000).toFixed(1) + 'K' : a.tpm;
    return `
      <div class="tpm-item">
        <div class="tpm-label-row">
          <span style="font-size:12px;font-weight:700">${a.symbol}</span>
          <span style="font-size:11px;color:${color};font-weight:700">${label}/min · ${tag}</span>
        </div>
        <div class="tpm-bar-bg"><div class="tpm-bar-fill" style="width:${pct}%;background:${color};"></div></div>
      </div>`;
  }).join('') : '<p style="color:var(--dim);font-size:12px;padding:10px 0">Sem ativos carregados.</p>';

  const zones = [
    { label: 'Zona Longs',  price: 'Acima do preço',     color: '#E10600', pct: 75 },
    { label: 'Zona Shorts', price: 'Abaixo do preço',    color: '#00FF88', pct: 60 },
    { label: 'Cluster',     price: 'Suporte/Resistência',color: '#FFB800', pct: 45 },
  ];

  const zonesHtml = zones.map(z => `
    <div class="liq-zone">
      <div class="liq-zone-type" style="color:${z.color}">${z.label}</div>
      <div class="liq-zone-bar"><div class="liq-zone-fill" style="width:${z.pct}%;background:${z.color}"></div></div>
      <div class="liq-zone-label">${z.price}</div>
    </div>`).join('');

  grid.innerHTML = `
    <div class="liq-card">
      <div class="liq-title">TRADES POR MINUTO — VELOCIDADE</div>
      <div class="tpm-gauge">${gaugeHtml}</div>
    </div>
    <div class="liq-card">
      <div class="liq-title">MAPA DE LIQUIDAÇÃO — CLUSTERS</div>
      <div class="liq-zones">${zonesHtml}</div>
      <p style="font-size:10px;color:var(--dim);margin-top:10px;line-height:1.4;">Clusters são alvos naturais do preço. Mapeie faixas de aglomeração de ordens.</p>
    </div>`;
}

// ============================================================
// RENDER BLOCO D — Termômetro de Altseason
// ============================================================
function renderSentimentBlock() {
  var grid = document.getElementById('sentiment-grid');
  if (!grid) return;

  var btcChange  = state.sentiment.btcChange;
  var btcdChange = state.sentiment.btcdChange;

  // Recupera preço atual dos assets (populado pelo WebSocket)
  var btcAsset  = state.assets.find(function(a) { return a.symbol === 'BTCUSDT'; });
  var btcdAsset = state.assets.find(function(a) { return a.symbol === 'BTCDOMUSDT'; });
  var btcPrice  = btcAsset  ? btcAsset.price  : 0;
  var btcdPrice = btcdAsset ? btcdAsset.price : 0;

  // ── Lógica do índice de oportunidade ──────────────────────
  var barPct, barColor, statusText, diagText, glowStyle;
  var hasData = btcChange !== null && btcdChange !== null;

  if (hasData) {
    if (btcChange > 0 && btcdChange < 0) {
      barPct     = 95;
      barColor   = '#00FF88';
      statusText = 'ALTSEASON ATIVA — FOCO EM ALTS';
      diagText   = 'BTC sobe e perde dominância: capital fluindo para Altcoins.';
      glowStyle  = 'box-shadow:0 0 18px #00FF88,0 0 36px #00FF8833;';
    } else if (btcChange < 0 && btcdChange > 0) {
      barPct     = 10;
      barColor   = '#E10600';
      statusText = 'FLIGHT TO SAFETY — SAIA DAS ALTS';
      diagText   = 'BTC cai e ganha dominância: mercado foge para USDT.';
      glowStyle  = '';
    } else if (btcChange > 0 && btcdChange > 0) {
      barPct     = 60;
      barColor   = '#00D2FF';
      statusText = 'BTC DOMINANDO — ALTS LENTAS';
      diagText   = 'BTC sobe e absorve capital: atenção concentrada no BTC.';
      glowStyle  = '';
    } else if (btcChange < 0 && btcdChange < 0) {
      barPct     = 30;
      barColor   = '#FFB800';
      statusText = 'MERCADO EM CORRECAO — CAUTELA';
      diagText   = 'Pressão de venda generalizada. Aguarde confirmação.';
      glowStyle  = '';
    } else {
      barPct     = 50;
      barColor   = '#666680';
      statusText = 'MERCADO NEUTRO';
      diagText   = 'Sem sinal direcional claro no momento.';
      glowStyle  = '';
    }
  } else {
    barPct     = 50;
    barColor   = '#FFB800';
    statusText = 'AGUARDANDO DADOS';
    diagText   = 'Importe JSON com BTCUSDT e BTCDOMUSDT para ativar.';
    glowStyle  = '';
  }

  // ── Formatação dos cards de referência ───────────────────
  var fmtPrice = function(p) {
    if (!p || p <= 0) return '—';
    if (p >= 1000) return '$' + p.toLocaleString('en-US', {maximumFractionDigits: 0});
    return '$' + p.toFixed(2);
  };
  var fmtChg = function(v) {
    if (v === null) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  };
  var btcChgStr  = fmtChg(btcChange);
  var btcdChgStr = fmtChg(btcdChange);
  var btcChgClr  = btcChange  === null ? '#666680' : btcChange  > 0 ? '#00FF88' : '#E10600';
  var btcdChgClr = btcdChange === null ? '#666680' : btcdChange < 0 ? '#00FF88' : '#E10600';

  // ── HTML ──────────────────────────────────────────────────
  var html =
    // Cards de referência
    '<div class="alt-ref-cards">'
    + '<div class="alt-ref-card">'
    + '<div class="alt-ref-label">BTC PRICE</div>'
    + '<div class="alt-ref-price" data-symbol="BTCUSDT" data-format="usd">'
    + (btcPrice > 0 ? fmtPrice(btcPrice) : '— LIVE') + '</div>'
    + '<div class="alt-ref-chg" style="color:' + btcChgClr + '">' + btcChgStr + ' 1D</div>'
    + '</div>'
    + '<div class="alt-ref-card">'
    + '<div class="alt-ref-label">BTC DOMINANCIA</div>'
    + '<div class="alt-ref-price" data-symbol="BTCDOMUSDT" data-format="pct">'
    + (btcdPrice > 0 ? btcdPrice.toFixed(2) + '%' : '— LIVE') + '</div>'
    + '<div class="alt-ref-chg" style="color:' + btcdChgClr + '">' + btcdChgStr + ' 1D</div>'
    + '</div>'
    + '</div>'

    // Barra central
    + '<div class="alt-index-wrap">'
    + '<div class="alt-index-header">'
    + '<span class="alt-index-label">INDICE DE OPORTUNIDADE EM ALTS</span>'
    + '<span class="alt-index-pct" style="color:' + barColor + ';text-shadow:0 0 12px ' + barColor + '88">'
    + barPct + '%</span>'
    + '</div>'
    + '<div class="alt-bar-track">'
    + '<div class="alt-bar-fill" style="width:' + barPct + '%;background:' + barColor + ';' + glowStyle + '"></div>'
    + '</div>'
    + '<div class="alt-bar-scale">'
    + '<span style="color:#E10600;font-size:9px;font-weight:700">RISCO</span>'
    + '<span style="color:#666680;font-size:9px;font-weight:700">NEUTRO</span>'
    + '<span style="color:#00FF88;font-size:9px;font-weight:700">ALTS</span>'
    + '</div>'
    + '<div class="alt-status-text" style="color:' + barColor + ';text-shadow:0 0 14px ' + barColor + (barColor === '#00FF88' ? '99' : '44') + '">'
    + statusText + '</div>'
    + '<div class="alt-diag-text">' + diagText + '</div>'
    + '</div>';

  // ── Matriz Smart Money BTC x BTC.D ──────────────────────
  var macroState = getMacroState();
  var matrixStates = {
    ALTSEASON:       { label: 'ALTSEASON SETUP',         sub: 'Migração de capital para Alts',         color: '#00FF88', icon: '🟢' },
    FLIGHT_SAFETY:   { label: 'FLIGHT TO SAFETY',        sub: 'Capital fugindo para BTC / USDT',       color: '#FF4422', icon: '🔴' },
    CAPITULATION:    { label: 'CAPITULAÇÃO GERAL',        sub: 'Pânico no mercado — cautela máxima',    color: '#CC0000', icon: '🩸' },
    INSTITUTIONAL_BTC: { label: 'INSTITUCIONAL NO BTC',  sub: 'BTC sugando liquidez das Alts',        color: '#00D2FF', icon: '🔵' },
    ALTS_GAINING:    { label: 'ALTS GANHANDO TRAÇÃO',    sub: 'Setup de mola — BTC lateral',           color: '#00FFFF', icon: '🔷' },
    BTC_ABSORBING:   { label: 'BTC ABSORVENDO',           sub: 'Alts perdendo força — rotação para BTC', color: '#888899', icon: '⬜' },
    NEUTRAL:         { label: 'MERCADO NEUTRO',           sub: 'Sem sinal direcional claro',            color: '#666680', icon: '⬜' },
    AWAITING:        { label: 'AGUARDANDO DADOS',         sub: 'Importe JSON com BTCUSDT e BTCDOMUSDT', color: '#FFB800', icon: '⏳' },
  };
  var ms = matrixStates[macroState] || matrixStates.NEUTRAL;

  var btcDir  = btcChange  === null ? '—' : btcChange  >  1.5 ? 'BTC 🔺' : btcChange  < -1.5 ? 'BTC 🔻' : 'BTC →';
  var btcdDir = btcdChange === null ? '—' : btcdChange >  0.3 ? 'BTC.D 🔺' : btcdChange < -0.3 ? 'BTC.D 🔻' : 'BTC.D →';

  html +=
    '<div class="alt-matrix-section">'
    + '<div class="alt-matrix-title">MATRIZ SMART MONEY — BTC × BTC.D</div>'
    + '<div class="alt-matrix-ref-row">'
    + '<span class="alt-matrix-ref alt-matrix-ref-sym" style="color:' + (btcChange > 0 ? '#00FF88' : btcChange < 0 ? '#E10600' : '#666680') + '">' + btcDir + '</span>'
    + '<span class="alt-matrix-ref">×</span>'
    + '<span class="alt-matrix-ref alt-matrix-ref-sym" style="color:' + (btcdChange < 0 ? '#00FF88' : btcdChange > 0 ? '#E10600' : '#666680') + '">' + btcdDir + '</span>'
    + (btcChange !== null ? '<span class="alt-matrix-ref-chg" style="color:' + (btcChange > 0 ? '#00FF88' : '#E10600') + '">' + (btcChange > 0 ? '+' : '') + btcChange.toFixed(2) + '%</span>' : '')
    + (btcdChange !== null ? '<span class="alt-matrix-ref-chg" style="color:' + (btcdChange < 0 ? '#00FF88' : '#E10600') + '">' + (btcdChange > 0 ? '+' : '') + btcdChange.toFixed(2) + '%</span>' : '')
    + '</div>'
    + '<div class="alt-matrix-diag" style="border-color:' + ms.color + '22;background:' + ms.color + '0d">'
    + '<div class="alt-matrix-state" style="color:' + ms.color + ';text-shadow:0 0 12px ' + ms.color + '66">' + ms.icon + ' ' + ms.label + '</div>'
    + '<div class="alt-matrix-sub">' + ms.sub + '</div>'
    + '</div>'
    + '</div>';

  grid.innerHTML = html;
}

// ============================================================
// KPI BAR — Resumo global no topo
// ============================================================
function renderKpiBar() {
  var el = document.getElementById('kpi-bar');
  if (!el) return;

  var all = [];
  var seen = new Set();
  TAB_KEYS.concat([]).forEach(function(k) {
    (state.tabs[k] ? state.tabs[k].assets : []).forEach(function(a) {
      if (!seen.has(a.symbol)) { seen.add(a.symbol); all.push(a); }
    });
  });
  state.assets.forEach(function(a) {
    if (!seen.has(a.symbol)) { seen.add(a.symbol); all.push(a); }
  });

  if (!all.length) { el.classList.add('kpi-bar-hidden'); return; }
  el.classList.remove('kpi-bar-hidden');

  // Maior EXP 4H
  var maxExp = null, maxExpSym = '—';
  all.forEach(function(a) {
    var v = (a.raw && extractLatest(a.raw['exp_btc:4h'])) != null
          ? parseFloat(extractLatest(a.raw['exp_btc:4h'])) : (a.exp || 0);
    if (maxExp === null || v > maxExp) { maxExp = v; maxExpSym = a.symbol; }
  });

  // Trades/M Max
  var maxTpm = 0, maxTpmSym = '—';
  all.forEach(function(a) {
    if (a.tpm > maxTpm) { maxTpm = a.tpm; maxTpmSym = a.symbol; }
  });

  // BTC RSI 1H
  var btcRsi1h = null;
  var btcA = all.find(function(a) { return a.symbol === 'BTCUSDT'; });
  if (btcA) {
    btcRsi1h = btcA.raw ? parseFloat(extractLatest(btcA.raw['rsi:1h'])) : null;
    if (isNaN(btcRsi1h) || btcRsi1h === null) btcRsi1h = btcA.rsi || null;
  }

  var expColor  = maxExp > 5 ? '#00FF88' : maxExp > 0 ? '#FFB800' : '#E10600';
  var tpmColor  = maxTpm >= 1000 ? '#00FF88' : maxTpm >= 700 ? '#FFB800' : '#666680';
  var rsiColor  = btcRsi1h > 65 ? '#FFB800' : btcRsi1h > 50 ? '#00FF88' : '#E10600';
  var rsiLabel  = btcRsi1h !== null ? (btcRsi1h > 70 ? 'OVERBOUGHT' : btcRsi1h > 55 ? 'BULLISH' : btcRsi1h > 45 ? 'NEUTRO' : 'BEARISH') : '—';
  var fmtTpm    = function(v) { return v >= 1000 ? (v/1000).toFixed(1)+'K' : String(v); };

  el.innerHTML =
    '<div class="kpi-stat">'
    + '<div class="kpi-stat-lbl">MAIOR EXP 4H</div>'
    + '<div class="kpi-stat-val" style="color:' + expColor + ';text-shadow:0 0 10px ' + expColor + '66">'
    + (maxExp !== null ? (maxExp > 0 ? '+' : '') + parseFloat(maxExp).toFixed(1) : '—') + '</div>'
    + '<div class="kpi-stat-sub">' + maxExpSym + '</div>'
    + '</div>'
    + '<div class="kpi-stat-sep"></div>'
    + '<div class="kpi-stat">'
    + '<div class="kpi-stat-lbl">TRADES/M MAX</div>'
    + '<div class="kpi-stat-val" style="color:' + tpmColor + ';text-shadow:0 0 10px ' + tpmColor + '66">' + fmtTpm(maxTpm) + '</div>'
    + '<div class="kpi-stat-sub">' + maxTpmSym + '</div>'
    + '</div>'
    + '<div class="kpi-stat-sep"></div>'
    + '<div class="kpi-stat">'
    + '<div class="kpi-stat-lbl">BTC RSI 1H</div>'
    + '<div class="kpi-stat-val" style="color:' + rsiColor + ';text-shadow:0 0 10px ' + rsiColor + '66">'
    + (btcRsi1h !== null ? parseFloat(btcRsi1h).toFixed(1) : '—') + '</div>'
    + '<div class="kpi-stat-sub">' + rsiLabel + '</div>'
    + '</div>';
}

// ============================================================
// MACRO ALERT BANNER — Phoenix style
// ============================================================
function renderMacroAlert() {
  var el = document.getElementById('macro-alert');
  if (!el) return;
  var macroState = getMacroState();

  var cfg = {
    ALTSEASON:         { cls: 'mab-success',  icon: '🟢', title: 'ALTSEASON ATIVA',       desc: 'BTC↑ BTC.D↓ — Capital migrando para Alts. Score amplificado +20%.',    tag: 'OPORTUNIDADE MÁXIMA' },
    FLIGHT_SAFETY:     { cls: 'mab-danger',   icon: '🔴', title: 'FLIGHT TO SAFETY',      desc: 'BTC↓ BTC.D↑ — Capital fugindo para BTC/USDT. Evite entradas em Alts.',  tag: 'RISCO ALTO' },
    CAPITULATION:      { cls: 'mab-critical', icon: '🩸', title: 'CAPITULAÇÃO GERAL',     desc: 'BTC↓ BTC.D↓ — Pânico generalizado. Fique fora do mercado.',              tag: 'RISCO EXTREMO' },
    INSTITUTIONAL_BTC: { cls: 'mab-info',     icon: '🔵', title: 'INSTITUCIONAL NO BTC',  desc: 'BTC↑ BTC.D↑ — Liquidez sendo sugada para BTC. Alts com pressão.',       tag: 'FOCO NO BTC' },
    ALTS_GAINING:      { cls: 'mab-success',  icon: '🔷', title: 'ALTS GANHANDO TRAÇÃO',  desc: 'BTC→ BTC.D↓ — Setup de mola. Alts acumulando força com BTC lateral.',   tag: 'SETUP FORMANDO' },
    BTC_ABSORBING:     { cls: 'mab-neutral',  icon: '⬜', title: 'BTC ABSORVENDO',         desc: 'BTC→ BTC.D↑ — Rotação defensiva. Alts perdendo fôlego gradualmente.',   tag: 'CAUTELA' },
    NEUTRAL:           { cls: 'mab-neutral',  icon: '⬜', title: 'MERCADO NEUTRO',          desc: 'Sem sinal direcional claro. Aguarde confirmação de tendência.',           tag: 'NEUTRO' },
  };

  var c = cfg[macroState];
  if (!c) { el.className = 'macro-alert hidden'; el.innerHTML = ''; return; }

  el.className = 'macro-alert macro-alert-banner ' + c.cls;
  el.innerHTML =
    '<div class="mab-icon">' + c.icon + '</div>'
    + '<div class="mab-body">'
    + '<div class="mab-title">' + c.title + '</div>'
    + '<div class="mab-desc">' + c.desc + '</div>'
    + '</div>'
    + '<div class="mab-tag">' + c.tag + '</div>';
}

// ============================================================
// RENDER ABA SENTIMENTO DO MERCADO
// ============================================================
function renderSentimentoTab() {
  var el = document.getElementById('sentimento-view-body');
  if (!el) return;

  var bc   = state.sentiment.btcChange;
  var dc   = state.sentiment.btcdChange;
  var uc   = state.sentiment.usdtdChange;
  var hasData = bc !== null && dc !== null;

  var sentAssets = state.tabs.sentimento ? state.tabs.sentimento.assets : [];
  var btcA  = sentAssets.find(function(a) { return a.symbol === 'BTCUSDT'; });
  var btcdA = sentAssets.find(function(a) { return a.symbol === 'BTCDOMUSDT'; });
  var usdtdA= sentAssets.find(function(a) {
    return a.symbol === 'USDTDOMUSDT' || a.symbol === 'USDTDOM' || a.symbol === 'USDT.D';
  });

  if (!hasData && !sentAssets.length) {
    el.innerHTML = '<div class="sent-tab-empty">'
      + '<div class="sent-tab-empty-icon">🌡️</div>'
      + '<div class="sent-tab-empty-title">AGUARDANDO DADOS DE LASTRO</div>'
      + '<div class="sent-tab-empty-desc">Cole o JSON com BTCUSDT, BTCDOMUSDT e USDTDOMUSDT e clique em SINCRONIZAR.<br>Estes dados ancoram a análise macro de todas as abas.</div>'
      + '</div>';
    return;
  }

  // ── Thermometer logic (same as renderSentimentBlock) ─────
  var barPct, barColor, statusText, diagText, glowStyle;
  if (hasData) {
    if (bc > 0 && dc < 0)       { barPct=95; barColor='#00FF88'; statusText='ALTSEASON ATIVA — FOCO EM ALTS'; diagText='BTC sobe e perde dominância: capital fluindo para Altcoins.'; glowStyle='box-shadow:0 0 24px #00FF88,0 0 48px #00FF8822;'; }
    else if (bc < 0 && dc > 0)  { barPct=10; barColor='#E10600'; statusText='FLIGHT TO SAFETY — SAIA DAS ALTS'; diagText='BTC cai e ganha dominância: mercado foge para USDT.'; glowStyle=''; }
    else if (bc > 0 && dc > 0)  { barPct=60; barColor='#00D2FF'; statusText='BTC DOMINANDO — ALTS LENTAS'; diagText='BTC sobe e absorve capital: atenção concentrada no BTC.'; glowStyle=''; }
    else if (bc < 0 && dc < 0)  { barPct=30; barColor='#FFB800'; statusText='MERCADO EM CORRECAO — CAUTELA'; diagText='Pressão de venda generalizada. Aguarde confirmação.'; glowStyle=''; }
    else                         { barPct=50; barColor='#666680'; statusText='MERCADO NEUTRO'; diagText='Sem sinal direcional claro.'; glowStyle=''; }
  } else {
    barPct=50; barColor='#FFB800'; statusText='AGUARDANDO DADOS'; diagText='Importe JSON com BTCUSDT e BTCDOMUSDT para ativar.'; glowStyle='';
  }

  // ── Matrix state ──────────────────────────────────────────
  var macroState = getMacroState();
  var matrixStates = {
    ALTSEASON:         { label:'ALTSEASON SETUP',       sub:'Migração de capital para Alts',           color:'#00FF88', icon:'🟢' },
    FLIGHT_SAFETY:     { label:'FLIGHT TO SAFETY',      sub:'Capital fugindo para BTC / USDT',         color:'#FF4422', icon:'🔴' },
    CAPITULATION:      { label:'CAPITULAÇÃO GERAL',     sub:'Pânico no mercado — cautela máxima',      color:'#CC0000', icon:'🩸' },
    INSTITUTIONAL_BTC: { label:'INSTITUCIONAL NO BTC',  sub:'BTC sugando liquidez das Alts',           color:'#00D2FF', icon:'🔵' },
    ALTS_GAINING:      { label:'ALTS GANHANDO TRAÇÃO',  sub:'Setup de mola — BTC lateral',             color:'#00FFFF', icon:'🔷' },
    BTC_ABSORBING:     { label:'BTC ABSORVENDO',        sub:'Alts perdendo força — rotação para BTC',  color:'#888899', icon:'⬜' },
    NEUTRAL:           { label:'MERCADO NEUTRO',        sub:'Sem sinal direcional claro',              color:'#666680', icon:'⬜' },
    AWAITING:          { label:'AGUARDANDO DADOS',      sub:'Importe JSON com BTCUSDT e BTCDOMUSDT',   color:'#FFB800', icon:'⏳' },
  };
  var ms = matrixStates[macroState] || matrixStates.NEUTRAL;

  // ── Formatação ────────────────────────────────────────────
  var fmtPrc = function(p) { if (!p||p<=0) return '—'; return p>=1000?'$'+p.toLocaleString('en-US',{maximumFractionDigits:0}):'$'+p.toFixed(2); };
  var fmtChg = function(v) { if (v===null||v===undefined) return '—'; return (v>0?'+':'')+parseFloat(v).toFixed(2)+'%'; };
  var chgClr = function(v,invert) { if (v===null) return '#666680'; if(invert) return v<0?'#00FF88':'#E10600'; return v>0?'#00FF88':'#E10600'; };

  var btcPrice  = btcA  ? btcA.price  : 0;
  var btcdPrice = btcdA ? btcdA.price : 0;
  var usdtdPrice= usdtdA? usdtdA.price: 0;

  var btcDir  = bc===null ? '—' : bc>1.5 ? 'BTC 🔺' : bc<-1.5 ? 'BTC 🔻' : 'BTC →';
  var btcdDir = dc===null ? '—' : dc>0.3 ? 'BTC.D 🔺' : dc<-0.3 ? 'BTC.D 🔻' : 'BTC.D →';

  el.innerHTML =
    // ── REF CARDS ──────────────────────────────────────────
    '<div class="stab-ref-row">'
    + _sentRefCard('BTC PRICE',       fmtPrc(btcPrice), fmtChg(bc), chgClr(bc,false), 'BTCUSDT', 'usd')
    + _sentRefCard('BTC DOMINÂNCIA',  btcdPrice>0?btcdPrice.toFixed(2)+'%':'—', fmtChg(dc), chgClr(dc,true),  'BTCDOMUSDT', 'pct')
    + _sentRefCard('USDT DOMINÂNCIA', usdtdPrice>0?usdtdPrice.toFixed(2)+'%':'—', fmtChg(uc), chgClr(uc,true), '', '')
    + '</div>'

    // ── BARÔMETRO ────────────────────────────────────────────
    + '<div class="stab-barometro card">'
    + '<div class="stab-bar-header">'
    + '<span class="stab-bar-label">BARÔMETRO DE EXPANSÃO EM ALTS</span>'
    + '<span class="stab-bar-pct" style="color:'+barColor+';text-shadow:0 0 16px '+barColor+'88">'+barPct+'%</span>'
    + '</div>'
    + '<div class="stab-bar-track"><div class="stab-bar-fill" style="width:'+barPct+'%;background:'+barColor+';'+glowStyle+'"></div></div>'
    + '<div class="stab-bar-scale">'
    + '<span style="color:#E10600;font-size:9px;font-weight:700">RISCO</span>'
    + '<span style="color:#666680;font-size:9px;font-weight:700">NEUTRO</span>'
    + '<span style="color:#00FF88;font-size:9px;font-weight:700">ALTS</span>'
    + '</div>'
    + '<div class="stab-status" style="color:'+barColor+';text-shadow:0 0 18px '+barColor+(barColor==='#00FF88'?'99':'44')+'">'+statusText+'</div>'
    + '<div class="stab-diag">'+diagText+'</div>'
    + '</div>'

    // ── MATRIZ SMART MONEY ────────────────────────────────────
    + '<div class="stab-matrix card">'
    + '<div class="stab-matrix-title">MATRIZ SMART MONEY — BTC × BTC.D</div>'
    + '<div class="stab-matrix-dirs">'
    + '<span style="color:'+chgClr(bc,false)+';font-family:var(--mono);font-size:18px;font-weight:900">'+btcDir+'</span>'
    + '<span style="color:var(--dim);font-size:14px;margin:0 8px">×</span>'
    + '<span style="color:'+chgClr(dc,true)+';font-family:var(--mono);font-size:18px;font-weight:900">'+btcdDir+'</span>'
    + (bc!==null?'<span style="font-family:var(--mono);font-size:12px;font-weight:700;color:'+chgClr(bc,false)+';background:rgba(255,255,255,0.05);border-radius:4px;padding:2px 8px;margin-left:10px">'+fmtChg(bc)+'</span>':'')
    + (dc!==null?'<span style="font-family:var(--mono);font-size:12px;font-weight:700;color:'+chgClr(dc,true)+';background:rgba(255,255,255,0.05);border-radius:4px;padding:2px 8px;margin-left:6px">'+fmtChg(dc)+'</span>':'')
    + '</div>'
    + '<div class="stab-matrix-diag" style="border-color:'+ms.color+'33;background:'+ms.color+'0a">'
    + '<div class="stab-matrix-icon">'+ms.icon+'</div>'
    + '<div>'
    + '<div class="stab-matrix-state" style="color:'+ms.color+';text-shadow:0 0 16px '+ms.color+'66">'+ms.label+'</div>'
    + '<div class="stab-matrix-sub">'+ms.sub+'</div>'
    + '</div>'
    + '</div>'
    + '</div>';
}

function _sentRefCard(label, price, chg, chgColor, sym, fmt) {
  var priceAttr = sym ? ' data-symbol="'+sym+'"' + (fmt?' data-format="'+fmt+'"':'') : '';
  return '<div class="stab-ref-card card">'
    + '<div class="stab-ref-label">'+label+'</div>'
    + '<div class="stab-ref-price"'+priceAttr+'>'+(sym?'— LIVE':price)+'</div>'
    + '<div class="stab-ref-chg" style="color:'+chgColor+'">'+chg+' 1D</div>'
    + '</div>';
}

// ============================================================
// JSON IMPORT — mapeamento inteligente de campos
// ============================================================

function mapField(obj, ...keys) {
  for (const k of keys) {
    const found = Object.keys(obj).find(
      key => key.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, '')
    );
    if (found !== undefined && obj[found] !== undefined && obj[found] !== null && obj[found] !== '') {
      return obj[found];
    }
  }
  return null;
}

function normalizeOI(val) {
  if (val === null || val === undefined) return 'neutro';
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    if (v.includes('sub') || v.includes('up') || v.includes('pos') || v.includes('high')) return 'subindo';
    if (v.includes('ca') || v.includes('down') || v.includes('neg') || v.includes('low')) return 'caindo';
    return 'neutro';
  }
  const n = parseFloat(val);
  if (!isNaN(n)) {
    if (n > 3) return 'subindo';
    if (n < -1) return 'caindo';
  }
  return 'neutro';
}

function normalizeMA99(val) {
  if (!val) return 'perto_acima';
  const v = String(val).toLowerCase();
  if (v.includes('muito') || v.includes('far') || v.includes('high') || v.includes('above')) return 'muito_acima';
  if (v.includes('abaixo') || v.includes('below') || v.includes('under')) return 'abaixo';
  return 'perto_acima';
}

function openJsonModal() {
  document.getElementById('modal-json').classList.remove('hidden');
  const fb = document.getElementById('json-feedback');
  fb.textContent = '';
  fb.className = 'json-feedback';
}

function clearJsonInput() {
  document.getElementById('json-input-area').value = '';
  const fb = document.getElementById('json-feedback');
  fb.textContent = '';
  fb.className = 'json-feedback';
}

// ============================================================
// PARSER CENTRAL — usado pelo modal manual E pelo auto-fetch
// ============================================================
function parseJsonText(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return null; }

  if (parsed && !Array.isArray(parsed) && (Array.isArray(parsed.assets) || parsed.macro || parsed.sentiment)) {
    const m = parsed.macro || parsed.sentiment || {};
    if (m.usdtd_trend !== undefined) state.sentiment.usdtdTrend = normalizeOI(m.usdtd_trend);
    if (m.btc_trend   !== undefined) state.sentiment.btcTrend   = normalizeOI(m.btc_trend);
    if (m.btcd_trend  !== undefined) state.sentiment.btcdTrend  = normalizeOI(m.btcd_trend);
    if (!Array.isArray(parsed.assets)) return null;
    parsed = parsed.assets;
  }

  const targetData = (parsed && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data))
    ? parsed.data : parsed;

  let list = [];
  if (Array.isArray(targetData)) {
    list = targetData.filter(item => typeof item === 'object' && item !== null);
  } else if (typeof targetData === 'object' && targetData !== null) {
    list = Object.entries(targetData)
      .filter(([, val]) => typeof val === 'object' && val !== null)
      .map(([key, val]) => ({ ...val, _keySymbol: key }));
  }
  if (!list.length) return null;

  const round    = (val, d) => parseFloat(parseFloat(val).toFixed(d));
  const parseBool = val => !!(val && (val === true || String(val).toLowerCase() === 'true' || val === 1 || String(val).toLowerCase() === 'sim'));

  const assets = list.map(item => {
    const symbol = String(mapField(item, 'symbol', 'ativo', 'ticker', 'asset', 'coin', 'par') || item._keySymbol || 'UNKNOWN').toUpperCase().trim();

    // Aceita campos escalares E séries temporais com sufixo :1m/:5m/:1D/:1h etc.
    const tpmRaw  = extractLatest(mapField(item, 'tpm', 'trades_minute1m', 'trades_minute5m', 'trades_minute1d', 'trades_minute', 'tradesminute', 'trades_per_minute', 'volume_trades'));
    const oiRaw   = extractLatest(mapField(item, 'oi_trend5m', 'oi_trend1m', 'oi_trend1d', 'oi_trend', 'oi', 'oi_change', 'open_interest', 'openinterest'));
    const lsrRaw  = extractLatest(mapField(item, 'lsr_trend1m', 'lsr_trend5m', 'lsr_trend1d', 'lsr_trend', 'lsr5m', 'lsr', 'long_short_ratio', 'longshortratio', 'ls_ratio', 'longshort'));
    const frRaw   = extractLatest(mapField(item, 'fr', 'funding', 'funding_rate', 'fundingrate', 'funding_r'));
    const rsiRaw  = extractLatest(mapField(item, 'rsi1m', 'rsi5m', 'rsi1d', 'rsi', 'rsi_14', 'rsi14', 'rsi_value'));
    const ma99Raw = extractLatest(mapField(item, 'ma99', 'ma_99', 'ma99_position', 'ma99pos'));
    const priceRaw= extractLatest(mapField(item, 'price', 'last_price', 'last', 'c'));
    const break1h = extractLatest(mapField(item, 'breakout_1h', 'trend_break_1h', 'break_1h'));
    const break4h = extractLatest(mapField(item, 'breakout_4h', 'trend_break_4h', 'break_4h'));
    const break1d = extractLatest(mapField(item, 'breakout_1d', 'trend_break_1d', 'break_1d', 'breakout_d', 'break_d'));
    const cvdRaw  = extractLatest(mapField(item, 'cvd', 'cvd_delta', 'volume_delta'));
    const liqRaw  = extractLatest(mapField(item, 'liq_dist', 'liq_cluster', 'liquidation', 'dist_liq', 'cluster_dist'));
    const rangeRaw = extractLatest(mapField(item, 'range_level', 'rangelevel', 'range'));
    const expRaw   = extractLatest(mapField(item, 'exp1m', 'exp5m', 'exp1d', 'exp', 'exponent', 'exp_trend'));
    const oiUsdRaw = extractLatest(mapField(item, 'oi1d', 'oi1m', 'oi1h', 'oi_usd', 'oi_dollar'));
    const appearances = symbol !== 'UNKNOWN' ? recordAssetAppearance(symbol) : 1;

    const a = {
      symbol, appearances, raw: item,
      price:    round(parseFloat(priceRaw) || 0,  4),
      tpm:      Math.round(parseFloat(tpmRaw)  || 0),
      oi:       normalizeOI(oiRaw),
      lsr:      round(parseFloat(lsrRaw)  || 1,   2),
      fr:       round(parseFloat(frRaw)   || 0,   6),
      rsi:      round(parseFloat(rsiRaw)  || 50,  2),
      ma99:     normalizeMA99(ma99Raw),
      cvd:      parseFloat(cvdRaw)  || null,
      liq_dist:    parseFloat(liqRaw)   || null,
      range_level: parseFloat(rangeRaw) || null,
      exp:         parseFloat(expRaw)   || 0,
      oi_usd:      parseFloat(oiUsdRaw) || null,
      break1h:  parseBool(break1h),
      break4h:  parseBool(break4h),
      break1d:  parseBool(break1d),
    };
    a._score = calculateSetupScore(a);
    return a;
  })
  .filter(a => a.symbol && a.symbol !== 'UNKNOWN' && a.symbol.length > 1 && a.symbol === a.symbol.toUpperCase())
  .sort((a, b) => b._score - a._score);

  // Derivar variação % de BTCUSDT e BTCDOMUSDT para o Termômetro de Altseason
  const btcA  = assets.find(a => a.symbol === 'BTCUSDT');
  const btcdA = assets.find(a => a.symbol === 'BTCDOMUSDT');
  if (btcA?.raw) {
    const pct = parseFloat(extractLatest(btcA.raw['price_change:1D']));
    if (!isNaN(pct)) state.sentiment.btcChange = pct;
  }
  if (btcdA?.raw) {
    const pct = parseFloat(extractLatest(btcdA.raw['price_change:1D']));
    if (!isNaN(pct)) state.sentiment.btcdChange = pct;
  }

  return assets.length ? assets : null;
}

// ============================================================
// SINCRONIZAÇÃO MANUAL (modal Importar JSON)
// ============================================================
function syncJson() {
  const raw = (document.getElementById('json-input-area').value || '').trim();
  const fb  = document.getElementById('json-feedback');

  if (!raw) {
    fb.textContent = '⚠ Cole um JSON antes de sincronizar.';
    fb.className = 'json-feedback error';
    return;
  }

  fb.textContent = '⚡ Processando...';
  fb.className = 'json-feedback';

  // setTimeout(0) libera o browser para repintar o feedback antes do trabalho pesado
  setTimeout(function () {
    // Reseta sentimento para permitir nova auto-detecção
    state.sentiment = { btcChange: null, btcdChange: null };

    const assets = parseJsonText(raw);
    renderSentimentBlock();

    if (!assets) {
      fb.textContent = '✗ JSON inválido ou nenhum ativo encontrado.';
      fb.className = 'json-feedback error';
      return;
    }

    state.assets = assets;
    // Also load into toptrader tab when coming from modal
    state.tabs.toptrader.assets = assets;
    const ttCount = document.getElementById('count-toptrader');
    if (ttCount) ttCount.textContent = assets.length + ' ativos';
    lastUpdateTime = Date.now();
    renderMacroAlert();
    TAB_KEYS.forEach(k => renderTabGrid(k));
    renderConvergencia();
    renderTechBlock();
    renderLiquidityBlock();

    fb.textContent = '✓ ' + assets.length + ' ativo(s) sincronizado(s)!';
    fb.className = 'json-feedback success';
    setTimeout(function () { closeModal('modal-json'); }, 1800);
  }, 0);
}

// ============================================================
// MODAIS
// ============================================================
function openAddAssetModal() {
  document.getElementById('modal-asset').classList.remove('hidden');
}

function saveAsset() {
  const symbol = (document.getElementById('a-symbol').value || '').trim().toUpperCase();
  if (!symbol) { alert('Informe o símbolo.'); return; }
  const tabKey = (document.getElementById('a-tab') || { value: 'toptrader' }).value || 'toptrader';
  const a = {
    symbol,
    oi:   document.getElementById('a-oi').value,
    lsr:  parseFloat(document.getElementById('a-lsr').value)  || 1,
    fr:   parseFloat(document.getElementById('a-fr').value)   || 0,
    rsi:  parseFloat(document.getElementById('a-rsi').value)  || 50,
    tpm:  parseFloat(document.getElementById('a-tpm').value)  || 0,
    ma99: document.getElementById('a-ma99').value,
    appearances: 1, exp: 0, oi_usd: null, cvd: null, liq_dist: null,
    break1h: false, break4h: false, break1d: false,
  };
  a._score = calculateSetupScore(a);
  state.tabs[tabKey].assets.push(a);
  ['a-symbol','a-lsr','a-fr','a-rsi','a-tpm'].forEach(id => document.getElementById(id).value = '');
  closeModal('modal-asset');
  renderTabGrid(tabKey);
  renderConvergencia();
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// Fecha modal clicando no backdrop
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal')) closeModal(e.target.id);
});

// ============================================================
// RELÓGIO + MONITOR DE LATÊNCIA
// ============================================================
let lastUpdateTime = Date.now();
const STALE_THRESHOLD = 45; // segundos

function updateClock() {
  const clockEl   = document.getElementById('clock');
  const pill      = document.getElementById('live-pill');
  const counterEl = document.getElementById('latency-counter');

  if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('pt-BR', { hour12: false });

  const elapsed = Math.floor((Date.now() - lastUpdateTime) / 1000);
  if (counterEl) counterEl.textContent = elapsed + 's';

  if (pill) {
    if (elapsed > STALE_THRESHOLD) {
      pill.classList.add('stale');
    } else {
      pill.classList.remove('stale');
    }
  }
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================
// RENDER ALL
// ============================================================
function renderAll() {
  renderKpiBar();
  renderSentimentBlock();
  renderMacroAlert();
  renderSentimentoTab();
  TAB_KEYS.forEach(k => renderTabGrid(k));
  renderConvergencia();
  renderTechBlock();
  renderLiquidityBlock();
}

renderAll();
switchMainTab('toptrader');
