// server.js — FXB API (Render/Node18) — اسکرپ FXBlue/Stats + فالو‌بک از صفحه اصلی برای Peak drawdown (همیشه با علامت منفی)
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const http = axios.create({
  timeout: 25000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

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
const compact = (s) =>
  decodeHTML(String(s)).replace(/[\u00A0]/g, " ").replace(/\s+/g, " ").trim();
const idx = (html, label) =>
  html.toLowerCase().indexOf(String(label).toLowerCase());
const sliceWin = (html, start, win = 1200) =>
  compact(html.slice(Math.max(0, start), Math.max(0, start) + win));

function findAfter(html, label, { allowPercent = false, window = 600 } = {}) {
  const i = idx(html, label);
  if (i < 0) return null;
  const s = sliceWin(html, i, window);
  const re = allowPercent
    ? /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*%/
    : /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/;
  const m = s.match(re);
  return m ? toNum(m[0]) : null;
}

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
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
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
      const prev = html.slice(Math.max(0, start - 1200), start);
      const heads = Array.from(prev.matchAll(headingRe));
      if (heads.length) title = compact(stripTags(heads[heads.length - 1][1]));
    }
    const rows = extractRowsFromTable(tableHtml);
    if (!rows.length) continue;
    const headerGuess =
      /<th\b/i.test(tableHtml) || rows[0].every((c) => toNum(c) === null && c !== "");
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

async function scrapeFxBlueStats(user) {
  // 1) صفحه Stats
  const statsUrl = `https://www.fxblue.com/users/${encodeURIComponent(user)}/stats`;
  const { data: statsHtmlRaw } = await http.get(statsUrl);
  const statsHtml = String(statsHtmlRaw);
  const statsTables = extractAllTables(statsHtml);
  const statsRows = statsTables.flatMap((t) => t.rows);

  // 2) صفحه Overview اصلی
  const overviewUrl = `https://www.fxblue.com/users/${encodeURIComponent(user)}`;
  const { data: ovHtmlRaw } = await http.get(overviewUrl);
  const ovHtml = String(ovHtmlRaw);
  const ovTables = extractAllTables(ovHtml);
  const ovRows = ovTables.flatMap((t) => t.rows);

  // ---- Overview fields
  let weeklyReturn =
    findLabeledPercent(statsRows, /weekly return/i) ??
    findAfter(statsHtml, "Weekly return", { allowPercent: true });
  let monthlyReturn =
    findLabeledPercent(statsRows, /monthly return/i) ??
    findAfter(statsHtml, "Monthly return", { allowPercent: true });

  const profitFactor =
    findLabeledNumber(statsRows, /profit factor/i) ??
    findAfter(statsHtml, "Profit factor");

  // Peak drawdown: اول از صفحه Stats، اگر نبود از صفحه Overview بخوان
  let peakDrawdown =
    findLabeledPercent(statsRows, /peak drawdown/i) ??
    findAfter(statsHtml, "Peak drawdown", { allowPercent: true }) ??
    findLabeledPercent(ovRows, /peak drawdown/i) ??
    findAfter(ovHtml, "Peak drawdown", { allowPercent: true });

  // اگر Peak drawdown پیدا شد، همیشه منفی‌اش کن (برای نمایش «-99.7%»)
  if (typeof peakDrawdown === "number") peakDrawdown = -Math.abs(peakDrawdown);

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

  // Deposits / Profit & Loss (از جدول‌ها)
  const triplet = (rows, label) => {
    const r = findRow(rows, label);
    if (!r) return null;
    const nums = r.slice(1).map(toNum).filter((x) => x != null);
    if (nums.length < 3) return null;
    return { a: nums[0], b: nums[1], c: nums[2] };
  };
  const credits = triplet(statsRows, /^credits$/i);
  const banked = triplet(statsRows, /banked trades?/i);
  const open   = triplet(statsRows, /open trades?/i);
  const totals = triplet(statsRows, /^total$/i);

  return {
    user,
    overview: {
      weeklyReturn,
      monthlyReturn,
      profitFactor,
      peakDrawdown, // مهم
    },
    returns: {
      totalReturn,
      bankedReturn,
      perDay,
      perWeek,
      perMonth,
    },
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
