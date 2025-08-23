// server.js
// FX Blue → API for your site (cloud-ready)

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const vm = require("vm");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
// پورتفولیوی FX Blue را می‌توانی از متغیر محیطی هم بدهی
const PORTFOLIO_ID = process.env.PORTFOLIO_ID || "investor-hub";

// ---------- HTTP client ----------
const http = axios.create({
  timeout: 60000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "text/html,application/json,text/plain,*/*",
  },
  proxy: false,
});

// ---------- Helpers ----------
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// فقط اعضای واقعی پورتفولیو را برمی‌گرداند
async function getPortfolioUsers(portfolioId) {
  const url = `https://www.fxblue.com/users/${encodeURIComponent(
    portfolioId
  )}/portfolio`;
  const { data: html } = await http.get(url, { responseType: "text" });

  const start = html.indexOf("Portfolio Constituents");
  const end = html.indexOf("Portfolio Details", start + 1);
  const segment = start !== -1 && end !== -1 ? html.slice(start, end) : html;

  const re = /href="\/users\/([A-Za-z0-9_-]+)(?:\/|")/g;
  const set = new Set();
  let m;
  while ((m = re.exec(segment)) !== null) {
    const u = (m[1] || "").toLowerCase();
    if (
      u &&
      u !== portfolioId.toLowerCase() &&
      u !== "example" &&
      u !== "exampleportfolio"
    ) {
      set.add(m[1]);
    }
  }
  return Array.from(set);
}

// overviewscript هر کاربر را اجرا می‌کند و به شیء تبدیل می‌کند
async function fetchOverviewForUser(username) {
  const url = `https://www.fxblue.com/users/${encodeURIComponent(
    username
  )}/overviewscript`;
  const { data: js } = await http.get(url, { responseType: "text" });

  const sandbox = { document: { MTIntelligenceAccounts: [] } };
  vm.createContext(sandbox);
  try {
    vm.runInContext(js, sandbox, { timeout: 3000 });
  } catch {
    return null;
  }

  const arr = sandbox.document.MTIntelligenceAccounts || [];
  if (!arr.length) return null;

  const o = arr[0];
  return {
    id: username,
    name: username,
    gain: num(o.totalBankedGrowth),
    absGain: num(o.totalBankedGrowth),
    daily: num(o.dailyBankedGrowth),
    monthly: num(o.monthlyBankedGrowth),
    drawdown: Math.abs(num(o.deepestValleyPercent)),
    profitFactor: num(o.bankedProfitFactor),
    pips: num(o.pips),
    balance: num(o.balance),
    equity: num(o.equity),
    currency: o.currency || "",
    lastUpdateDate: "",
  };
}

// ---------- API ----------
app.get("/api/accounts", async (req, res) => {
  try {
    const pid = String(req.query.portfolio || PORTFOLIO_ID);
    const users = await getPortfolioUsers(pid);
    if (!users.length) return res.json([]);

    // محدودسازی همزمانی
    const out = [];
    const BATCH = 5;
    for (let i = 0; i < users.length; i += BATCH) {
      const part = await Promise.all(
        users.slice(i, i + BATCH).map((u) => fetchOverviewForUser(u))
      );
      out.push(...part.filter(Boolean));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: true, message: e.message || "FXBlue fetch error" });
  }
});

app.listen(PORT, () => {
  console.log("API running → http://localhost:" + PORT);
});
