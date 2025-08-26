// server.js — FXB API (Render/Node18)
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// ---------- HTTP client ----------
const http = axios.create({
  timeout: 25000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
  },
});

// helpers
const compact = (s) => (s || "").replace(/\s+/g, " ").trim();
const toNum = (s) => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[, %]/g, ""));
  return isFinite(n) ? n : null;
};
const findAfter = (html, label, { allowPercent = false, window = 400 } = {}) => {
  const i = html.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return null;
  const slice = html.slice(i, i + window).replace(/\s+/g, " ");
  let re = allowPercent
    ? /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*%/
    : /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/;
  const m = slice.match(re);
  return m ? toNum(m[0]) : null;
};
const findRowTriplet = (html, label, window = 220) => {
  const i = html.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return null;
  const slice = html.slice(i, i + window).replace(/\s+/g, " ");
  const nums = slice.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g) || [];
  const [a, b, c] = nums.slice(0, 3).map(toNum);
  if ([a, b, c].some((x) => x == null)) return null;
  return { a, b, c };
};
const findHistory = (html) => {
  const i = html.toLowerCase().indexOf("history");
  if (i < 0) return null;
  const slice = html.slice(i, i + 200).replace(/\s+/g, " ");
  const m = slice.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)/i);
  if (!m) return null;
  return { value: toNum(m[1]), unit: String(m[2]).toLowerCase() };
};
const findCurrency = (html) => {
  const i = html.toLowerCase().indexOf("currency");
  if (i < 0) return null;
  const slice = html.slice(i, i + 120);
  const m = slice.match(/\b([A-Z]{3,4})\b/);
  return m ? m[1] : null;
};

async function scrapeFxBlueStats(user) {
  const url = `https://www.fxblue.com/users/${encodeURIComponent(user)}/stats`;
  const { data: html } = await http.get(url);

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

  const returns = {
    totalReturn: findAfter(html, "Total return", { allowPercent: true }),
    bankedReturn: findAfter(html, "Banked return", { allowPercent: true }),
    perDay: findAfter(html, "Per day", { allowPercent: true }),
    perWeek: findAfter(html, "Per week", { allowPercent: true }),
    perMonth: findAfter(html, "Per month", { allowPercent: true }),
  };

  const depCredits = findRowTriplet(html, "Credits");
  const depTotals = findRowTriplet(html, "Total");
  // "Banked trades" row contains Profit / Loss / Net
  const bankedPL = findRowTriplet(html, "Banked trades");
  const openPL = findRowTriplet(html, "Open trades");

  const deposits = {
    credits: depCredits
      ? { deposits: depCredits.a, withdrawals: depCredits.b, net: depCredits.c }
      : null,
    bankedTrades: bankedPL
      ? { profit: bankedPL.a, loss: bankedPL.b, net: bankedPL.c }
      : null,
    openTrades: openPL
      ? { profit: openPL.a, loss: openPL.b, net: openPL.c }
      : null,
    total: depTotals
      ? { deposits: depTotals.a, withdrawals: depTotals.b, net: depTotals.c }
      : null,
  };

  return {
    user,
    overview,
    returns,
    deposits,
    source: "fxblue-scrape",
    fetchedAt: Date.now(),
  };
}

// ---- REST ----
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

// keepalive / health
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.listen(PORT, () => {
  console.log("FXB API on :" + PORT);
});
