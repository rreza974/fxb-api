// server.js — FXB API (Render/Node18)
// اسکرپ FXBlue: /users/<u>/stats + فالو‌بک از /users/<u>
// برمی‌گرداند: overview.{weeklyReturn,monthlyReturn,profitFactor,peakDrawdown,history,accountType}
// به‌همراه: returns.{totalReturn,perDay,perWeek,perMonth} و deposits (credits/banked/open/total)

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

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
  const n = parseFloat(
    String(s)
      .replace(/[\u2212\u2013\u2014]/g, "-")
      .replace(/[()]/g, "")
      .replace(/[,$%]/g, "")
      .trim()
  );
  return Number.isFinite(n) ? n : null;
};

const stripTags = (s) => String(s).replace(/<[^>]+>/g, "");
const compact   = (s) => decodeHTML(String(s)).replace(/[\u00A0]/g, " ").replace(/\s+/g, " ").trim();
const idx       = (html, label) => html.toLowerCase().indexOf(String(label).toLowerCase());
const sliceWin  = (html, start, win = 1600) => compact(html.slice(Math.max(0, start), Math.max(0, start) + win));

function findAfter(html, label, { allowPercent = false, window = 1000 } = {}) {
  const i = idx(html, label);
  if (i < 0) return null;
  const s = sliceWin(html, i, window);
  const re = allowPercent
    ? /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*%/
    : /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/;
  const m = s.match(re);
  return m ? toNum(m[0]) : null;
}

/* ---- table parsing ---- */
function extractRowsFromTable(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[\s\S]*?<\/tr>/gi;
  const tdRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
  const trMatches = tableHtml.match(trRe) || [];
  for (const tr of trMatches) {
    const cells = [];
    let m;
    while ((m = tdRe.exec(tr))) {
      const txt = compact(stripTags(m[1]));
      cells.push(txt);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function extractAllTables(html) {
  const out = [];
  const tableRe   = /<table\b[\s\S]*?<\/table>/gi;
  const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const captionRe = /<caption[^>]*>([\s\S]*?)<\/caption>/i;

  const matches = Array.from(html.matchAll(tableRe));
  for (const m of matches) {
    const tableHtml = m[0];
    const start = m.index || 0;

    const cap = tableHtml.match(captionRe);
    let title = null;
    if (cap && cap[1]) title = compact(stripTags(cap[1]));
    else {
      const prev = html.slice(Math.max(0, start - 1500), start);
      const heads = Array.from(prev.matchAll(headingRe));
      if (heads.length) title = compact(stripTags(heads[heads.length - 1][1]));
    }

    const rows = extractRowsFromTable(tableHtml);
    if (!rows.length) continue;

    const headerGuess =
      /<th\b/i.test(tableHtml) || rows[0].every((c) => isNaN(parseFloat(c)));
    let headers = [];
    let body = rows;
    if (headerGuess) {
      headers = rows[0];
      body = rows.slice(1);
    }
    out.push({ index: start, title: title || null, headers, rows: body });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function findRow(rows, re) {
  const R = typeof re === "string" ? new RegExp("^" + re + "$", "i") : re;
  return rows.find((r) => r[0] && R.test(r[0])) || null;
}
function findLabeledPercent(rows, labelRe) {
  const r = findRow(rows, labelRe);
  if (!r) return null;
  const v = r[1] ?? r[0] ?? null;
  return v == null ? null : toNum(String(v).replace("%", ""));
}
function findLabeledNumber(rows, labelRe) {
  const r = findRow(rows, labelRe);
  if (!r) return null;
  const v = r[1] ?? r[0] ?? null;
  return v == null ? null : toNum(v);
}
function findHistoryFrom(rows) {
  const r = findRow(rows, /history/i);
  if (r) {
    const joined = r.slice(1).join(" ") || r[0] || "";
    const m = joined.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i);
    if (m) return { value: toNum(m[1]), unit: m[2].toLowerCase() };
  }
  for (const rr of rows) {
    for (const c of rr) {
      const m = String(c).match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i);
      if (m) return { value: toNum(m[1]), unit: m[2].toLowerCase() };
    }
  }
  return null;
}

/* --- استخراج بسیار مقاوم نوع حساب (Demo/Real) --- */
function extractAccountType(html, rows) {
  // ۱) اگر در جدول/ردیف آمده باشد
  const r = findRow(rows, /account\s*type/i);
  if (r) {
    const val = (r.slice(1).join(" ") || "").toLowerCase();
    if (/\bdemo\b/.test(val)) return "demo";
    if (/\breal\b/.test(val)) return "real";
  }

  // ۲) روی HTML خام با فاصله/تگ/ایموجی بین «Account type :» و مقدار
  const rx = /Account(?:\s|&nbsp;|<[^>]*>)*type\s*:\s*([\s\S]{0,200}?)(Demo|Real)\b/i;
  let m = html.match(rx);
  if (m && m[2]) return m[2].toLowerCase();

  // ۳) روی نسخهٔ متنیِ صاف
  const plain = stripTags(decodeHTML(html));
  m = plain.match(/Account\s*type\s*:\s*(Demo|Real)\b/i);
  if (m && m[1]) return m[1].toLowerCase();

  // ۴) نزدیک برچسب در HTML خام (پنجره‌ی بزرگ)
  const i = idx(html, "Account type");
  if (i >= 0) {
    const win = sliceWin(html, i, 2000);
    if (/Demo\b/i.test(win)) return "demo";
    if (/Real\b/i.test(win)) return "real";
  }

  // ۵) فالو‌بک: اگر در صفحه واژه Demo/Real دیده شود
  if (/\bDemo\b/i.test(plain)) return "demo";
  if (/\bReal\b/i.test(plain)) return "real";

  return null;
}

/* ---------------- SCRAPER ---------------- */
async function scrapeFxBlueStats(user) {
  // صفحه Stats
  const statsUrl = `https://www.fxblue.com/users/${encodeURIComponent(user)}/stats`;
  const { data: statsHtmlRaw } = await http.get(statsUrl);
  const statsHtml   = String(statsHtmlRaw);
  const statsTables = extractAllTables(statsHtml);
  const statsRows   = statsTables.flatMap((t) => t.rows);

  // صفحه Overview
  const overviewUrl = `https://www.fxblue.com/users/${encodeURIComponent(user)}`;
  const { data: ovHtmlRaw } = await http.get(overviewUrl);
  const ovHtml   = String(ovHtmlRaw);
  const ovTables = extractAllTables(ovHtml);
  const ovRows   = ovTables.flatMap((t) => t.rows);

  // Overview metrics
  let weeklyReturn =
    findLabeledPercent(statsRows, /weekly return/i) ??
    findAfter(statsHtml, "Weekly return", { allowPercent: true });
  let monthlyReturn =
    findLabeledPercent(statsRows, /monthly return/i) ??
    findAfter(statsHtml, "Monthly return", { allowPercent: true });

  const profitFactor =
    findLabeledNumber(statsRows, /profit factor/i) ??
    findAfter(statsHtml, "Profit factor");

  let peakDrawdown =
    findLabeledPercent(statsRows, /peak drawdown/i) ??
    findAfter(statsHtml, "Peak drawdown", { allowPercent: true }) ??
    findLabeledPercent(ovRows, /peak drawdown/i) ??
    findAfter(ovHtml, "Peak drawdown", { allowPercent: true });
  if (typeof peakDrawdown === "number") peakDrawdown = -Math.abs(peakDrawdown);

  const history =
    findHistoryFrom(statsRows) ??
    findHistoryFrom(ovRows) ??
    (function () {
      const i = idx(statsHtml, "History");
      if (i >= 0) {
        const s = sliceWin(statsHtml, i, 400).match(
          /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i
        );
        if (s) return { value: toNum(s[1]), unit: s[2].toLowerCase() };
      }
      const j = idx(ovHtml, "History");
      if (j >= 0) {
        const s = sliceWin(ovHtml, j, 400).match(
          /(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i
        );
        if (s) return { value: toNum(s[1]), unit: s[2].toLowerCase() };
      }
      return null;
    })();

  // نوع حساب (بسیار مقاوم)
  const accountType =
    (extractAccountType(ovHtml, ovRows) ?? extractAccountType(statsHtml, statsRows)) || null; // 'demo' | 'real' | null

  // Returns
  const totalReturn =
    findLabeledPercent(statsRows, /total return/i) ??
    findAfter(statsHtml, "Total return", { allowPercent: true });
  const bankedReturn =
    findLabeledPercent(statsRows, /banked return/i) ??
    findAfter(statsHtml, "Banked return", { allowPercent: true });
  const perDay =
    findLabeledPercent(statsRows, /per day/i) ??
    findAfter(statsHtml, "Per day", { allowPercent: true });
  const perWeek =
    findLabeledPercent(statsRows, /per week/i) ??
    findAfter(statsHtml, "Per week", { allowPercent: true });
  const perMonth =
    findLabeledPercent(statsRows, /per month/i) ??
    findAfter(statsHtml, "Per month", { allowPercent: true });

  // Deposits / Profit & Loss
  const trip = (rows, re) => {
    const r = rows.find((x) => re.test(x[0] || ""));
    if (!r) return null;
    const nums = r.slice(1).map(toNum).filter((x) => x != null);
    if (nums.length < 3) return null;
    return { a: nums[0], b: nums[1], c: nums[2] }; // a=Deposits/Profit, b=Withdrawals/Loss, c=Net
  };
  const credits = trip(statsRows, /^credits$/i);
  const banked  = trip(statsRows, /banked trades?/i);
  const open    = trip(statsRows, /open trades?/i);
  const totals  = trip(statsRows, /^total$/i);

  return {
    user,
    overview: {
      weeklyReturn, monthlyReturn, profitFactor, peakDrawdown, history, accountType
    },
    returns: { totalReturn, perDay, perWeek, perMonth, bankedReturn },
    deposits: {
      credits: credits ? { deposits: credits.a, withdrawals: credits.b, net: credits.c } : null,
      bankedTrades: banked ? { profit: banked.a, loss: banked.b, net: banked.c } : null,
      openTrades: open ? { profit: open.a, loss: open.b, net: open.c } : null,
      total: totals ? { deposits: totals.a, withdrawals: totals.b, net: totals.c } : null,
    },
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
