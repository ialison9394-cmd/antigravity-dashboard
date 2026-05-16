// DASHBOARD F1 RÁPIDO - ULTIMATE SYNC SCRIPT
document.addEventListener('DOMContentLoaded', () => {
    console.log("F1 Dashboard Initialized.");

    const btn = document.getElementById('sync-btn');
    const input = document.getElementById('json-input');
    const feedback = document.getElementById('sync-feedback');

    function calculateScore(i) {
        let s = 0;
        const tpm = parseFloat(i.tpm || 0);
        const ot = parseFloat(i.oi_trend || 0);
        const lsr = parseFloat(i.lsr || 1);
        const fr = parseFloat(i.funding || 0);
        const rsi = parseFloat(i.rsi || 50);

        if (tpm >= 1000) s += 25; else if (tpm >= 700) s += 15;
        if (ot > 5) s += 25; else if (ot > 0) s += 10;
        if (lsr < 0.8) s += 20; else if (lsr <= 1.2) s += 10;
        if (fr < 0) s += 15; else if (fr <= 0.01) s += 7;
        if (rsi >= 65 && rsi <= 75) s += 15; else if (rsi >= 40 && rsi <= 60) s += 5;
        return s;
    }

    function getStatus(s) {
        if (s >= 86) return 'Fortona em Expansão (Confirmada)';
        if (s >= 61) return 'Gatilho F1 (Rompendo)';
        if (s >= 31) return 'Mola Encolhida (Aquecendo)';
        return 'Monitorando (Reset/Frio)';
    }

    if (btn) {
        btn.addEventListener('click', () => {
            feedback.innerText = "Processando...";
            try {
                const raw = JSON.parse(input.value.trim());
                
                // CONVERTER OBJETO PARA LISTA (Lógica de Chave = Símbolo)
                let list = [];
                if (Array.isArray(raw)) {
                    list = raw;
                } else {
                    list = Object.keys(raw).map(symbol => {
                        const data = raw[symbol];
                        if (typeof data === 'object') {
                            data.symbol = symbol;
                            return data;
                        }
                        return null;
                    }).filter(x => x !== null);
                }

                if (list.length === 0) throw new Error("Nenhum dado encontrado.");

                // MAPEAMENTO INTELIGENTE (Busca por prefixo, ignorando sufixos como :1h ou :1D)
                const processed = list.map(i => {
                    const findVal = (prefix) => {
                        const key = Object.keys(i).find(k => k.toLowerCase().startsWith(prefix.toLowerCase()));
                        return key ? parseFloat(i[key]) : null;
                    };

                    const item = {
                        symbol: i.symbol || "N/A",
                        tpm: findVal('trades_minute') || findVal('tpm') || 0,
                        oi_trend: findVal('oi_trend') || 0,
                        lsr: findVal('lsr') || 1,
                        funding: findVal('funding') || findVal('fr') || 0,
                        rsi: findVal('rsi') || 50,
                        change: findVal('price_change') || findVal('change') || 0
                    };
                    item.score = calculateScore(item);
                    return item;
                }).filter(item => 
                    item.symbol !== "manifest" && 
                    item.symbol !== "N/A" && 
                    item.symbol.length > 2 &&
                    item.symbol === item.symbol.toUpperCase() // Símbolos reais são CAPS
                ).sort((a, b) => b.score - a.score);

                // ATUALIZAR INTERFACE
                updateUI(processed);
                feedback.innerText = `Sincronizado: ${processed.length} ativos.`;
            } catch (e) {
                console.error(e);
                feedback.innerText = "Erro: JSON inválido ou formato incompatível.";
            }
        });
    }

    function updateUI(data) {
        // 1. Top Stats
        const warming = data.filter(x => x.score >= 31 && x.score <= 60).length;
        const squeeze = data.filter(x => x.lsr < 0.8).length;
        const traps = data.filter(x => x.lsr > 2.0 || x.rsi > 85).length;

        document.getElementById('count-warming').innerText = warming;
        document.getElementById('count-squeeze').innerText = squeeze;
        document.getElementById('count-traps').innerText = traps;

        // 2. Spotlight
        const top = data[0];
        if (top) {
            document.getElementById('top-symbol').innerText = top.symbol;
            document.getElementById('top-status').innerText = getStatus(top.score);
            document.getElementById('top-score').innerText = `${Math.round(top.score)}%`;
            document.getElementById('top-change').innerText = `${top.change >= 0 ? '+' : ''}${top.change.toFixed(2)}% preço`;
            
            const barSetup = document.getElementById('bar-setup');
            barSetup.style.width = `${top.score}%`;
            barSetup.style.background = top.score > 85 ? '#00ff88' : (top.score > 60 ? '#00d2ff' : '#ff9f00');
            
            document.getElementById('bar-force').style.width = `${Math.min(top.score * 1.05, 100)}%`;
        }

        // 3. List
        const listContainer = document.getElementById('asset-list');
        listContainer.innerHTML = '';
        data.slice(0, 40).forEach((item, idx) => {
            const div = document.createElement('div');
            div.className = 'ranking-item';
            div.innerHTML = `
                <span class="rank-num">#${idx + 1}</span>
                <span class="asset-name">${item.symbol}</span>
                <span style="color: ${item.change >= 0 ? '#00ff88' : '#ff3e3e'}">${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%</span>
                <span class="asset-score-small" style="color: ${item.score > 85 ? '#00ff88' : '#888'}">${Math.round(item.score)}%</span>
            `;
            listContainer.appendChild(div);
        });

        // 4. Radar
        const lotado = data.filter(x => x.lsr > 2.0).length;
        const exausto = data.filter(x => x.rsi > 85).length;
        document.getElementById('trap-lsr').innerText = `LSR acima de 2.0 (${lotado} ativos)`;
        document.getElementById('trap-rsi').innerText = `RSI acima de 85 (${exausto} ativos)`;
    }
});
