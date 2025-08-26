// server.js — FXB API (Render/Node18) — اسکرپ کامل‌تر FXBlue/Stats + خروجی همهٔ جدول‌ها
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
    .replace(/[\u2212\u2013\u2014]/g, "-") // minus/en/em → -
    .replace(/[()]/g, "")                  // (1,234) → 1,234
    .replace(/[,$%]/g, "")                 // $,%,,
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

const stripTags = (s) => String(s).replace(/<[^>]+>/g, "");
const compact = (s) =>
  decodeHTML(String(s))
    .replace(/[\u00A0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const idx = (html, label) =>
  html.toLowerCase().indexOf(String(label).toLowerCase());

const sliceWin = (html, start, win = 1200) =>
  compact(html.slice(Math.max(0, start), Math.max(0, start) + win));

/* ---- خواندن همهٔ ردیف‌های یک <table> به‌شکل آرایهٔ سلول‌ها ---- */
function extractRowsFromTable(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[\s\S]*?<\/tr>/gi;
  const tdRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
  const trMatches = tableHtml.match(trRe) || [];
  for (const tr of trMatches) {
    const cells = [];
    let m;
    while ((m = tdRe.exec(tr))) {
      const raw = stripTags(m[1]);
      const txt = compact(raw);
      if (txt !== "") cells.push(txt);
      else cells.push(""); // برای حفظ ستون‌ها
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/* ---- پیدا کردن جدول‌ها به‌همراه عنوان نزدیکش (h1/h2/h3/caption) ---- */
function extractAllTables(html) {
  const out = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const captionRe = /<caption[^>]*>([\s\S]*?)<\/caption>/i;

  const matches = Array.from(html.matchAll(tableRe));
  for (const m of matches) {
    const tableHtml = m[0];
    const start = m.index || 0;

    // عنوان: اول کپشن اگر بود، وگرنه نزدیک‌ترین h1/h2/h3 قبل از جدول
    let title = null;
    const cap = tableHtml.match(captionRe);
    if (cap && cap[1]) {
      title = compact(stripTags(cap[1]));
    } else {
      const prev = html.slice(Math.max(0, start - 1200), start);
      const heads = Array.from(prev.matchAll(headingRe));
      if (heads.length) {
        title = compact(stripTags(heads[heads.length - 1][1]));
      }
    }

    const rows = extractRowsFromTable(tableHtml);
    if (!rows.length) continue;

    // تشخیص هدربار: اگر ردیف اول <th> داشته؛ یا همهٔ سلول‌ها غیرعددی باشند
    const headerGuess =
      /<th\b/i.test(tableHtml) ||
      rows[0].every((c) => toNum(c) === null && c !== "");

    let headers = [];
    let body = rows;
    if (headerGuess) {
      headers = rows[0];
      body = rows.slice(1);
    }

    out.push({
      index: start,
      title: title || null,
      headers,
      rows: body,
    });
  }

  // مرتب‌سازی بر اساس ترتیب در HTML
  out.sort((a, b) => a.index - b.index);
  return out;
}

/* ---- یابنده‌های سادهٔ مقدار با تکیه بر ردیف/برچسب ---- */
function findRow(rows, re) {
  const R = typeof re === "string" ? new RegExp("^" + re + "$", "i") : re;
  return rows.find((r) => r[0] && R.test(r[0])) || null;
}
function findLabeledNumber(rows, labelRe) {
  const r = findRow(rows, labelRe);
  if (!r) return null;
  const v = r[1] ?? r[0] ?? null;
  return v == null ? null : toNum(String(v).replace("%", ""));
}
function findLabeledPercent(rows, labelRe) {
  const r = findRow(rows, labelRe);
  if (!r) return null;
  const v = r[1] ?? r[0] ?? null;
  return v == null ? null : toNum(String(v).replace("%", ""));
}
function findTriplet(rows, labelRe) {
  const r = findRow(rows, labelRe);
  if (!r) return null;
  const nums = r.slice(1).map((c) => toNum(c)).filter((x) => x != null);
  if (nums.length < 3) return null;
  const [a, b, c] = nums;
  return { a, b, c };
}
function findHistoryInRows(rows) {
  const r = findRow(rows, /history/i);
  if (r) {
    const txt = r.slice(1).join(" ") || r[0];
    const m = String(txt).match(
      /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i
    );
    if (m) return { value: toNum(m[1]), unit: m[2].toLowerCase() };
  }
  // fallback: اسکن همهٔ سلول‌ها
  for (const rr of rows) {
    for (const c of rr) {
      const m = String(c).match(
        /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i
      );
      if (m) return { value: toNum(m[1]), unit: m[2].toLowerCase() };
    }
  }
  return null;
}

/* ---- پارس جدول «Banked profits per day/week/month/trade» ---- */
function parseBankedProfitsFromTables(tables) {
  const tgt = tables.find((t) =>
    /banked profits per day\/week\/month\/trade/i.test(t.title || "")
  );
  if (!tgt) return null;

  const map = {
    days: /days?/i,
    weeks: /weeks?/i,
    months: /months?/i,
    closedTrades: /closed trades?/i,
  };
  const out = {};
  for (const key of Object.keys(map)) {
    const row = findRow(tgt.rows, map[key]);
    if (!row) {
      out[key] = null;
      continue;
    }
    // انتظار ستون‌ها: [label, winning, losing, win/loss %, best, worst, best seq, worst seq]
    const winning = toNum(row[1]);
    const losing = toNum(row[2]);
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

/* ---- پارس جدول «Stats on closed trades» ---- */
function parseClosedStatsFromTables(tables) {
  const tgt = tables.find((t) => /stats on closed trades/i.test(t.title || ""));
  if (!tgt) return null;

  const keys = [
    { key: "winners", re: /winners?/i },
    { key: "losers", re: /losers?/i },
    { key: "all", re: /all trades?/i },
  ];
  const out = {};
  for (const k of keys) {
    const row = findRow(tgt.rows, k.re);
    if (!row) {
      out[k.key] = null;
      continue;
    }
    // ترتیب ستون‌ها: Trades, Profit, Avg cash, Avg pips, Avg length(h), Cash/hr, Pips/hr, Long seq
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

/* ---------------- SCRAPER ---------------- */
async function scrapeFxBlueStats(user) {
  const url = `https://www.fxblue.com/users/${encodeURIComponent(user)}/stats`;
  const { data: htmlRaw } = await http.get(url);
  const html = String(htmlRaw);

  // همهٔ جدول‌ها + عنوان‌شان
  const tables = extractAllTables(html);

  // جدول‌هایی که شامل «Overview/Returns/Deposits» هستند معمولاً در یکی از اولین جدول‌ها قرار دارند
  // ما به‌جای وابستگی سفت‌وسخت به جایگاه، از برچسب ردیف‌ها استفاده می‌کنیم:
  const allRows = tables.flatMap((t) => t.rows);

  const overview = {
    weeklyReturn: findLabeledPercent(allRows, /weekly return/i),
    monthlyReturn: findLabeledPercent(allRows, /monthly return/i),
    profitFactor: findLabeledNumber(allRows, /profit factor/i),
    history: findHistoryInRows(allRows),
    currency: (() => {
      const r = findRow(allRows, /currency/i);
      if (!r) return null;
      // سلول بعدی یا خود متن
      const cell = r[1] || r[0] || "";
      const m = String(cell).match(/\b([A-Z]{3,4})\b/);
      return m ? m[1] : compact(cell);
    })(),
    equity: findLabeledNumber(allRows, /^equity$/i),
    balance: findLabeledNumber(allRows, /^balance$/i),
    floatingPL: findLabeledNumber(allRows, /floating\s*P\/L/i),
  };

  const returns = {
    totalReturn: findLabeledPercent(allRows, /total return/i),
    bankedReturn: findLabeledPercent(allRows, /banked return/i),
    perDay: findLabeledPercent(allRows, /per day/i),
    perWeek: findLabeledPercent(allRows, /per week/i),
    perMonth: findLabeledPercent(allRows, /per month/i),
  };

  // Deposits / PL: دنبال ردیف‌های سه‌تایی
  const credits = findTriplet(allRows, /^credits$/i);
  const totals = findTriplet(allRows, /^total$/i);
  const bankedPL = findTriplet(allRows, /banked trades?/i);
  const openPL = findTriplet(allRows, /open trades?/i);
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

  const bankedProfits = parseBankedProfitsFromTables(tables);
  const closedStats = parseClosedStatsFromTables(tables);

  // علاوه‌بر این‌ها، «تمام جدول‌های صفحه» را هم به‌صورت خام برمی‌گردانیم
  // تا هر داده‌ای که روی صفحه هست، در اختیار شما باشد.
  const rawTables = tables.map((t) => ({
    title: t.title,
    headers: t.headers,
    rows: t.rows,
  }));

  return {
    user,
    overview,
    returns,
    deposits,
    bankedProfits,
    closedStats,
    tables: rawTables, // همهٔ جدول‌ها به‌ترتیب ظاهرشدن در صفحه
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
