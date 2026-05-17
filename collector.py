#!/usr/bin/env python3
"""
OBSIDIAN CORE — Coletor Binance Futures
Saída: JSON array para stdout → GitHub Actions salva em data/latest.json
API pública — nenhuma chave necessária.
"""

import json
import sys
import time

import numpy as np
import pandas as pd
import requests

# ── Configuração ──────────────────────────────────────────────────────────────
BASE  = "https://fapi.binance.com"
SESS  = requests.Session()
SESS.headers.update({"Accept": "application/json"})

TIMEOUT = 10  # segundos por request

# ── Helpers ───────────────────────────────────────────────────────────────────
def get(endpoint, params=None):
    try:
        r = SESS.get(f"{BASE}{endpoint}", params=params, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def calc_rsi(closes: list, period: int = 14) -> float | None:
    """RSI de Wilder via EMA. Retorna float arredondado em 2 casas, ou None se inválido."""
    if len(closes) < period + 1:
        return None
    s     = pd.Series(closes, dtype=float)
    delta = s.diff()
    gain  = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss  = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs    = gain / loss.replace(0, np.nan)
    rsi   = (100 - (100 / (1 + rs))).iloc[-1]
    if pd.isna(rsi):
        return None
    return round(float(rsi), 2)


def oi_trend(pct: float) -> str:
    if pct >  0.5: return "subindo"
    if pct < -0.5: return "caindo"
    return "neutro"


def ma99_position(price: float, ma: float) -> str:
    if ma == 0: return "perto_acima"
    pct = (price - ma) / ma * 100
    if pct >  8: return "muito_acima"
    if pct < -2: return "abaixo"
    return "perto_acima"


def kline_pct(symbol: str, interval: str = "15m") -> float:
    """Variação percentual de fechamento entre as 2 últimas velas."""
    k = get("/fapi/v1/klines", {"symbol": symbol, "interval": interval, "limit": 2})
    if not k or len(k) < 2:
        return 0.0
    prev, curr = float(k[-2][4]), float(k[-1][4])
    return round((curr - prev) / prev * 100, 3) if prev else 0.0


# ── Macro: Matriz de Correlação BTC × BTC.D ──────────────────────────────────
def get_macro() -> dict:
    """Busca BTC 24h e BTC Dominância → mapeia para cenário macro."""
    # BTC via Binance (mesmo SESS, sem custo extra)
    btc_ticker = get("/fapi/v1/ticker/24hr", {"symbol": "BTCUSDT"})
    btc_24h    = float(btc_ticker.get("priceChangePercent", 0)) if btc_ticker else 0.0
    btc_price  = float(btc_ticker.get("lastPrice",          0)) if btc_ticker else 0.0

    # BTC.D via CoinGecko (API pública, sem chave)
    btcdom, mkt_24h = 0.0, 0.0
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/global",
            timeout=TIMEOUT,
            headers={"Accept": "application/json"},
        )
        if r.ok:
            cg      = r.json().get("data", {})
            btcdom  = round(float(cg.get("market_cap_percentage", {}).get("btc", 0)), 2)
            mkt_24h = float(cg.get("market_cap_change_percentage_24h_usd", 0))
    except Exception:
        pass

    def trend(pct: float, thresh: float) -> str:
        if pct >  thresh: return "subindo"
        if pct < -thresh: return "caindo"
        return "neutro"

    btc_trend  = trend(btc_24h,             thresh=1.5)
    # Proxy BTC.D: BTC superando o mercado total → dominância subindo
    btcd_trend = trend(btc_24h - mkt_24h,   thresh=1.0)

    # Matriz de correlação completa (9 células)
    MATRIX = {
        ("caindo",  "subindo"): ("Distribuição + Flight to Safety", "❌ Não operar alts",  5,  "red"),
        ("caindo",  "caindo"):  ("Capitulação Geral",               "🟡 Esperar base",     20, "red"),
        ("caindo",  "neutro"):  ("Queda Controlada",                "🟡 Cautela",          25, "red"),
        ("subindo", "subindo"): ("Reacumulação em BTC",             "🟢 Long BTC",         55, "yellow"),
        ("subindo", "caindo"):  ("Migração de Capital / Altseason", "🟢 Long Alts",        90, "green"),
        ("subindo", "neutro"):  ("BTC Alta Moderada",               "🟡 Favorável a BTC",  60, "yellow"),
        ("neutro",  "subindo"): ("Absorção em BTC",                 "🟢 BTC swing",        60, "yellow"),
        ("neutro",  "caindo"):  ("Preparação de Expansão",          "🟡 Scout em alts",    65, "green"),
        ("neutro",  "neutro"):  ("Mercado Lateral",                 "🟡 Aguardar sinal",   40, "yellow"),
    }
    scenario, action, score, color = MATRIX.get(
        (btc_trend, btcd_trend),
        ("Indefinido", "🟡 Aguardar", 40, "yellow"),
    )

    # Termômetros de Liquidez (15m)
    btc_15m   = kline_pct("BTCUSDT", "15m")
    eth_15m   = kline_pct("ETHUSDT", "15m")
    btcd_15m  = round(btc_15m - eth_15m, 3)
    usdtd_15m = round(-(btc_15m + eth_15m) / 2, 3)

    def _thermo(lbl, role, pct, up=0.3, dn=-0.3):
        if   pct > up: d = "up"
        elif pct < dn: d = "down"
        else:          d = "neutral"
        arrow = "🔺" if d == "up" else "🔻" if d == "down" else "➡️"
        clr   = "green" if d == "up" else "red" if d == "down" else "yellow"
        key   = lbl.lower().replace(".", "")
        legs  = {
            ("btc",   "up"):      "Alta confirmada — favorável para Alts",
            ("btc",   "down"):    "Queda — cautela em todas as posições",
            ("btc",   "neutral"): "Lateral — aguardar direção",
            ("btcd",  "up"):      "Capital migrando para BTC",
            ("btcd",  "down"):    "Capital fluindo para Alts",
            ("btcd",  "neutral"): "Fluxo equilibrado entre BTC e Alts",
            ("usdtd", "up"):      "Fuga para stables — mercado em alerta",
            ("usdtd", "down"):    "Capital retornando ao mercado",
            ("usdtd", "neutral"): "Temperatura do medo estável",
        }
        return {"label": lbl, "role": role, "pct": pct, "dir": d,
                "arrow": arrow, "color": clr, "legend": legs.get((key, d), "")}

    thermometers = {
        "btc":   _thermo("BTC",    "DIREÇÃO PRIMÁRIA",   btc_15m),
        "btcd":  _thermo("BTC.D",  "FLUXO DE CAPITAL",   btcd_15m,  up=0.2, dn=-0.2),
        "usdtd": _thermo("USDT.D", "TERMÔMETRO DO MEDO", usdtd_15m, up=0.2, dn=-0.2),
    }

    return {
        "btcdom":       btcdom,
        "btc_price":    round(btc_price, 2),
        "btc_24h":      round(btc_24h,   2),
        "btc_trend":    btc_trend,
        "btcd_trend":   btcd_trend,
        "scenario":     scenario,
        "action":       action,
        "score":        score,
        "score_color":  color,
        "thermometers": thermometers,
    }


# ── Top N por volume ─────────────────────────────────────────────────────────
def get_top_symbols(n: int = 50) -> list[str]:
    """Busca os N pares USDT de Binance Futures com maior volume em 24h."""
    tickers = get("/fapi/v1/ticker/24hr")
    if not tickers:
        return []
    usdt = [t for t in tickers if t.get("symbol", "").endswith("USDT")]
    usdt.sort(key=lambda t: float(t.get("quoteVolume", 0)), reverse=True)
    return [t["symbol"] for t in usdt[:n]]


# ── Coleta por símbolo ────────────────────────────────────────────────────────
def collect(symbol: str) -> dict | None:

    # 1. Klines 5m — 120 velas (RSI, MA99, TPM)
    klines = get("/fapi/v1/klines", {"symbol": symbol, "interval": "5m", "limit": 120})
    if not klines or len(klines) < 20:
        return None

    closes = [float(k[4]) for k in klines]
    price  = closes[-1]
    rsi = calc_rsi(closes)
    if rsi is None:
        return None   # símbolo sem dados suficientes (suspenso/renomeado)

    # MA99 = média simples das últimas 99 velas de fechamento
    ma99_val = float(np.mean(closes[-99:]) if len(closes) >= 99 else np.mean(closes))
    ma99_pos = ma99_position(price, ma99_val)

    # TPM = média de trades por minuto nas últimas 5 velas (k[8] = num trades / vela 5m)
    tpm = int(np.mean([float(k[8]) for k in klines[-5:]]) / 5)

    # 2. Funding Rate atual (formato fixo, sem notação científica)
    premium = get("/fapi/v1/premiumIndex", {"symbol": symbol})
    fr = float(f"{float(premium.get('lastFundingRate', 0)):.6f}") if premium else 0.0

    # 3. OI agora vs 15 min atrás
    oi_now  = get("/fapi/v1/openInterest", {"symbol": symbol})
    oi_hist = get("/futures/data/openInterestHist", {"symbol": symbol, "period": "5m", "limit": 4})

    oi_str = "neutro"
    if oi_now and oi_hist and len(oi_hist) >= 2:
        cur  = float(oi_now.get("openInterest", 0))
        prev = float(oi_hist[0].get("sumOpenInterest", cur))
        pct  = (cur - prev) / prev * 100 if prev else 0
        oi_str = oi_trend(pct)

    # 4. Long/Short Ratio (conta global, intervalo 5m)
    lsr_data = get("/futures/data/globalLongShortAccountRatio",
                   {"symbol": symbol, "period": "5m", "limit": 1})
    lsr = round(float(lsr_data[0].get("longShortRatio", 1.0)), 2) if lsr_data else 1.0

    return {
        "symbol": symbol,
        "price":  round(price, 6),
        "rsi":    rsi,
        "fr":     fr,
        "lsr":    lsr,
        "tpm":    tpm,
        "oi":     oi_str,
        "ma99":   ma99_pos,
    }


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    macro   = get_macro()
    symbols = get_top_symbols(50)
    assets  = []
    for sym in symbols:
        data = collect(sym)
        if data:
            assets.append(data)
        time.sleep(0.15)          # evita rate-limit da Binance

    output = {"macro": macro, "assets": assets}
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
