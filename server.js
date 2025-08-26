// server.js — FXB API (Render/Node18) — FXBlue/Stats full scrape (DOM-less)
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
    "Accept-Language": "en-US,en;q=0.9",
  },
});

/* ---------------- helpers ---------------- */
const decodeHTML = (s = "") =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const toNum = (s) => {
  if (s == null) return null;
  const cleaned = String(s)
    .replace(/[\u2212\u2013\u2014]/g, "-") // minus/en/em dashes → -
    .replace(/[()]/g, "") // handle (1,234)
    .replace(/[,$%]/g, "")
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

const compact = (s) =>
  decodeHTML(String(s))
    .replace(/[\u00A0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const idx = (html, label) =>
  html.toLowerCase().indexOf(String(label).toLowerCase());

const sliceWin = (html, start, win = 1200) =>
  compact(html.slice(Math.max(0, start), Math.max(0, start) + win));

/** extract table rows as array of [cells[]] (text-only), very forgiving */
function extractRows(html) {
  const rows = [];
  const trRe = /<tr\b[\s\S]*?<\/tr>/gi;
  const tdRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
  const tagRe = /<[^>]+>/g;

  const trMatches = html.match(trRe) || [];
  for (const tr of trMatches) {
    const cells = [];
    let m;
    while ((m = tdRe.exec(tr))) {
      const raw = m[1].replace(tagRe, "");
      const txt = compact(raw);
      cells.push(txt);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** find first row whose first cell matches regex (case-insensitive) */
function findRow(rows, re) {
  const R = typeof re === "string" ? new RegExp("^" + re + "$", "i") : re;
  return rows.find((r) => r[0] && R.test(r[0])) || null;
}

/** find a (label, value) where label is in first cell; return numeric value from next cell */
function findLabeledNumber(rows, labelRe) {
  const row = findRow(rows, labelRe);
  if (!row) return null;
  // try second cell; if absent, try to parse from first
  if (row.length > 1) {
    const v = row[1];
    // allow values like "35.4%" or "$10,000"
    return toNum(v);
  }
  return toNum(row[0]);
}

/** find percentage in second cell */
function findLabeledPercent(rows, labelRe) {
  const row = findRow(rows, labelRe);
  if (!row) return null;
  const v = row[1] || row[0] || "";
  return toNum(String(v).replace("%", ""));
}

/** find triplet row: returns {a,b,c} from the three numeric cells following label */
function findTriplet(rows, labelRe) {
  const row = findRow(rows, labelRe);
  if (!row) return null;
  const nums = row.slice(1).map(toNum).filter((x) => x != null);
  if (nums.length < 3) return null;
  const [a, b, c] = nums;
  return { a, b, c };
}

/** find "History" like "5 days" anywhere */
function findHistory(rows) {
  // try a labeled row
  const r = findRow(rows, /history/i);
  if (r) {
    const txt = r.slice(1).join(" ") || r[0];
    const m = String(txt).match(
      /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i
    );
    if (m) return { value: toNum(m[1]), unit: m[2].toLowerCase() };
  }
  // fallback: scan all cells
  for (const r2 of rows) {
    for (const c of r2) {
      const m = String(c).match(
        /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i
      );
      if (m) return { value: toNum(m[1]), unit: m[2].toLowerCase() };
    }
  }
  return null;
}

/** parse Banked profits per day/week/month/trade table */
function parseBankedProfits(rows) {
  const map = {
    days: /days?/i,
    weeks: /weeks?/i,
    months: /months?/i,
    closedTrades: /closed trades?/i,
  };
  const out = {};
  for (const key of Object.keys(map)) {
    const row = findRow(rows, map[key]);
    if (!row) {
      out[key] = null;
      continue;
    }
    // Expected: [label, winning, losing, win/loss %, best, worst, best seq, worst seq]
    const winning = toNum(row[1]);
    const losing = toNum(row[2]);
    // Find a cell containing %
    let winLossPct = null;
    for (let i = 1; i < row.length; i++) {
      if (/%/.test(row[i])) {
        winLossPct = toNum(row[i]);
        break;
      }
    }
    const best = toNum(row[4] ?? row[3]);
    const worst = toNum(row[5] ?? row[4]);
    const bestSeq = toNum(row[6] ?? row[5]);
    const worstSeq = toNum(row[7] ?? row[6]);
    out[key] = {
      winning: winning ?? null,
      losing: losing ?? null,
      winLossPct: winLossPct ?? null,
      best: best ?? null,
      worst: worst ?? null,
      bestSeq: bestSeq ?? null,
      worstSeq: worstSeq ?? null,
    };
  }
  return out;
}

/** parse Stats on closed trades table */
function parseClosedStats(rows) {
  const keys = [
    { key: "winners", re: /winners?/i },
    { key: "losers", re: /losers?/i },
    { key: "all", re: /all trades?/i },
  ];
  const out = {};
  for (const k of keys) {
    const row = findRow(rows, k.re);
    if (!row) {
      out[k.key] = null;
      continue;
    }
    // Expected order: Trades, Profit, Avg cash, Avg pips, Avg length(h), Cash/hr, Pips/hr, Long seq
    const nums = row.slice(1).map(toNum);
    out[k.key] = {
      trades: nums[0] ?? null,
      profit: nums[1] ?? null,
      avgCash: nums[2] ?? null,
      avgPips: nums[3] ?? null,
      avgLengthHours: nums[4] ?? null,
      cashPerHour: nums[5] ?? null,
      pipsPerHour: nums[6] ?? null,
      longSeq: nums[7] ?? null,
    };
  }
  return out;
}

/* ---------------- scraper ---------------- */
async function scrapeFxBlueStats(user) {
  const url = `https://www.fxblue.com/users/${encodeURIComponent(user)}/stats`;
  const { data: htmlRaw } = await http.get(url);
  const html = String(htmlRaw);
  const rows = extractRows(html);

  // ----- Overview -----
  const overview = {
    weeklyReturn: findLabeledPercent(rows, /weekly return/i),
    monthlyReturn: findLabeledPercent(rows, /monthly return/i),
    profitFactor: findLabeledNumber(rows, /profit factor/i),
    history: findHistory(rows),
    currency: (() => {
      const r = findRow(rows, /currency/i);
      if (!r) return null;
      const cell = r[1] || r[0] || "";
      const m = String(cell).match(/\b([A-Z]{3,4})\b/);
      return m ? m[1] : compact(cell);
    })(),
    equity: findLabeledNumber(rows, /^equity$/i),
    balance: findLabeledNumber(rows, /^balance$/i),
    floatingPL: findLabeledNumber(rows, /floating\s*P\/L/i),
  };

  // ----- Returns -----
  const returns = {
    totalReturn: findLabeledPercent(rows, /total return/i),
    bankedReturn: findLabeledPercent(rows, /banked return/i),
    perDay: findLabeledPercent(rows, /per day/i),
    perWeek: findLabeledPercent(rows, /per week/i),
    perMonth: findLabeledPercent(rows, /per month/i),
  };

  // ----- Deposits / Profit & Loss -----
  const credits = findTriplet(rows, /^credits$/i);
  const totals = findTriplet(rows, /^total$/i);
  const bankedPL = findTriplet(rows, /banked trades?/i);
  const openPL = findTriplet(rows, /open trades?/i);
  const deposits = {
    credits: credits
      ? { deposits: credits.a, withdrawals: credits.b, net: credits.c }
      : null,
    bankedTrades: bankedPL
      ? { profit: bankedPL.a, loss: bankedPL.b, net: bankedPL.c }
      : null,
    openTrades: openPL
      ? { profit: openPL.a, loss: openPL.b, net: openPL.c }
      : null,
    total: totals
      ? { deposits: totals.a, withdrawals: totals.b, net: totals.c }
      : null,
  };

  // ----- Banked profits per day/week/month/trade -----
  const bankedProfits = parseBankedProfits(rows);

  // ----- Stats on closed trades -----
  const closedStats = parseClosedStats(rows);

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
    res
      .status(500)
      .json({ error: true, message: e.message || "scrape error (fxblue)" });
  }
});

// health
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log("FXB API on :" + PORT));
