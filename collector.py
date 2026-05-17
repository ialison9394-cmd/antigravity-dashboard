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

# Edite esta lista com os ativos que você quer monitorar
SYMBOLS = [
    "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "ADAUSDT",
    "SUIUSDT",  "DOTUSDT",  "AVAXUSDT", "LINKUSDT",  "XRPUSDT",
    "DOGEUSDT", "ATOMUSDT", "NEARUSDT", "LTCUSDT",   "MATICUSDT",
    "APTUSDT",  "ARBUSDT",  "OPUSDT",   "INJUSDT",   "TIAUSDT",
]

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
    results = []
    for sym in SYMBOLS:
        data = collect(sym)
        if data:
            results.append(data)
        time.sleep(0.15)          # evita rate-limit da Binance

    # ensure_ascii=False + separators compactos, stdout em UTF-8 sem BOM
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
