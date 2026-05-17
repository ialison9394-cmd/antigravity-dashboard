// ============================================================
// F1 ANÁLISE — app.js
// ============================================================

// URL do arquivo gerado pelo GitHub Actions.
// Em produção (Netlify) usa o caminho relativo — funciona automaticamente.
const DATA_URL = './data/latest.json';

// ===== ESTADO =====
const state = {
  assets: [],
  macro: {
    btcdom: 58.2, usdtdom: 5.7, btcTrend: 'neutro',
    btc_24h: 0, btc_trend: 'neutro', btcd_trend: 'neutro',
    scenario: '', action: '', score: 50, score_color: 'yellow',
  },
  expandedCard: null
};

function toggleCard(symbol) {
  state.expandedCard = state.expandedCard === symbol ? null : symbol;
  renderRankingList();
}

// ============================================================
// SETUP SCORE E PERSISTÊNCIA
// ============================================================

function getAssetHistory(symbol) {
  const historyRaw = localStorage.getItem('phoenix_history_' + symbol);
  if (!historyRaw) return [];
  try {
    const history = JSON.parse(historyRaw);
    // Mantém o registro por 24 horas (para saber quantas horas seguidas ele sobreviveu)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    return history.filter(ts => ts > oneDayAgo);
  } catch(e) { return []; }
}

function recordAssetAppearance(symbol) {
  const history = getAssetHistory(symbol);
  const now = Date.now();
  if (history.length > 0) {
    const last = history[history.length - 1];
    // Cooldown de 1 HORA (3600000 ms) — Só conta 1 ponto por hora, independente de quantos JSONs mandar
    if (now - last < 3600000) {
      return history.length;
    }
  }
  history.push(now);
  localStorage.setItem('phoenix_history_' + symbol, JSON.stringify(history));
  return history.length;
}

function calculateSetupScore(a) {
  let s = 0;

  // Trades/min — peso 25%
  const tpm = parseFloat(a.tpm) || 0;
  if (tpm >= 1000) s += 25;
  else if (tpm >= 700) s += 15;

  // OI Trend — peso base
  if (a.oi === 'subindo') s += 15;
  else if (a.oi === 'neutro') s += 5;

  // LSR — O Toque de Especialista (Squeeze Atropelador)
  const lsr = parseFloat(a.lsr) || 1;
  if (lsr < 0.8 && a.oi === 'subindo') {
    s += 40; // Combo massivo: Injeção de capital com varejo preso em Short
  } else if (lsr < 0.8) {
    s += 20;
  } else if (lsr <= 1.2) {
    s += 10;
  }

  // Funding Rate — peso 15%
  const fr = parseFloat(a.fr) || 0;
  if (fr < -0.0001) s += 15;
  else if (Math.abs(fr) <= 0.0001) s += 7;

  // RSI Breakout — peso 15%
  const rsi = parseFloat(a.rsi) || 50;
  if (rsi >= 65 && rsi <= 75) s += 15;
  else if (rsi >= 40 && rsi < 65) s += 5;

  // Fator Frequência (Bônus de repetição)
  const app = a.appearances || 1;
  if (app === 2) s += 5;
  else if (app === 3) s += 10;
  else if (app >= 4) s += 15;

  // Trend Breakout MACRO (H1, H4, 1D) - Bônus altíssimo
  if (a.break1d || a.break4h || a.break1h) {
    s += 40; 
  }
  
  // MA99 Freio de Mão (Limitador de Euforia)
  if (a.ma99 === 'muito_acima') {
    s -= 45; // Desconto brutal para evitar armadilha de FOMO no varejo
  }

  return Math.min(Math.max(s, 0), 100); // Garante entre 0 e 100
}

function getScoreStatus(score) {
  if (score >= 86) return { label: 'Fortona em Expansão',       color: '#00FF88' };
  if (score >= 61) return { label: 'Gatilho F1 (Rompendo)',      color: '#00D2FF' };
  if (score >= 31) return { label: 'Mola Encolhida (Aquecendo)', color: '#FFB800' };
  return              { label: 'Monitorando (Reset/Frio)',       color: '#666680' };
}

function getTier(score) {
  if (score >= 86) return 'A';
  if (score >= 61) return 'B';
  if (score >= 31) return 'C';
  return 'D';
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

// Tração: gradiente de força nos TFs menores
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

// TF Mandatório baseado no RSI do BTC
function getMandatoryTF(rsi) {
  if (rsi == null) return null;
  const v = parseFloat(rsi);
  if (v < 30) return { tf: '1D',  desc: 'Pânico — aguardar base diária',  color: '#E10600' };
  if (v < 42) return { tf: '4H',  desc: 'Acumulação — confirmar em 4H',   color: '#FFB800' };
  if (v < 55) return { tf: '1H',  desc: 'Zona neutra — sinal em 1H',      color: '#666680' };
  if (v < 68) return { tf: '15m', desc: 'Momentum — aproveitar em 15min', color: '#00D2FF' };
  return             { tf: '5m',  desc: 'Overbought — scalp ou cautela',  color: '#FFB800' };
}

// TRÍADE ANTERIOR REMOVIDA — AGORA TUDO RODA NO RANKING UNIFICADO

// ============================================================
// RENDER RANKING (Geral) — com breakdown por componente
// ============================================================
function getComponentScores(a) {
  const tpm = parseFloat(a.tpm) || 0;
  const lsr = parseFloat(a.lsr) || 1;
  const fr  = parseFloat(a.fr)  || 0;
  const rsi = parseFloat(a.rsi) || 50;

  const tpmScore = tpm >= 1000 ? 25 : tpm >= 700 ? 15 : 0;
  const oiScore  = a.oi === 'subindo' ? 25 : a.oi === 'neutro' ? 10 : 0;
  const lsrScore = lsr < 0.8 ? 20 : lsr <= 1.2 ? 10 : 0;
  const frScore  = fr < -0.0001 ? 15 : Math.abs(fr) <= 0.0001 ? 7 : 0;
  const rsiScore = rsi >= 65 && rsi <= 75 ? 15 : rsi >= 40 && rsi < 65 ? 5 : 0;

  return [
    { key: 'T/MIN',   val: tpm >= 1000 ? (tpm/1000).toFixed(1)+'K' : String(tpm), got: tpmScore, max: 25, label: tpm >= 1000 ? 'FORTONA' : tpm >= 700 ? 'AQUECENDO' : 'FRIO',   color: tpm >= 1000 ? '#00FF88' : tpm >= 700 ? '#FFB800' : '#666680' },
    { key: 'OI',      val: a.oi,                                                   got: oiScore,  max: 25, label: a.oi === 'subindo' ? 'CAPITAL ↑' : a.oi === 'neutro' ? 'NEUTRO' : 'SAINDO', color: a.oi === 'subindo' ? '#00FF88' : a.oi === 'neutro' ? '#FFB800' : '#E10600' },
    { key: 'LSR',     val: String(lsr),                                             got: lsrScore, max: 20, label: lsr < 0.8 ? 'SQUEEZE' : lsr > 2.0 ? 'LOTADO' : 'NEUTRO',  color: lsr < 0.8 ? '#00FF88' : lsr > 2.0 ? '#E10600' : '#00D2FF' },
    { key: 'FR',      val: String(fr),                                              got: frScore,  max: 15, label: fr < -0.0001 ? 'NEGATIVO ✓' : Math.abs(fr) <= 0.0001 ? 'NEUTRO' : 'CARO',  color: fr < -0.0001 ? '#00FF88' : Math.abs(fr) <= 0.0001 ? '#FFB800' : '#E10600' },
    { key: 'RSI',     val: String(rsi),                                             got: rsiScore, max: 15, label: rsi >= 65 && rsi <= 75 ? 'BREAKOUT' : rsi > 85 ? 'EXAUSTO' : rsi < 40 ? 'FRACO' : 'ACUMULO', color: rsi >= 65 && rsi <= 75 ? '#00FF88' : rsi > 85 || rsi < 40 ? '#E10600' : '#FFB800' },
  ];
}

function renderRankingList() {
  const grid    = document.getElementById('asset-grid');
  const countEl = document.getElementById('ranking-count');
  if (!grid) return;

  if (!state.assets.length) {
    grid.innerHTML = '<p class="ranking-empty" style="grid-column:1/-1">Importe um JSON para ver o ranking completo de todos os ativos.</p>';
    if (countEl) countEl.textContent = '0 ativos';
    return;
  }

  const sorted = [...state.assets].sort((a, b) => calculateSetupScore(b) - calculateSetupScore(a));

  // Limita o painel principal aos 30 ativos com os melhores Setups
  const displayLimit = 30;
  const displayRanking = sorted.slice(0, displayLimit);

  if (countEl) {
    if (sorted.length > displayLimit) {
      countEl.innerHTML = `<span style="color:#00FF88;">${sorted.length} PROCESSADOS</span> • EXIBINDO TOP ${displayRanking.length}`;
    } else {
      countEl.textContent = `${sorted.length} ativos`;
    }
  }

  const rows = displayRanking.map((asset, idx) => {
    const score      = calculateSetupScore(asset);
    const status     = getScoreStatus(score);
    const tier       = getTier(score);
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
    const tracaoData = calcTracao(asset);
    const arrancada  = isArrancada(asset);

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

    // MARKET PRESSURE MATRIX (Horizontal Multi-TF)
    let matrixHtml = '';
    if (asset.raw) {
      const tfs = ['1m', '5m', '15m', '30m', '1h', '4h'];
      let rowsHtml = '';
      tfs.forEach(tf => {
        const rsiRaw = asset.raw[`rsi:${tf}`];
        const tpmRaw = asset.raw[`trades_minute:${tf}`];
        const expRaw = asset.raw[`exp_btc:${tf}`];
        
        if (rsiRaw === undefined && tpmRaw === undefined && expRaw === undefined) return;
        
        const rsi = rsiRaw ? rsiRaw.toFixed(1) : '-';
        const tpm = tpmRaw ? tpmRaw : '-';
        const exp = expRaw ? expRaw.toFixed(2) : '-';
        
        let rColor = '#A0B0B9';
        if (rsi !== '-') {
          if (rsi > 70) rColor = '#FF8800';
          else if (rsi > 55) rColor = '#00FF66';
          else if (rsi < 40) rColor = '#FF0055';
        }

        let eColor = '#A0B0B9';
        if (exp !== '-') {
          if (exp > 5) eColor = '#00D2FF';
          else if (exp < -5) eColor = '#FF0055';
        }

        rowsHtml += `
          <div class="mt-row">
            <div style="color:var(--dim)">${tf}</div>
            <div style="color:${rColor};font-weight:700;">${rsi} ${rsi>70?'▲':''}</div>
            <div>${tpm}</div>
            <div style="color:${eColor};font-weight:700;">${exp>0?'+':''}${exp}</div>
          </div>
        `;
      });
      if (rowsHtml) {
        matrixHtml = `
          <div class="ai-panel-title">MARKET PRESSURE MATRIX (MULTI-TF)</div>
          <div class="matrix-table">
            <div class="mt-row mt-head">
              <div>TF</div><div>RSI</div><div>T/MIN</div><div>EXP BTC</div>
            </div>
            ${rowsHtml}
          </div>
        `;
      }
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
    const appText = asset.appearances > 1 ? `<span style="font-size:10px;color:#00D2FF;margin-left:12px;letter-spacing:1px;font-weight:700;">⚡ NO RADAR HÁ ${asset.appearances} HORAS</span>` : '';

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
            <div class="ti-symbol">${asset.symbol} ${selo1k}<span class="price-display" data-symbol="${asset.symbol}" style="font-size:10px; color:var(--dim); margin-left:6px;">$${formatPriceDisplay(asset.price)}</span></div>
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

        <div class="range-level-wrap">
          <span class="rl-label">MOLA</span>
          <div class="range-dots">${rlDots}</div>
          <span class="rl-num" style="color:${rlColor}">${rl}/5</span>
        </div>

        <div class="ti-metrics">
          <div class="ti-metric"><div class="ti-metric-lbl">OI</div><div class="ti-metric-val" style="color:${oiColor}">${oiLabel} ${asset.oi.toUpperCase()}</div></div>
          <div class="ti-metric"><div class="ti-metric-lbl">LSR</div><div class="ti-metric-val" style="color:${lsrColor}">${lsrDisplay}</div></div>
          <div class="ti-metric"><div class="ti-metric-lbl">FUNDING</div><div class="ti-metric-val" style="color:${frColor}">${frDisplay}</div></div>
          <div class="ti-metric"><div class="ti-metric-lbl">RSI</div><div class="ti-metric-val" style="color:${rsiColor}">${rsiDisplay}</div></div>
          <div class="ti-metric"><div class="ti-metric-lbl">T/MIN</div><div class="ti-metric-val" style="color:${tpmColor}">${tpmLabel}</div></div>
        </div>

        <div class="smart-badges">
          <span class="badge-tracao" style="color:${tracaoData.color};border-color:${tracaoData.color}44">TRAÇÃO ${tracaoData.label}</span>
          ${arrancada ? '<span class="badge-arrancada">⚡ ARRANCADA</span>' : ''}
        </div>

        <div class="ai-card-body" style="display:${bodyDisplay}; margin-top: 20px; padding-top: 16px; border-top: 1px dashed rgba(255,255,255,0.05); text-align:left; cursor:default;" onclick="event.stopPropagation()">
          <div class="ai-col-left">
            <div class="ai-panel-title">BREAKDOWN DE SCORE (TRÍADE)</div>
            <div style="background:#0B1118; border:1px solid rgba(255,255,255,0.05); border-radius:6px; margin-bottom:16px;">
              ${breakdownHtml}
            </div>

            ${matrixHtml}
            
            <div style="margin-top:16px;"></div>
            <div class="ai-panel-title">MINITIMELINE (HISTÓRICO) / KPI CARDS</div>
            <div class="ai-kpi-grid">
              <div class="ai-kpi">
                <div class="kpi-lbl" style="color:#00D2FF">SOBREVIVÊNCIA</div>
                <div class="kpi-val" style="color:${asset.appearances>1?'#00D2FF':'#fff'}">${asset.appearances}H</div>
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

  // PHOENIX: Trava Macro (Aviso no topo do ranking)
  const isHostil = state.macro.btcTrend === 'subindo_forte' || state.macro.usdtdom > 6;
  let hostilBanner = '';
  if (isHostil) {
    hostilBanner = `
      <div class="macro-hostil-banner" style="grid-column:1/-1">
        <strong style="color:#f85149;font-size:14px;letter-spacing:0.5px;">🔴 AMBIENTE MACRO HOSTIL</strong><br>
        Dominância em alerta de segurança. Risco elevado para novas posições em Altcoins. Evite entradas.
      </div>`;
  }

  grid.innerHTML = hostilBanner + rows;
}

// ============================================================
// RENDER BLOCO B — Gatilhos Técnicos
// ============================================================
function renderTechBlock() {
  const grid = document.getElementById('tech-grid');
  if (!grid) return;
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

  const topByTpm = [...state.assets].sort((a, b) => b.tpm - a.tpm).slice(0, 6);

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
// RENDER MACRO (Bloco D)
// ============================================================
function renderMacro() {
  const m = state.macro;

  // ── Cards existentes ──────────────────────────────────────
  const btcdomEl    = document.getElementById('val-btcdom');
  const usdtdomEl   = document.getElementById('val-usdtdom');
  const trendEl     = document.getElementById('trend-btcdom');
  const usdtTrendEl = document.getElementById('trend-usdtdom');

  if (btcdomEl)  btcdomEl.textContent  = m.btcdom ? `${m.btcdom}%` : '—';
  if (usdtdomEl) usdtdomEl.textContent = `${m.usdtdom}%`;

  // BTC.D trend: automático (do collector) tem prioridade sobre o manual
  if (trendEl) {
    if (m.btcd_trend && m.btcd_trend !== 'neutro' || m.scenario) {
      const btcdMap = {
        subindo: { text: '↑ BTC.D Subindo', color: '#00D2FF' },
        caindo:  { text: '↓ BTC.D Caindo',  color: '#00FF88' },
        neutro:  { text: '→ BTC.D Neutro',  color: '#FFB800' },
      };
      const td = btcdMap[m.btcd_trend] || btcdMap.neutro;
      trendEl.textContent = td.text;
      trendEl.style.color = td.color;
    } else {
      const manualMap = {
        caindo:        { text: '↓ Altseason Favorável', color: '#00FF88' },
        neutro:        { text: '→ Neutro',              color: '#FFB800' },
        subindo:       { text: '↑ BTC Acumulando',      color: '#00D2FF' },
        subindo_forte: { text: '↑↑ Alts em Risco!',     color: '#E10600' },
      };
      const t = manualMap[m.btcTrend] || manualMap.neutro;
      trendEl.textContent = t.text;
      trendEl.style.color = t.color;
    }
  }

  if (usdtTrendEl) {
    usdtTrendEl.textContent = m.usdtdom > 6 ? '↑ Fuga p/ segurança' : m.usdtdom < 4 ? '↓ Risco ligado' : '→ Neutro';
    usdtTrendEl.style.color = m.usdtdom > 6 ? '#E10600' : '#00FF88';
  }

  // ── Barra de Macro Score (Matriz de Correlação) ───────────
  const row = document.getElementById('macro-scenario-row');
  if (!row) return;

  if (!m.scenario) { row.innerHTML = ''; return; }

  const colorMap = { green: '#00FF88', yellow: '#FFB800', red: '#E10600' };
  const barColor = colorMap[m.score_color] || '#FFB800';
  const btcDir   = m.btc_trend  === 'subindo' ? '↑' : m.btc_trend  === 'caindo' ? '↓' : '→';
  const btcdDir  = m.btcd_trend === 'subindo' ? '↑' : m.btcd_trend === 'caindo' ? '↓' : '→';
  const sign     = m.btc_24h >= 0 ? '+' : '';

  // TF Mandatório — lê RSI do BTCUSDT carregado nos ativos
  const btcAsset = state.assets.find(a => a.symbol === 'BTCUSDT');
  const mandTF   = getMandatoryTF(btcAsset ? btcAsset.rsi : null);
  const tfHtml   = mandTF ? `
    <div class="macro-tf-row">
      <span class="macro-tf-eyebrow">TF MANDATÓRIO</span>
      <span class="macro-tf-badge" style="color:${mandTF.color};border-color:${mandTF.color}55">${mandTF.tf}</span>
      <span class="macro-tf-desc">${mandTF.desc}</span>
      ${btcAsset ? `<span class="macro-badge">BTC RSI ${btcAsset.rsi}</span>` : ''}
    </div>` : '';

  row.innerHTML = `
    <div class="macro-divider"></div>
    <div class="macro-score-header">
      <div>
        <div class="macro-score-eyebrow">MATRIZ BTC × BTC.D</div>
        <div class="macro-score-scenario" style="color:${barColor}">${m.scenario}</div>
      </div>
      <div class="macro-score-badge" style="border-color:${barColor};color:${barColor}">${m.score}</div>
    </div>
    <div class="macro-score-track">
      <div class="macro-score-fill" style="width:${m.score}%;background:${barColor};box-shadow:0 0 10px ${barColor}55;"></div>
    </div>
    <div class="macro-score-footer">
      <span class="macro-action">${m.action}</span>
      <span class="macro-badge">BTC ${btcDir} ${sign}${m.btc_24h}%</span>
      <span class="macro-badge">BTC.D ${btcdDir}</span>
    </div>
    ${tfHtml}`;
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

  // Formato novo: { macro: {...}, assets: [...] }
  if (parsed && Array.isArray(parsed.assets)) {
    if (parsed.macro && typeof parsed.macro === 'object') {
      const m = parsed.macro;
      if (m.btcdom      !== undefined) state.macro.btcdom      = m.btcdom;
      if (m.btc_24h     !== undefined) state.macro.btc_24h     = m.btc_24h;
      if (m.btc_trend   !== undefined) state.macro.btc_trend   = m.btc_trend;
      if (m.btcd_trend  !== undefined) state.macro.btcd_trend  = m.btcd_trend;
      if (m.scenario    !== undefined) state.macro.scenario    = m.scenario;
      if (m.action      !== undefined) state.macro.action      = m.action;
      if (m.score       !== undefined) state.macro.score       = m.score;
      if (m.score_color !== undefined) state.macro.score_color = m.score_color;
    }
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

    const tpmRaw  = mapField(item, 'tpm', 'trades_minute1m', 'trades_minute5m', 'trades_minute', 'tradesminute', 'trades', 'trades_per_minute', 'volume_trades');
    const oiRaw   = mapField(item, 'oi_trend5m', 'oi_trend', 'oi', 'oi_change', 'open_interest', 'openinterest');
    const lsrRaw  = mapField(item, 'lsr5m', 'lsr', 'long_short_ratio', 'longshortratio', 'ls_ratio', 'longshort');
    const frRaw   = mapField(item, 'fr', 'funding', 'funding_rate', 'fundingrate', 'funding_r');
    const rsiRaw  = mapField(item, 'rsi5m', 'rsi1m', 'rsi', 'rsi_14', 'rsi14', 'rsi_value');
    const ma99Raw = mapField(item, 'ma99', 'ma_99', 'ma99_position', 'ma99pos');
    const priceRaw= mapField(item, 'price', 'last_price', 'last', 'c');
    const break1h = mapField(item, 'breakout_1h', 'trend_break_1h', 'break_1h');
    const break4h = mapField(item, 'breakout_4h', 'trend_break_4h', 'break_4h');
    const break1d = mapField(item, 'breakout_1d', 'trend_break_1d', 'break_1d', 'breakout_d', 'break_d');
    const cvdRaw  = mapField(item, 'cvd', 'cvd_delta', 'volume_delta');
    const liqRaw  = mapField(item, 'liq_dist', 'liq_cluster', 'liquidation', 'dist_liq', 'cluster_dist');
    const appearances = symbol !== 'UNKNOWN' ? recordAssetAppearance(symbol) : 1;

    return {
      symbol, appearances, raw: item,
      price:    round(parseFloat(priceRaw) || 0,  4),
      tpm:      Math.round(parseFloat(tpmRaw)  || 0),
      oi:       normalizeOI(oiRaw),
      lsr:      round(parseFloat(lsrRaw)  || 1,   2),
      fr:       round(parseFloat(frRaw)   || 0,   6),
      rsi:      round(parseFloat(rsiRaw)  || 50,  2),
      ma99:     normalizeMA99(ma99Raw),
      cvd:      parseFloat(cvdRaw)  || null,
      liq_dist: parseFloat(liqRaw)  || null,
      break1h:  parseBool(break1h),
      break4h:  parseBool(break4h),
      break1d:  parseBool(break1d),
    };
  })
  .filter(a => a.symbol && a.symbol !== 'UNKNOWN' && a.symbol.length > 1 && a.symbol === a.symbol.toUpperCase())
  .sort((a, b) => calculateSetupScore(b) - calculateSetupScore(a));

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

  const assets = parseJsonText(raw);
  if (!assets) {
    fb.textContent = '✗ JSON inválido ou nenhum ativo encontrado.';
    fb.className = 'json-feedback error';
    return;
  }

  state.assets = assets;
  lastUpdateTime = Date.now();
  renderAll();

  fb.textContent = `✓ ${assets.length} ativo(s) sincronizado(s) com sucesso!`;
  fb.className = 'json-feedback success';
  setTimeout(() => closeModal('modal-json'), 1800);
}

// ============================================================
// MODAIS
// ============================================================
function openMacroModal() {
  document.getElementById('m-btcdom').value   = state.macro.btcdom;
  document.getElementById('m-usdtdom').value  = state.macro.usdtdom;
  document.getElementById('m-btc-trend').value= state.macro.btcTrend;
  document.getElementById('modal-macro').classList.remove('hidden');
}

function saveMacro() {
  state.macro.btcdom   = parseFloat(document.getElementById('m-btcdom').value)  || 0;
  state.macro.usdtdom  = parseFloat(document.getElementById('m-usdtdom').value) || 0;
  state.macro.btcTrend = document.getElementById('m-btc-trend').value;
  closeModal('modal-macro');
  renderMacro();
}

function openAddAssetModal() {
  document.getElementById('modal-asset').classList.remove('hidden');
}

function saveAsset() {
  const symbol = (document.getElementById('a-symbol').value || '').trim().toUpperCase();
  if (!symbol) { alert('Informe o símbolo.'); return; }
  state.assets.push({
    symbol,
    oi:   document.getElementById('a-oi').value,
    lsr:  parseFloat(document.getElementById('a-lsr').value)  || 1,
    fr:   parseFloat(document.getElementById('a-fr').value)   || 0,
    rsi:  parseFloat(document.getElementById('a-rsi').value)  || 50,
    tpm:  parseFloat(document.getElementById('a-tpm').value)  || 0,
    ma99: document.getElementById('a-ma99').value,
  });
  // Limpa campos
  ['a-symbol','a-lsr','a-fr','a-rsi','a-tpm'].forEach(id => document.getElementById(id).value = '');
  closeModal('modal-asset');
  renderAll();
}

function removeAsset(idx) {
  state.assets.splice(idx, 1);
  renderAll();
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
  renderMacro();
  renderRankingList();
  renderTechBlock();
  renderLiquidityBlock();
}

renderAll();
