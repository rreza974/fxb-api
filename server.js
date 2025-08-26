// server.js — FXB API (Render/Node18) — FXBlue/Stats (overview + returns + deposits + banked-profits + closed-trades)
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

/* ---------------- HTTP client ---------------- */
const http = axios.create({
  timeout: 25000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
  },
});

/* ---------------- helpers ---------------- */
const toNum = (s) => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[, %]/g, ""));
  return isFinite(n) ? n : null;
};
const compact = (s) => (s || "").replace(/\s+/g, " ").trim();
const idx = (html, label) => html.toLowerCase().indexOf(String(label).toLowerCase());
const sliceWin = (html, start, win = 500) =>
  compact(html.slice(Math.max(0, start), Math.max(0, start) + win));

const findAfter = (html, label, { allowPercent = false, window = 400 } = {}) => {
  const i = idx(html, label);
  if (i < 0) return null;
  const s = sliceWin(html, i, window);
  const re = allowPercent
    ? /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*%/
    : /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/;
  const m = s.match(re);
  return m ? toNum(m[0]) : null;
};
const findPercentThenNums = (html, start, label) => {
  const i = idx(html, label);
  if (i < 0) return { pct: null, nums: [] };
  let s = sliceWin(html, i, 360);
  const pm = s.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*%/);
  const pct = pm ? toNum(pm[0]) : null;
  if (pm) s = s.replace(pm[0], ""); // پاک کن تا در لیست اعداد نیاید
  const nums = (s.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g) || []).map(toNum);
  return { pct, nums };
};
const findTripletRow = (html, label) => {
  const i = idx(html, label);
  if (i < 0) return null;
  const s = sliceWin(html, i, 220);
  const nums = (s.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g) || []).map(toNum);
  if (nums.length < 3) return null;
  const [a, b, c] = nums;
  return { a, b, c };
};
const findHistory = (html) => {
  const i = idx(html, "History");
  if (i < 0) return null;
  const s = sliceWin(html, i, 200);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i);
  return m ? { value: toNum(m[1]), unit: String(m[2]).toLowerCase() } : null;
};
const findCurrency = (html) => {
  const i = idx(html, "Currency");
  if (i < 0) return null;
  const s = html.slice(i, i + 120);
  const m = s.match(/\b([A-Z]{3,4})\b/);
  return m ? m[1] : null;
};

/* ---------------- scraper ---------------- */
async function scrapeFxBlueStats(user) {
  const url = `https://www.fxblue.com/users/${encodeURIComponent(user)}/stats`;
  const { data: htmlRaw } = await http.get(url);
  const html = String(htmlRaw);

  // ----- Overview -----
  const overview = {
    weeklyReturn: findAfter(html, "Weekly return", { allowPercent: true }),
    monthlyReturn: findAfter(html, "Monthly return", { allowPercent: true }),
    profitFactor: findAfter(html, "Profit factor"),
    history: findHistory(html),
    currency: findCurrency(html),
    equity: findAfter(html, "Equity"),
    balance: findAfter(html, "Balance"),
    floatingPL: findAfter(html, "Floating P/L"),
  };

  // ----- Returns -----
  const returns = {
    totalReturn: findAfter(html, "Total return", { allowPercent: true }),
    bankedReturn: findAfter(html, "Banked return", { allowPercent: true }),
    perDay: findAfter(html, "Per day", { allowPercent: true }),
    perWeek: findAfter(html, "Per week", { allowPercent: true }),
    perMonth: findAfter(html, "Per month", { allowPercent: true }),
  };

  // ----- Deposits / Profit & Loss -----
  const credits = findTripletRow(html, "Credits");
  const totals = findTripletRow(html, "Total");
  const bankedPL = findTripletRow(html, "Banked trades");
  const openPL = findTripletRow(html, "Open trades");
  const deposits = {
    credits: credits
      ? { deposits: credits.a, withdrawals: credits.b, net: credits.c }
      : null,
    bankedTrades: bankedPL ? { profit: bankedPL.a, loss: bankedPL.b, net: bankedPL.c } : null,
    openTrades: openPL ? { profit: openPL.a, loss: openPL.b, net: openPL.c } : null,
    total: totals ? { deposits: totals.a, withdrawals: totals.b, net: totals.c } : null,
  };

  // ----- Banked profits per day/week/month/trade -----
  const bankedProfits = (() => {
    const baseIdx = idx(html, "Banked profits per day/week/month/trade");
    if (baseIdx < 0) return null;
    const rows = {};
    const parseRow = (label) => {
      const { pct, nums } = findPercentThenNums(html.slice(baseIdx), label);
      // بعد از حذف درصد، انتظار: winning, losing, best, worst, bestSeq, worstSeq
      const [winning, losing, best, worst, bestSeq, worstSeq] = nums;
      return {
        winning: winning ?? null,
        losing: losing ?? null,
        winLossPct: pct ?? null,
        best: best ?? null,
        worst: worst ?? null,
        bestSeq: bestSeq ?? null,
        worstSeq: worstSeq ?? null,
      };
    };
    rows.days = parseRow("Days");
    rows.weeks = parseRow("Weeks");
    rows.months = parseRow("Months");
    rows.closedTrades = parseRow("Closed trades");
    return rows;
  })();

  // ----- Stats on closed trades -----
  const closedStats = (() => {
    const baseIdx = idx(html, "Stats on closed trades");
    if (baseIdx < 0) return null;
    const block = html.slice(baseIdx, baseIdx + 2000);
    const parseRow = (label) => {
      // ترتیب ستون‌ها در اسکرین‌شات: Trades, Profit, Avg cash, Avg pips, Avg length, Cash/hr, Pips/hr, Long seq
      const i = idx(block, label);
      if (i < 0) return null;
      const s = compact(block.slice(i, i + 420));
      const nums = (s.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g) || []).map(toNum);
      if (nums.length < 8) return null;
      const [trades, profit, avgCash, avgPips, avgLen, cashHr, pipsHr, longSeq] = nums;
      return {
        trades,
        profit,
        avgCash,
        avgPips,
        avgLengthHours: avgLen,
        cashPerHour: cashHr,
        pipsPerHour: pipsHr,
        longSeq,
      };
    };
    return {
      winners: parseRow("Winners"),
      losers: parseRow("Losers"),
      all: parseRow("All trades"),
    };
  })();

  return {
    user,
    overview,
    returns,
    deposits,
    bankedProfits,
    closedStats,
    source: "fxblue-scrape",
    fetchedAt: Date.now(),
  };
}

/* ---------------- REST ---------------- */
app.get("/api/fxblue/stats", async (req, res) => {
  try {
    const u = String(req.query.u || "").trim();
    if (!u) return res.status(400).json({ error: "Missing u" });
    const data = await scrapeFxBlueStats(u);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: true, message: e.message || "scrape error" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log("FXB API on :" + PORT));
