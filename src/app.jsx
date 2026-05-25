import { useState, useEffect, useCallback, useRef } from "react";
import { Analytics } from "@vercel/analytics/react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const WATCHLIST = [
  { symbol:"RELIANCE",   name:"Reliance Industries", token:"2885",  exchange:"NSE" },
  { symbol:"TCS",        name:"Tata Consultancy",    token:"11536", exchange:"NSE" },
  { symbol:"HDFCBANK",   name:"HDFC Bank",           token:"1333",  exchange:"NSE" },
  { symbol:"INFY",       name:"Infosys",             token:"1594",  exchange:"NSE" },
  { symbol:"ICICIBANK",  name:"ICICI Bank",          token:"4963",  exchange:"NSE" },
  { symbol:"SBIN",       name:"SBI",                 token:"3045",  exchange:"NSE" },
  { symbol:"BHARTIARTL", name:"Bharti Airtel",       token:"10604", exchange:"NSE" },
  { symbol:"WIPRO",      name:"Wipro",               token:"3787",  exchange:"NSE" },
  { symbol:"HCLTECH",    name:"HCL Technologies",    token:"7229",  exchange:"NSE" },
  { symbol:"AXISBANK",   name:"Axis Bank",           token:"5900",  exchange:"NSE" },
];
const BASE_PRICES = {
  RELIANCE:2945, TCS:3812, HDFCBANK:1678, INFY:1523, ICICIBANK:1245,
  SBIN:812, BHARTIARTL:1634, WIPRO:467, HCLTECH:1589, AXISBANK:1123,
};
const REFRESH_SECS = 15;
const STORE_KEY = "nse_journal_v4";

// ─── STORAGE ─────────────────────────────────────────────────────────────────
// Uses localStorage — works perfectly on Vercel (real browser environment)
const Storage = {
  load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch { return []; }
  },
  save(trades) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(trades)); }
    catch {}
  },
};

// ─── ANGEL ONE API ────────────────────────────────────────────────────────────
// All calls go to /api/proxy on same domain — zero CORS issues on Vercel
function proxy(path) {
  return `/api/proxy?path=${encodeURIComponent(path)}`;
}
function aH(apiKey, jwt = "") {
  return {
    "Content-Type": "application/json", "Accept": "application/json",
    "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "106.193.147.98",
    "X-MACAddress": "fe80::216e:6507:4b90:3719",
    "X-PrivateKey": apiKey,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}
async function apiLogin(clientId, mpin, totp, apiKey) {
  const r = await fetch(proxy("/rest/auth/angelbroking/user/v1/loginByPassword"), {
    method: "POST", headers: aH(apiKey),
    body: JSON.stringify({ clientcode: clientId, password: mpin, totp }),
  });
  return r.json();
}
async function apiQuote(tokens, jwt, apiKey) {
  const r = await fetch(proxy("/rest/secure/angelbroking/market/v1/quote/"), {
    method: "POST", headers: aH(apiKey, jwt),
    body: JSON.stringify({ mode: "FULL", exchangeTokens: { NSE: tokens } }),
  });
  return r.json();
}
async function apiPlaceOrder(session, { symbol, token, exchange, action, qty, price, sl }) {
  const r = await fetch(proxy("/rest/secure/angelbroking/order/v1/placeOrder"), {
    method: "POST", headers: aH(session.apiKey, session.jwt),
    body: JSON.stringify({
      variety: "NORMAL", tradingsymbol: `${symbol}-EQ`, symboltoken: token,
      transactiontype: action, exchange, ordertype: "LIMIT",
      producttype: "INTRADAY", duration: "DAY",
      price: Number(price).toFixed(2), stoploss: Number(sl).toFixed(2),
      squareoff: "0", quantity: String(qty),
    }),
  });
  return r.json();
}
async function apiPositions(session) {
  const r = await fetch(proxy("/rest/secure/angelbroking/order/v1/getPosition"), {
    method: "GET", headers: aH(session.apiKey, session.jwt),
  });
  return r.json();
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
function calcRSI(cls, p = 14) {
  if (cls.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = cls.length - p; i < cls.length; i++) {
    const d = cls[i] - cls[i - 1]; d > 0 ? (g += d) : (l -= d);
  }
  return 100 - 100 / (1 + g / (l || 0.001));
}
function ema(arr, p) {
  const k = 2 / (p + 1); let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function calcMACD(cls) { return cls.length < 26 ? 0 : ema(cls.slice(-12), 12) - ema(cls.slice(-26), 26); }

function getSignal(rsi, macd, ltp, vwap, chg) {
  let s = 0;
  if (rsi < 35) s += 2; else if (rsi < 45) s += 1; else if (rsi > 65) s -= 2; else if (rsi > 55) s -= 1;
  s += macd > 0 ? 1 : -1; s += ltp > vwap ? 1 : -1; s += chg > 0.5 ? 1 : chg < -0.5 ? -1 : 0;
  if (s >= 3)  return { label:"STRONG BUY", action:"BUY",  color:"#00e676", dim:"rgba(0,230,118,0.12)",  border:"rgba(0,230,118,0.35)",  emoji:"🟢", conf:"HIGH",   tip:"All 3 indicators aligned. Best entry." };
  if (s >= 1)  return { label:"BUY",        action:"BUY",  color:"#69f0ae", dim:"rgba(105,240,174,0.08)",border:"rgba(105,240,174,0.3)", emoji:"🟢", conf:"MEDIUM", tip:"Majority bullish. Use tight stop loss." };
  if (s <= -3) return { label:"STRONG SELL",action:"SELL", color:"#ff1744", dim:"rgba(255,23,68,0.12)",  border:"rgba(255,23,68,0.35)",  emoji:"🔴", conf:"HIGH",   tip:"All 3 indicators negative. Exit now." };
  if (s <= -1) return { label:"SELL",       action:"SELL", color:"#ff5252", dim:"rgba(255,82,82,0.08)",  border:"rgba(255,82,82,0.3)",   emoji:"🔴", conf:"MEDIUM", tip:"Bearish momentum. Consider exiting." };
  return         { label:"HOLD",            action:"HOLD", color:"#ffd740", dim:"rgba(255,215,64,0.08)", border:"rgba(255,215,64,0.25)", emoji:"⚪", conf:"LOW",    tip:"Mixed signals. Wait for clearer direction." };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const f2  = n => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fv  = n => n>=1e7?(n/1e7).toFixed(1)+"Cr":n>=1e5?(n/1e5).toFixed(1)+"L":n>=1e3?(n/1e3).toFixed(0)+"K":String(n);
const pct = n => `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`;
const ts  = () => new Date().toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
const tod = () => new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
const isOpen = () => { const n=new Date(),d=n.getDay(),m=n.getHours()*60+n.getMinutes(); return d>0&&d<6&&m>=555&&m<=930; };

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
function Spark({ pts, color }) {
  if (!pts || pts.length < 2) return null;
  const mn = Math.min(...pts), mx = Math.max(...pts), r = mx - mn || 1;
  const d = pts.map((v, i) => `${i===0?"M":"L"}${(i/(pts.length-1))*76+2},${20-((v-mn)/r)*16}`).join(" ");
  return (
    <svg viewBox="0 0 80 22" width="80" height="22">
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={78} cy={20-((pts[pts.length-1]-mn)/r)*16} r="2.5" fill={color}/>
    </svg>
  );
}

// ─── BANNER ───────────────────────────────────────────────────────────────────
function Banner({ msg, color, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position:"fixed", top:"66px", left:"50%", transform:"translateX(-50%)", zIndex:900,
      background:"#080c14", border:`2px solid ${color}`, borderRadius:"12px", padding:"11px 22px",
      color, fontWeight:"700", fontSize:"13px", fontFamily:"'JetBrains Mono',monospace",
      boxShadow:`0 8px 32px ${color}44`, animation:"slideDown 0.3s ease", whiteSpace:"nowrap" }}>
      {msg}
    </div>
  );
}

// ─── ALERT TOAST ─────────────────────────────────────────────────────────────
function AlertToast({ alerts, onDismiss, onAct }) {
  if (!alerts.length) return null;
  const a = alerts[0], buy = a.action === "BUY", ac = buy ? "#00e676" : "#ff1744";
  return (
    <div style={{ position:"fixed", top:"66px", left:"50%", transform:"translateX(-50%)", zIndex:800, width:"94%", maxWidth:"400px", animation:"slideDown 0.4s ease" }}>
      <div style={{ background:"#080c14", border:`2px solid ${ac}`, borderRadius:"16px", overflow:"hidden", boxShadow:`0 16px 48px ${ac}33` }}>
        <div style={{ background:`linear-gradient(135deg,${ac}18,transparent)`, padding:"14px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"8px" }}>
            <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
              <span style={{ fontSize:"20px" }}>{a.label.startsWith("STRONG")?"🚨":buy?"📈":"📉"}</span>
              <div>
                <div style={{ color:ac, fontWeight:"800", fontSize:"13px" }}>{a.label} — {a.symbol}</div>
                <div style={{ color:"#5a6370", fontSize:"9px" }}>{a.name} · {a.time}</div>
              </div>
            </div>
            <button onClick={() => onDismiss(a.id)} style={{ background:"none", border:"none", color:"#5a6370", cursor:"pointer", fontSize:"22px", lineHeight:1 }}>×</button>
          </div>
          <div style={{ color:"#c9d1d9", fontSize:"10px", marginBottom:"9px" }}>{a.reason}</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"5px", marginBottom:"9px" }}>
            {[["Entry",`₹${f2(a.ltp)}`,"#e8eaf0"],["Target",`₹${f2(buy?a.ltp*1.015:a.ltp*0.985)}`,"#00e676"],["SL",`₹${f2(buy?a.ltp*0.99:a.ltp*1.01)}`,"#ff5252"]].map(([k,v,c]) => (
              <div key={k} style={{ background:"#0d1219", borderRadius:"6px", padding:"6px", textAlign:"center" }}>
                <div style={{ color:"#5a6370", fontSize:"8px" }}>{k}</div>
                <div style={{ color:c, fontWeight:"700", fontSize:"10px", fontFamily:"monospace" }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:"6px" }}>
            <button onClick={() => onAct(a)} style={{ flex:2, background:`linear-gradient(135deg,${buy?"#00c853,#00e676":"#c62828,#ff1744"})`, border:"none", borderRadius:"8px", color:"#fff", padding:"9px", fontSize:"11px", fontWeight:"800", cursor:"pointer" }}>Trade Now</button>
            <button onClick={() => onDismiss(a.id)} style={{ flex:1, background:"#1a2030", border:"1px solid #2a3040", borderRadius:"8px", color:"#8b949e", padding:"9px", fontSize:"10px", cursor:"pointer" }}>Skip</button>
          </div>
        </div>
        {alerts.length > 1 && <div style={{ padding:"5px", background:"#060810", borderTop:`1px solid ${ac}22`, color:"#5a6370", fontSize:"9px", textAlign:"center" }}>+{alerts.length-1} more</div>}
      </div>
    </div>
  );
}

// ─── ORDER MODAL ──────────────────────────────────────────────────────────────
function OrderModal({ stock, initAction, session, onClose, onTradeLogged }) {
  const isDemo = session.demo;
  const [action, setAction] = useState(initAction || "BUY");
  const [qty, setQty] = useState("1");
  const [step, setStep] = useState("form");
  const [orderId, setOrderId] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const buy = action === "BUY", ac = buy ? "#00e676" : "#ff1744";
  const entry = Number(stock.ltp), target = buy?entry*1.015:entry*0.985, sl = buy?entry*0.99:entry*1.01;
  const q = parseInt(qty) || 1, risk = Math.abs(entry-sl)*q, reward = Math.abs(target-entry)*q;
  const rr = risk > 0 ? (reward/risk).toFixed(1) : "—";

  const place = async () => {
    setStep("loading");
    try {
      if (isDemo) {
        await new Promise(r => setTimeout(r, 900));
        const id = "DEMO" + Date.now();
        setOrderId(id); setStep("success");
        onTradeLogged({ id:Date.now(), date:tod(), time:ts(), symbol:stock.symbol, name:stock.name, token:stock.token, exchange:stock.exchange, action, qty:q, entryPrice:entry, targetPrice:target, stopLoss:sl, signal:stock.signal.label, confidence:stock.signal.conf, rsi:Number(stock.rsi).toFixed(1), macd:Number(stock.macd).toFixed(2), vwapPosition:stock.ltp>=stock.vwap?"Above":"Below", status:"OPEN", isLive:false, orderId:id, exitPrice:null, exitTime:null, pnl:null, pnlPct:null, result:null });
      } else {
        const res = await apiPlaceOrder(session, { symbol:stock.symbol, token:stock.token, exchange:stock.exchange, action, qty:q, price:entry, sl });
        if (res.status && res.data?.orderid) {
          const id = res.data.orderid;
          setOrderId(id); setStep("success");
          onTradeLogged({ id:Date.now(), date:tod(), time:ts(), symbol:stock.symbol, name:stock.name, token:stock.token, exchange:stock.exchange, action, qty:q, entryPrice:entry, targetPrice:target, stopLoss:sl, signal:stock.signal.label, confidence:stock.signal.conf, rsi:Number(stock.rsi).toFixed(1), macd:Number(stock.macd).toFixed(2), vwapPosition:stock.ltp>=stock.vwap?"Above":"Below", status:"OPEN", isLive:true, orderId:id, exitPrice:null, exitTime:null, pnl:null, pnlPct:null, result:null });
        } else { setErrMsg(res.message || "Order rejected. Try again."); setStep("error"); }
      }
    } catch (e) { setErrMsg("Order failed: " + e.message); setStep("error"); }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.94)", zIndex:700, display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }} onClick={onClose}>
      <div style={{ background:"#080c14", border:`1px solid ${ac}44`, borderRadius:"22px", width:"100%", maxWidth:"420px", overflow:"hidden" }} onClick={e => e.stopPropagation()}>
        {step==="success" && (
          <div style={{ padding:"40px 24px", textAlign:"center" }}>
            <div style={{ fontSize:"56px", marginBottom:"12px" }}>✅</div>
            <div style={{ color:"#00e676", fontWeight:"800", fontSize:"20px", marginBottom:"8px" }}>{isDemo?"Demo Order Placed!":"Order Placed on NSE!"}</div>
            <div style={{ color:"#5a6370", fontSize:"11px", marginBottom:"4px" }}>Order ID: <span style={{ color:"#58a6ff", fontFamily:"monospace" }}>{orderId}</span></div>
            <div style={{ background:"rgba(0,230,118,0.08)", border:"1px solid rgba(0,230,118,0.2)", borderRadius:"10px", padding:"10px 14px", margin:"14px 0", color:"#8b949e", fontSize:"11px" }}>📓 Trade auto-saved to Journal</div>
            <button onClick={onClose} style={{ background:"#1f6feb", border:"none", borderRadius:"10px", color:"#fff", padding:"10px 32px", cursor:"pointer", fontSize:"13px", fontWeight:"700" }}>Done — View Journal</button>
          </div>
        )}
        {step==="error" && (
          <div style={{ padding:"40px 24px", textAlign:"center" }}>
            <div style={{ fontSize:"52px", marginBottom:"12px" }}>❌</div>
            <div style={{ color:"#ff1744", fontWeight:"800", fontSize:"18px", marginBottom:"10px" }}>Order Failed</div>
            <div style={{ color:"#ff5252", fontSize:"12px", marginBottom:"16px" }}>{errMsg}</div>
            <div style={{ display:"flex", gap:"8px", justifyContent:"center" }}>
              <button onClick={() => setStep("form")} style={{ background:"#1f6feb", border:"none", borderRadius:"10px", color:"#fff", padding:"10px 20px", cursor:"pointer", fontSize:"12px", fontWeight:"700" }}>Try Again</button>
              <button onClick={onClose} style={{ background:"#1a2030", border:"1px solid #2a3040", borderRadius:"10px", color:"#8b949e", padding:"10px 20px", cursor:"pointer", fontSize:"12px" }}>Cancel</button>
            </div>
          </div>
        )}
        {step==="loading" && (
          <div style={{ padding:"48px 24px", textAlign:"center" }}>
            <div style={{ width:"44px", height:"44px", border:`3px solid #1a2030`, borderTopColor:ac, borderRadius:"50%", animation:"spin 0.8s linear infinite", margin:"0 auto 16px" }}/>
            <div style={{ color:"#8b949e", fontSize:"13px" }}>{isDemo?"Simulating order...":"Placing order on NSE..."}</div>
          </div>
        )}
        {step==="form" && (
          <>
            <div style={{ background:`linear-gradient(135deg,${ac}18,transparent)`, borderBottom:`1px solid ${ac}22`, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ color:"#e8eaf0", fontWeight:"800", fontSize:"16px" }}>{buy?"📈":"📉"} Place Order — {stock.symbol}</div>
                <div style={{ color:"#5a6370", fontSize:"9px", marginTop:"2px" }}>{stock.name} · NSE Intraday · {isDemo?"🎮 Demo":"⚡ LIVE"}</div>
              </div>
              <button onClick={onClose} style={{ background:"#161b22", border:"1px solid #21262d", borderRadius:"7px", color:"#8b949e", padding:"5px 10px", cursor:"pointer", fontSize:"12px" }}>✕</button>
            </div>
            <div style={{ padding:"16px 20px" }}>
              <div style={{ background:stock.signal.dim, border:`1px solid ${stock.signal.border}`, borderRadius:"9px", padding:"9px 12px", marginBottom:"13px" }}>
                <div style={{ color:stock.signal.color, fontWeight:"700", fontSize:"11px" }}>{stock.signal.emoji} {stock.signal.label} · {stock.signal.conf}</div>
                <div style={{ color:"#8b949e", fontSize:"10px", marginTop:"2px" }}>{stock.signal.tip}</div>
              </div>
              <div style={{ display:"flex", background:"#0d1219", borderRadius:"10px", padding:"3px", marginBottom:"13px", border:"1px solid #1e2530" }}>
                {["BUY","SELL"].map(a => (
                  <button key={a} onClick={() => setAction(a)} style={{ flex:1, padding:"8px", borderRadius:"8px", border:"none", background:action===a?(a==="BUY"?"rgba(0,230,118,0.18)":"rgba(255,23,68,0.18)"):"transparent", color:action===a?(a==="BUY"?"#00e676":"#ff1744"):"#5a6370", fontWeight:"700", fontSize:"13px", cursor:"pointer" }}>
                    {a==="BUY"?"📈 BUY":"📉 SELL"}
                  </button>
                ))}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"7px", marginBottom:"13px" }}>
                {[["Entry",`₹${f2(entry)}`,"#e8eaf0"],["Target",`₹${f2(target)}`,"#00e676"],["Stop Loss",`₹${f2(sl)}`,"#ff5252"]].map(([k,v,c]) => (
                  <div key={k} style={{ background:"#0d1219", borderRadius:"8px", padding:"9px", textAlign:"center", border:"1px solid #1e2530" }}>
                    <div style={{ color:"#5a6370", fontSize:"9px", marginBottom:"2px" }}>{k}</div>
                    <div style={{ color:c, fontWeight:"700", fontSize:"12px", fontFamily:"monospace" }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"9px", marginBottom:"13px" }}>
                <div>
                  <div style={{ color:"#5a6370", fontSize:"10px", marginBottom:"5px" }}>QUANTITY (shares)</div>
                  <input type="number" value={qty} min="1" onChange={e => setQty(e.target.value)}
                    style={{ width:"100%", background:"#0d1219", border:"1px solid #1e2530", borderRadius:"8px", padding:"10px 12px", color:"#e8eaf0", fontSize:"15px", fontFamily:"monospace", outline:"none" }}/>
                </div>
                <div>
                  <div style={{ color:"#5a6370", fontSize:"10px", marginBottom:"5px" }}>RISK : REWARD</div>
                  <div style={{ background:"#0d1219", border:"1px solid #1e2530", borderRadius:"8px", padding:"10px 12px" }}>
                    <div style={{ color:parseFloat(rr)>=1.5?"#00e676":"#ffd740", fontWeight:"800", fontSize:"15px" }}>1 : {rr}</div>
                    <div style={{ color:"#5a6370", fontSize:"9px", marginTop:"1px" }}>Risk ₹{f2(risk)}</div>
                  </div>
                </div>
              </div>
              <div style={{ background:"#0d1219", border:"1px solid #1e2530", borderRadius:"8px", padding:"9px 12px", marginBottom:"13px", display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#5a6370", fontSize:"11px" }}>Total Value</span>
                <span style={{ color:"#e8eaf0", fontWeight:"700", fontFamily:"monospace" }}>₹{f2(entry*q)}</span>
              </div>
              {!isDemo && <div style={{ background:"rgba(255,215,64,0.07)", border:"1px solid rgba(255,215,64,0.2)", borderRadius:"8px", padding:"8px 12px", marginBottom:"13px" }}><span style={{ color:"#ffd740", fontSize:"10px" }}>⚡ LIVE — This places a REAL order on NSE with real money.</span></div>}
              <button onClick={place} style={{ width:"100%", background:`linear-gradient(135deg,${buy?"#00c853,#00e676":"#c62828,#ff1744"})`, border:"none", borderRadius:"10px", color:"#fff", padding:"13px", fontSize:"14px", fontWeight:"800", cursor:"pointer" }}>
                {buy?"📈 BUY":"📉 SELL"} {q} × {stock.symbol} {isDemo?"(Demo)":"(LIVE)"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── CLOSE TRADE MODAL ────────────────────────────────────────────────────────
function CloseModal({ trade, ltp, onClose, onSave }) {
  const [ep, setEp] = useState(String(Number(ltp||trade.entryPrice).toFixed(2)));
  const exitP = parseFloat(ep)||trade.entryPrice, buy = trade.action==="BUY";
  const rawPnl = buy?(exitP-trade.entryPrice)*trade.qty:(trade.entryPrice-exitP)*trade.qty;
  const pnlPct = (exitP-trade.entryPrice)/trade.entryPrice*100*(buy?1:-1), win = rawPnl>0;
  const save = () => { onSave({...trade,exitPrice:exitP,exitTime:ts(),pnl:rawPnl,pnlPct,result:rawPnl>0?"WIN":rawPnl<0?"LOSS":"BREAKEVEN",status:"CLOSED"}); onClose(); };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:700, display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }} onClick={onClose}>
      <div style={{ background:"#080c14", border:"1px solid #21262d", borderRadius:"20px", width:"100%", maxWidth:"360px" }} onClick={e => e.stopPropagation()}>
        <div style={{ padding:"16px 20px", borderBottom:"1px solid #1a2030", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ color:"#e8eaf0", fontWeight:"800", fontSize:"15px" }}>📤 Close — {trade.symbol}</div>
          <button onClick={onClose} style={{ background:"#161b22", border:"1px solid #21262d", borderRadius:"7px", color:"#8b949e", padding:"4px 9px", cursor:"pointer", fontSize:"12px" }}>✕</button>
        </div>
        <div style={{ padding:"16px 20px" }}>
          <div style={{ color:"#5a6370", fontSize:"10px", marginBottom:"5px" }}>EXIT PRICE (₹)</div>
          <input type="number" value={ep} onChange={e => setEp(e.target.value)} step="0.05"
            style={{ width:"100%", background:"#0d1219", border:"1px solid #1e2530", borderRadius:"8px", padding:"10px 12px", color:"#e8eaf0", fontSize:"16px", fontFamily:"monospace", outline:"none", marginBottom:"13px" }}/>
          <div style={{ background:win?"rgba(0,230,118,0.1)":"rgba(255,23,68,0.1)", border:`1px solid ${win?"rgba(0,230,118,0.3)":"rgba(255,23,68,0.3)"}`, borderRadius:"10px", padding:"14px", marginBottom:"13px", textAlign:"center" }}>
            <div style={{ color:win?"#00e676":"#ff1744", fontWeight:"800", fontSize:"26px", fontFamily:"monospace" }}>{win?"+":""}₹{f2(Math.abs(rawPnl))}</div>
            <div style={{ color:win?"#00e676":"#ff5252", fontSize:"11px", marginTop:"2px" }}>{pct(pnlPct)} · {win?"✅ WIN":"❌ LOSS"}</div>
          </div>
          <button onClick={save} style={{ width:"100%", background:win?"linear-gradient(135deg,#00c853,#00e676)":"linear-gradient(135deg,#c62828,#ff1744)", border:"none", borderRadius:"10px", color:"#fff", padding:"12px", fontSize:"14px", fontWeight:"800", cursor:"pointer" }}>
            {win?"✅ Book Profit":"❌ Book Loss"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── POSITIONS PANEL ─────────────────────────────────────────────────────────
function PositionsPanel({ session, onClose }) {
  const [pos, setPos] = useState([]); const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (session.demo) { setPos([{tradingsymbol:"RELIANCE-EQ",netqty:"3",buyavgprice:"2941.50",ltp:"2958.20",unrealised:"50.10",realised:"0"},{tradingsymbol:"TCS-EQ",netqty:"-2",buyavgprice:"3815.00",ltp:"3800.50",unrealised:"29.00",realised:"0"}]); setLoading(false); return; }
    apiPositions(session).then(r => { setPos(r?.data||[]); setLoading(false); }).catch(() => { setPos([]); setLoading(false); });
  }, []);
  const totalPnl = pos.reduce((s,p) => s+(parseFloat(p.unrealised)||0)+(parseFloat(p.realised)||0), 0);
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:700, display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }} onClick={onClose}>
      <div style={{ background:"#080c14", border:"1px solid #21262d", borderRadius:"20px", width:"100%", maxWidth:"460px", overflow:"hidden" }} onClick={e => e.stopPropagation()}>
        <div style={{ padding:"16px 20px", borderBottom:"1px solid #1a2030", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div><div style={{ color:"#e8eaf0", fontWeight:"800", fontSize:"16px" }}>📋 Today's Positions</div><div style={{ color:"#5a6370", fontSize:"9px", marginTop:"2px" }}>{session.demo?"Demo":"Live NSE"}</div></div>
          <div style={{ textAlign:"right" }}><div style={{ color:totalPnl>=0?"#00e676":"#ff1744", fontWeight:"800", fontSize:"20px", fontFamily:"monospace" }}>{totalPnl>=0?"+":""}₹{f2(Math.abs(totalPnl))}</div><div style={{ color:"#5a6370", fontSize:"9px" }}>Total P&L</div></div>
        </div>
        <div style={{ padding:"14px 20px", maxHeight:"360px", overflowY:"auto" }}>
          {loading?<div style={{textAlign:"center",padding:"28px",color:"#5a6370"}}><div style={{width:"22px",height:"22px",border:"2px solid #21262d",borderTopColor:"#58a6ff",borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 10px"}}/>Loading...</div>
          :pos.length===0?<div style={{textAlign:"center",padding:"28px",color:"#5a6370"}}>No open positions today.</div>
          :pos.map((p,i)=>{const pnl=(parseFloat(p.unrealised)||0)+(parseFloat(p.realised)||0),qty=parseInt(p.netqty),long=qty>0;return(<div key={i} style={{background:"#0d1219",border:"1px solid #21262d",borderRadius:"11px",padding:"13px",marginBottom:"8px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"7px"}}><div><span style={{color:"#e8eaf0",fontWeight:"700",fontSize:"13px",fontFamily:"monospace"}}>{p.tradingsymbol?.replace("-EQ","")}</span><span style={{marginLeft:"7px",background:long?"rgba(0,230,118,0.12)":"rgba(255,23,68,0.12)",color:long?"#00e676":"#ff1744",padding:"1px 7px",borderRadius:"8px",fontSize:"9px",fontWeight:"700"}}>{long?"LONG":"SHORT"} {Math.abs(qty)}</span></div><div style={{color:pnl>=0?"#00e676":"#ff1744",fontWeight:"800",fontSize:"15px",fontFamily:"monospace"}}>{pnl>=0?"+":""}₹{f2(Math.abs(pnl))}</div></div><div style={{display:"flex",gap:"14px"}}><div><div style={{color:"#5a6370",fontSize:"9px"}}>AVG</div><div style={{color:"#8b949e",fontSize:"11px",fontFamily:"monospace"}}>₹{f2(p.buyavgprice)}</div></div><div><div style={{color:"#5a6370",fontSize:"9px"}}>LTP</div><div style={{color:"#e8eaf0",fontSize:"11px",fontFamily:"monospace"}}>₹{f2(p.ltp)}</div></div></div></div>);})}
        </div>
        <div style={{padding:"10px 20px",borderTop:"1px solid #1a2030",textAlign:"center"}}><button onClick={onClose} style={{background:"#1f6feb",border:"none",borderRadius:"9px",color:"#fff",padding:"9px 28px",cursor:"pointer",fontSize:"12px",fontWeight:"700"}}>Close</button></div>
      </div>
    </div>
  );
}

// ─── JOURNAL TAB ─────────────────────────────────────────────────────────────
function JournalTab({ trades, stocks, onClose, onDelete }) {
  const [view, setView] = useState("open");
  const closed=trades.filter(t=>t.status==="CLOSED"), open=trades.filter(t=>t.status==="OPEN");
  const wins=closed.filter(t=>t.result==="WIN").length, losses=closed.filter(t=>t.result==="LOSS").length;
  const totalPnl=closed.reduce((s,t)=>s+(t.pnl||0),0);
  const winRate=closed.length>0?((wins/closed.length)*100).toFixed(0):"0";
  const avgWin=wins>0?closed.filter(t=>t.result==="WIN").reduce((s,t)=>s+(t.pnl||0),0)/wins:0;
  const avgLoss=losses>0?closed.filter(t=>t.result==="LOSS").reduce((s,t)=>s+Math.abs(t.pnl||0),0)/losses:0;
  const expectancy=closed.length>0?(wins/closed.length)*avgWin-(losses/closed.length)*avgLoss:0;
  const getLTP=sym=>stocks.find(s=>s.symbol===sym)?.ltp||0;

  if (trades.length===0) return (
    <div style={{padding:"48px 20px",textAlign:"center"}}>
      <div style={{fontSize:"52px",marginBottom:"14px"}}>📓</div>
      <div style={{color:"#8b949e",fontWeight:"800",fontSize:"15px",marginBottom:"10px"}}>Journal is Empty</div>
      <div style={{color:"#5a6370",fontSize:"11px",lineHeight:"2"}}>Go to <span style={{color:"#ff6b35"}}>Market tab</span> → spot a signal → tap <b style={{color:"#e8eaf0"}}>BUY / SELL</b> ��� confirm → <span style={{color:"#00e676"}}>auto-saved here!</span></div>
    </div>
  );

  return (
    <div style={{padding:"13px 14px"}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"7px",marginBottom:"12px"}}>
        {[["P&L",totalPnl>=0?`+₹${f2(totalPnl)}`:`-₹${f2(Math.abs(totalPnl))}`,totalPnl>=0?"#00e676":"#ff1744"],["Win Rate",`${winRate}%`,parseFloat(winRate)>=55?"#00e676":parseFloat(winRate)>=40?"#ffd740":"#ff5252"],["W / L",`${wins} / ${losses}`,"#e8eaf0"],["Avg Win",`+₹${f2(avgWin)}`,"#00e676"],["Avg Loss",`-₹${f2(avgLoss)}`,"#ff5252"],["Expectancy",`₹${f2(expectancy)}`,expectancy>=0?"#00e676":"#ff5252"]].map(([k,v,c])=>(
          <div key={k} style={{background:"#0a0d14",border:"1px solid #1a2030",borderRadius:"10px",padding:"10px"}}>
            <div style={{color:"#5a6370",fontSize:"9px",marginBottom:"3px"}}>{k.toUpperCase()}</div>
            <div style={{color:c,fontWeight:"800",fontSize:"13px",fontFamily:"monospace"}}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",borderBottom:"1px solid #1a2030",marginBottom:"10px"}}>
        {[["open",`Open (${open.length})`],["closed",`Closed (${closed.length})`]].map(([id,label])=>(
          <button key={id} onClick={()=>setView(id)} style={{background:"none",border:"none",borderBottom:`2px solid ${view===id?"#ff6b35":"transparent"}`,color:view===id?"#ff6b35":"#5a6370",padding:"7px 12px",cursor:"pointer",fontSize:"11px",fontWeight:"600"}}>
            {label}
          </button>
        ))}
      </div>
      {view==="open"&&(open.length===0?<div style={{textAlign:"center",padding:"24px",color:"#5a6370",fontSize:"12px"}}>No open trades.</div>:open.map(t=>{
        const lp=getLTP(t.symbol),buy=t.action==="BUY",livePnl=lp>0?(buy?(lp-t.entryPrice)*t.qty:(t.entryPrice-lp)*t.qty):0,win=livePnl>0;
        return(<div key={t.id} style={{background:"#0a0d14",border:`1px solid ${win?"rgba(0,230,118,0.22)":"rgba(255,82,82,0.15)"}`,borderRadius:"13px",padding:"12px",marginBottom:"9px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"7px"}}>
            <div>
              <div style={{display:"flex",gap:"5px",alignItems:"center",marginBottom:"2px"}}>
                <span style={{color:"#e8eaf0",fontWeight:"700",fontSize:"14px"}}>{t.symbol}</span>
                <span style={{background:buy?"rgba(0,230,118,0.12)":"rgba(255,23,68,0.12)",color:buy?"#00e676":"#ff1744",padding:"1px 6px",borderRadius:"8px",fontSize:"9px",fontWeight:"700"}}>{t.action}</span>
                <span style={{background:t.isLive?"rgba(0,230,118,0.1)":"rgba(88,166,255,0.1)",color:t.isLive?"#00e676":"#58a6ff",padding:"1px 6px",borderRadius:"7px",fontSize:"8px",fontWeight:"700"}}>{t.isLive?"⚡LIVE":"🎮DEMO"}</span>
              </div>
              <div style={{color:"#5a6370",fontSize:"9px"}}>{t.qty} shares · Entry ₹{f2(t.entryPrice)} · {t.date} {t.time}</div>
            </div>
            <div style={{textAlign:"right"}}><div style={{color:win?"#00e676":"#ff5252",fontWeight:"800",fontSize:"15px",fontFamily:"monospace"}}>{win?"+":""}₹{f2(Math.abs(livePnl))}</div><div style={{color:"#5a6370",fontSize:"8px"}}>Live P&L</div></div>
          </div>
          <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"8px"}}>
            {[["Signal",t.signal,t.signal.includes("BUY")?"#00e676":"#ff5252"],["RSI",t.rsi,"#ffd740"],["TGT",`₹${f2(t.targetPrice)}`,"#00e676"],["SL",`₹${f2(t.stopLoss)}`,"#ff5252"]].map(([k,v,c])=>(
              <div key={k} style={{background:"#0d1219",border:"1px solid #1e2530",borderRadius:"5px",padding:"3px 6px",fontSize:"9px"}}><span style={{color:"#5a6370"}}>{k}: </span><span style={{color:c,fontWeight:"600"}}>{v}</span></div>
            ))}
          </div>
          <div style={{display:"flex",gap:"5px"}}>
            <button onClick={()=>onClose(t)} style={{flex:2,background:win?"rgba(0,230,118,0.1)":"rgba(255,82,82,0.1)",border:`1px solid ${win?"rgba(0,230,118,0.3)":"rgba(255,82,82,0.25)"}`,borderRadius:"7px",color:win?"#00e676":"#ff5252",padding:"7px",fontSize:"10px",fontWeight:"700",cursor:"pointer"}}>{win?"✅ Book Profit":"❌ Close Trade"}</button>
            <button onClick={()=>onDelete(t.id)} style={{flex:1,background:"#0d1219",border:"1px solid #1e2530",borderRadius:"7px",color:"#5a6370",padding:"7px",fontSize:"9px",cursor:"pointer"}}>🗑</button>
          </div>
        </div>);
      }))}
      {view==="closed"&&(closed.length===0?<div style={{textAlign:"center",padding:"24px",color:"#5a6370",fontSize:"12px"}}>No closed trades yet.</div>:closed.map(t=>{
        const win=t.result==="WIN";
        return(<div key={t.id} style={{background:"#0a0d14",border:`1px solid ${win?"rgba(0,230,118,0.15)":"rgba(255,23,68,0.12)"}`,borderRadius:"11px",padding:"11px",marginBottom:"7px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{display:"flex",gap:"5px",alignItems:"center",marginBottom:"2px"}}>
                <span style={{color:"#e8eaf0",fontWeight:"700",fontSize:"13px"}}>{t.symbol}</span>
                <span style={{color:t.action==="BUY"?"#00e676":"#ff5252",fontSize:"9px",fontWeight:"700"}}>{t.action}</span>
                <span style={{background:win?"rgba(0,230,118,0.1)":"rgba(255,23,68,0.1)",color:win?"#00e676":"#ff1744",padding:"1px 6px",borderRadius:"7px",fontSize:"9px",fontWeight:"700"}}>{t.result}</span>
                <span style={{background:t.isLive?"rgba(0,230,118,0.1)":"rgba(88,166,255,0.1)",color:t.isLive?"#00e676":"#58a6ff",padding:"1px 5px",borderRadius:"6px",fontSize:"8px"}}>{t.isLive?"⚡":"🎮"}</span>
              </div>
              <div style={{color:"#5a6370",fontSize:"9px"}}>{t.qty} sh · ₹{f2(t.entryPrice)}→₹{f2(t.exitPrice)} · {t.date}</div>
            </div>
            <div style={{textAlign:"right"}}><div style={{color:win?"#00e676":"#ff5252",fontWeight:"800",fontSize:"14px",fontFamily:"monospace"}}>{win?"+":""}₹{f2(Math.abs(t.pnl||0))}</div><div style={{color:"#5a6370",fontSize:"9px"}}>{pct(t.pnlPct||0)}</div></div>
          </div>
        </div>);
      }))}
    </div>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ onConnect }) {
  const [f, setF] = useState({ apiKey:"", clientId:"", mpin:"", totp:"" });
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const set = k => e => setF(p => ({...p,[k]:e.target.value}));
  const inp = { width:"100%", background:"#0d1219", border:"1px solid #1e2530", borderRadius:"10px", padding:"11px 14px", color:"#e8eaf0", fontSize:"14px", fontFamily:"monospace", outline:"none" };

  const connect = async () => {
    if (!f.apiKey||!f.clientId||!f.mpin||!f.totp) { setErr("Please fill all 4 fields."); return; }
    setLoading(true); setErr("");
    try {
      const d = await apiLogin(f.clientId, f.mpin, f.totp, f.apiKey);
      if (d.status && d.data?.jwtToken) onConnect({ ...f, jwt:d.data.jwtToken, live:true });
      else setErr(d.message || "Login failed. Check credentials and TOTP.");
    } catch (e) { setErr("Connection failed: " + e.message); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight:"100vh", background:"#060810", display:"flex", alignItems:"center", justifyContent:"center", padding:"20px", fontFamily:"'JetBrains Mono',monospace" }}>
      <div style={{ width:"100%", maxWidth:"400px" }}>
        <div style={{ textAlign:"center", marginBottom:"24px" }}>
          <div style={{ width:"60px", height:"60px", background:"linear-gradient(135deg,#ff6b35,#ff9800)", borderRadius:"18px", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"28px", margin:"0 auto 12px" }}>📡</div>
          <div style={{ fontSize:"22px", fontWeight:"800", color:"#e8eaf0" }}><span style={{ color:"#ff6b35" }}>NSE</span> Live Trading</div>
          <div style={{ color:"#5a6370", fontSize:"11px", marginTop:"3px" }}>Angel One SmartAPI</div>
        </div>
        <div style={{ background:"#0a0d14", border:"1px solid #1a2030", borderRadius:"14px", padding:"20px" }}>
          {[["API Key","apiKey","text","From SmartAPI developer portal"],["Client ID","clientId","text","Your Angel One login ID (e.g. A123456)"],["MPIN","mpin","password","Your 4-digit Angel One MPIN"],["TOTP","totp","text","6-digit code from Google Authenticator"]].map(([label,key,type,ph]) => (
            <div key={key} style={{ marginBottom:"11px" }}>
              <div style={{ color:"#5a6370", fontSize:"10px", marginBottom:"5px" }}>{label.toUpperCase()}</div>
              <input type={type} value={f[key]} onChange={set(key)} placeholder={ph} style={inp}/>
            </div>
          ))}
          {err && <div style={{ background:"rgba(255,23,68,0.08)", border:"1px solid rgba(255,23,68,0.25)", borderRadius:"8px", padding:"9px 12px", color:"#ff5252", fontSize:"11px", marginBottom:"11px" }}>⚠️ {err}</div>}
          <button onClick={connect} disabled={loading} style={{ width:"100%", background:loading?"#1a2030":"linear-gradient(135deg,#ff6b35,#ff9800)", border:"none", borderRadius:"10px", color:"#fff", padding:"13px", fontSize:"14px", fontWeight:"800", cursor:loading?"default":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:"8px", marginBottom:"9px" }}>
            {loading?<><div style={{ width:"14px", height:"14px", border:"2px solid #ffffff44", borderTopColor:"#fff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>Connecting...</>:"⚡ Connect to Angel One"}
          </button>
          <button onClick={() => onConnect({demo:true})} style={{ width:"100%", background:"transparent", border:"1px solid #1e2530", borderRadius:"10px", color:"#5a6370", padding:"11px", cursor:"pointer", fontSize:"12px" }}>🎮 Demo Mode</button>
          <div style={{ marginTop:"12px", color:"#3d4450", fontSize:"10px", textAlign:"center" }}>🔒 Credentials sent only to Angel One. Never stored on this server.</div>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ session, onLogout }) {
  const [stocks,setStocks]=useState([]), [trades,setTrades]=useState(()=>Storage.load());
  const [alerts,setAlerts]=useState([]), [banner,setBanner]=useState(null);
  const [orderModal,setOrderModal]=useState(null), [closeModal,setCloseModal]=useState(null);
  const [showPos,setShowPos]=useState(false), [tab,setTab]=useState("market");
  const [monitoring,setMonitoring]=useState(true), [countdown,setCountdown]=useState(REFRESH_SECS);
  const [refreshing,setRefreshing]=useState(false), [lastUpdated,setLastUpdated]=useState(null);
  const [mktOpen,setMktOpen]=useState(isOpen()), [filter,setFilter]=useState("ALL");
  const histories=useRef({}), prevSigs=useRef({}), alertId=useRef(0);

  useEffect(() => { Storage.save(trades); }, [trades]);

  const demoStock = useCallback(w => {
    const base=BASE_PRICES[w.symbol]||1000, prev=histories.current[w.symbol]?.slice(-1)[0]||base;
    const ltp=Math.max(prev*.97,Math.min(prev*1.03,prev+(Math.random()-.47)*prev*.009));
    const open=histories.current[w.symbol]?.[0]||ltp, high=Math.max(open,ltp)*(1+Math.random()*.004), low=Math.min(open,ltp)*(1-Math.random()*.003);
    const vol=Math.floor(Math.random()*4000000)+200000, chg=((ltp-open)/open)*100;
    if(!histories.current[w.symbol]) histories.current[w.symbol]=[ltp];
    histories.current[w.symbol]=[...histories.current[w.symbol].slice(-29),ltp];
    const cls=histories.current[w.symbol], rsi=calcRSI(cls), macd=calcMACD(cls), vwap=(high+low+ltp)/3;
    return{...w,ltp,open,high,low,volume:vol,rsi,macd,vwap,changePct:chg,signal:getSignal(rsi,macd,ltp,vwap,chg),history:[...cls],live:false};
  },[]);

  const liveStock = useCallback(async(w,allQuotes) => {
    try {
      const q=allQuotes?.find(x=>x.symboltoken===w.token);
      if(!q) return demoStock(w);
      const ltp=parseFloat(q.ltp),open=parseFloat(q.open),high=parseFloat(q.high),low=parseFloat(q.low),vol=parseInt(q.tradevolume||q.tradeVolume||0),chg=((ltp-open)/open)*100;
      if(!histories.current[w.symbol]) histories.current[w.symbol]=[ltp];
      histories.current[w.symbol]=[...histories.current[w.symbol].slice(-29),ltp];
      const cls=histories.current[w.symbol],rsi=calcRSI(cls),macd=calcMACD(cls),vwap=(high+low+ltp)/3;
      return{...w,ltp,open,high,low,volume:vol,rsi,macd,vwap,changePct:chg,signal:getSignal(rsi,macd,ltp,vwap,chg),history:[...cls],live:true};
    } catch { return demoStock(w); }
  },[demoStock]);

  const checkAlerts = useCallback(ns => {
    const na=[];
    ns.forEach(s=>{
      const prev=prevSigs.current[s.symbol],curr=s.signal.action,strong=s.signal.label.startsWith("STRONG");
      if((prev!==undefined&&prev!==curr&&curr!=="HOLD")||(strong&&curr!=="HOLD"&&Math.random()<.08)){
        const reasons={"STRONG BUY":`RSI ${Number(s.rsi).toFixed(0)} oversold + MACD positive + Above VWAP`,"BUY":`RSI ${Number(s.rsi).toFixed(0)} bullish · ${s.macd>0?"MACD positive":"Above VWAP"}`,"STRONG SELL":`RSI ${Number(s.rsi).toFixed(0)} overbought + MACD negative + Below VWAP`,"SELL":`Bearish · ${s.macd<0?"MACD negative":"Below VWAP"}`};
        na.push({id:++alertId.current,symbol:s.symbol,name:s.name,token:s.token,exchange:s.exchange,action:curr,label:s.signal.label,ltp:s.ltp,rsi:s.rsi,macd:s.macd,vwap:s.vwap,signal:s.signal,reason:reasons[s.signal.label]||"Signal detected.",time:ts()});
      }
      prevSigs.current[s.symbol]=curr;
    });
    if(na.length) setAlerts(p=>[...na,...p].slice(0,5));
  },[]);

  const refresh = useCallback(async()=>{
    setRefreshing(true); setMktOpen(isOpen());
    try {
      let ns;
      if(session.demo){ ns=WATCHLIST.map(demoStock); }
      else {
        let allQuotes=[];
        try { const qr=await apiQuote(WATCHLIST.map(w=>w.token),session.jwt,session.apiKey); allQuotes=qr?.data?.fetched||[]; } catch {}
        ns=await Promise.all(WATCHLIST.map(w=>liveStock(w,allQuotes)));
      }
      setStocks(ns); checkAlerts(ns); setLastUpdated(new Date()); setCountdown(REFRESH_SECS);
    } catch {}
    setTimeout(()=>setRefreshing(false),300);
  },[session,demoStock,liveStock,checkAlerts]);

  useEffect(()=>{
    refresh();
    if(!monitoring) return;
    const iv=setInterval(refresh,REFRESH_SECS*1000), cd=setInterval(()=>setCountdown(c=>Math.max(0,c-1)),1000);
    return()=>{clearInterval(iv);clearInterval(cd);};
  },[monitoring]);

  const onTradeLogged = useCallback(trade => {
    setTrades(prev => { const updated=[trade,...prev]; Storage.save(updated); return updated; });
    setBanner({msg:`${trade.action==="BUY"?"📈":"📉"} ${trade.action} ${trade.qty}×${trade.symbol} saved to Journal!`,color:trade.action==="BUY"?"#00e676":"#ff5252"});
  },[]);

  const closeTrade = useCallback(updated=>{
    setTrades(prev=>{const next=prev.map(t=>t.id===updated.id?updated:t);Storage.save(next);return next;});
    setBanner({msg:updated.result==="WIN"?`✅ WIN +₹${f2(Math.abs(updated.pnl))}`:`❌ LOSS -₹${f2(Math.abs(updated.pnl))}`,color:updated.result==="WIN"?"#00e676":"#ff1744"});
  },[]);

  const deleteTrade=useCallback(id=>{setTrades(prev=>{const next=prev.filter(t=>t.id!==id);Storage.save(next);return next;});},[]);
  const dismissAlert=id=>setAlerts(p=>p.filter(a=>a.id!==id));
  const alertToTrade=a=>{setOrderModal({stock:a,action:a.action});setAlerts(p=>p.filter(x=>x.id!==a.id));};

  const filtered=filter==="ALL"?stocks:stocks.filter(s=>filter==="HOLD"?s.signal?.action==="HOLD":s.signal?.action===filter);
  const buys=stocks.filter(s=>s.signal?.action==="BUY").length, sells=stocks.filter(s=>s.signal?.action==="SELL").length, holds=stocks.filter(s=>s.signal?.action==="HOLD").length;
  const totalPnl=trades.filter(t=>t.status==="CLOSED").reduce((s,t)=>s+(t.pnl||0),0);
  const openTrades=trades.filter(t=>t.status==="OPEN");

  return (
    <div style={{ minHeight:"100vh", background:"#060810", fontFamily:"'JetBrains Mono',monospace", color:"#e8eaf0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#1e2530;border-radius:4px}
        input:focus{border-color:#ff6b35!important;outline:none}
      `}</style>

      {/* HEADER */}
      <div style={{background:"#0a0d14",borderBottom:"1px solid #1a2030",padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:"8px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          <div style={{position:"relative",width:"34px",height:"34px",flexShrink:0}}>
            <svg width="34" height="34" style={{transform:"rotate(-90deg)"}}>
              <circle cx="17" cy="17" r="13" fill="none" stroke="#1a2030" strokeWidth="3"/>
              <circle cx="17" cy="17" r="13" fill="none" stroke={monitoring?"#ff6b35":"#3d4450"} strokeWidth="3" strokeDasharray="82" strokeDashoffset={82-(countdown/REFRESH_SECS)*82} style={{transition:"stroke-dashoffset 1s linear"}}/>
            </svg>
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"9px",fontWeight:"700",color:monitoring?"#ff6b35":"#3d4450"}}>{monitoring?countdown:"⏸"}</div>
          </div>
          <div>
            <div style={{fontSize:"15px",fontWeight:"800"}}>
              <span style={{color:"#ff6b35"}}>NSE</span><span style={{color:"#e8eaf0"}}> Trading</span>
              <span style={{marginLeft:"6px",background:session.live?"rgba(0,230,118,0.12)":"rgba(88,166,255,0.1)",border:`1px solid ${session.live?"rgba(0,230,118,0.3)":"rgba(88,166,255,0.25)"}`,color:session.live?"#00e676":"#58a6ff",padding:"1px 7px",borderRadius:"5px",fontSize:"9px",fontWeight:"700"}}>{session.live?"⚡ LIVE":"🎮 DEMO"}</span>
            </div>
            <div style={{color:"#5a6370",fontSize:"9px",marginTop:"1px",display:"flex",gap:"5px",alignItems:"center"}}>
              <div style={{width:"5px",height:"5px",borderRadius:"50%",background:mktOpen?"#00e676":"#ff5252",animation:mktOpen&&monitoring?"blink 1.5s infinite":"none"}}/>
              Market {mktOpen?"OPEN":"CLOSED"} · {lastUpdated?.toLocaleTimeString("en-IN")||"—"}
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:"5px",alignItems:"center",flexWrap:"wrap"}}>
          {[["BUY","#00e676",buys],["SELL","#ff1744",sells],["HOLD","#ffd740",holds]].map(([l,c,n])=>(
            <div key={l} style={{background:`${c}11`,border:`1px solid ${c}22`,borderRadius:"6px",padding:"3px 7px",textAlign:"center",minWidth:"34px"}}>
              <div style={{color:c,fontWeight:"800",fontSize:"12px"}}>{n}</div>
              <div style={{color:"#5a6370",fontSize:"8px"}}>{l}</div>
            </div>
          ))}
          {trades.filter(t=>t.status==="CLOSED").length>0&&<div style={{background:totalPnl>=0?"rgba(0,230,118,0.08)":"rgba(255,23,68,0.08)",border:`1px solid ${totalPnl>=0?"rgba(0,230,118,0.2)":"rgba(255,23,68,0.2)"}`,borderRadius:"6px",padding:"3px 8px",textAlign:"center"}}><div style={{color:totalPnl>=0?"#00e676":"#ff5252",fontWeight:"800",fontSize:"11px",fontFamily:"monospace"}}>{totalPnl>=0?"+":""}₹{f2(Math.abs(totalPnl))}</div><div style={{color:"#5a6370",fontSize:"8px"}}>P&L</div></div>}
          <button onClick={()=>setShowPos(true)} style={{background:"#1a2030",border:"1px solid #2a3040",borderRadius:"6px",color:"#e8eaf0",padding:"5px 9px",cursor:"pointer",fontSize:"12px"}}>📋</button>
          <button onClick={()=>setMonitoring(m=>!m)} style={{background:monitoring?"rgba(0,230,118,0.08)":"rgba(255,82,82,0.08)",border:`1px solid ${monitoring?"rgba(0,230,118,0.25)":"rgba(255,82,82,0.25)"}`,borderRadius:"6px",color:monitoring?"#00e676":"#ff5252",padding:"5px 9px",cursor:"pointer",fontSize:"10px",fontWeight:"700"}}>{monitoring?"⏸":"▶"}</button>
          <button onClick={onLogout} style={{background:"none",border:"1px solid #1e2530",borderRadius:"6px",color:"#5a6370",padding:"5px 9px",cursor:"pointer",fontSize:"10px"}}>Logout</button>
        </div>
      </div>

      {!mktOpen&&session.live&&<div style={{background:"rgba(255,215,64,0.06)",borderBottom:"1px solid rgba(255,215,64,0.2)",padding:"8px 14px",color:"#ffd740",fontSize:"11px"}}>⏰ Market closed. Live data resumes Mon–Fri 9:15 AM IST. Your journal data is safely saved.</div>}

      {/* TABS */}
      <div style={{background:"#0a0d14",borderBottom:"1px solid #1a2030",padding:"0 14px",display:"flex",alignItems:"center"}}>
        {[["market","📊 Market"],["journal",`📓 Journal${trades.length>0?` (${trades.length})`:""}`],["guide","📖 Guide"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:"none",border:"none",borderBottom:`2px solid ${tab===id?"#ff6b35":"transparent"}`,color:tab===id?"#ff6b35":"#5a6370",padding:"9px 12px",cursor:"pointer",fontSize:"11px",fontWeight:"600",transition:"all 0.15s"}}>
            {label}
          </button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"4px"}}>
          {refreshing&&<div style={{width:"8px",height:"8px",border:"1.5px solid #1a2030",borderTopColor:"#ff6b35",borderRadius:"50%",animation:"spin 0.6s linear infinite"}}/>}
          <span style={{color:"#3d4450",fontSize:"9px"}}>{monitoring?`${countdown}s`:"paused"}</span>
        </div>
      </div>

      {/* MARKET TAB */}
      {tab==="market"&&(
        <div style={{padding:"12px 14px"}}>
          <div style={{display:"flex",gap:"6px",marginBottom:"11px",flexWrap:"wrap"}}>
            {[["ALL",stocks.length],["BUY",buys],["SELL",sells],["HOLD",holds]].map(([f,n])=>(
              <button key={f} onClick={()=>setFilter(f)} style={{background:filter===f?"#1e2530":"transparent",border:`1px solid ${filter===f?"#388bfd":"#1e2530"}`,color:filter===f?"#58a6ff":"#5a6370",borderRadius:"20px",padding:"4px 12px",cursor:"pointer",fontSize:"10px",fontWeight:"600",transition:"all 0.15s"}}>
                {f} ({n})
              </button>
            ))}
            <div style={{marginLeft:"auto",color:"#3d4450",fontSize:"9px",alignSelf:"center"}}>Auto-scan {REFRESH_SECS}s</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(255px,1fr))",gap:"10px"}}>
            {filtered.map((s,i)=>{
              const up=s.changePct>=0,pc=up?"#00e676":"#ff1744",sig=s.signal,ot=openTrades.find(t=>t.symbol===s.symbol);
              const livePnl=ot?(ot.action==="BUY"?(s.ltp-ot.entryPrice)*ot.qty:(ot.entryPrice-s.ltp)*ot.qty):0;
              return(
                <div key={s.symbol} style={{background:"#0a0d14",border:`1px solid ${sig.action!=="HOLD"?sig.border:"#1a2030"}`,borderRadius:"14px",padding:"12px",position:"relative",overflow:"hidden",animation:`fadeUp 0.35s ease ${i*.03}s both`,transition:"border-color 0.2s"}}>
                  {sig.action!=="HOLD"&&<div style={{position:"absolute",top:0,left:0,right:0,height:"2px",background:`linear-gradient(90deg,transparent,${sig.color},transparent)`}}/>}
                  {s.live&&!ot&&<div style={{position:"absolute",top:"8px",right:"8px",background:"rgba(0,230,118,0.1)",border:"1px solid rgba(0,230,118,0.2)",borderRadius:"5px",padding:"1px 5px",color:"#00e676",fontSize:"7px",fontWeight:"700"}}>⚡LIVE</div>}
                  {ot&&<div style={{position:"absolute",top:"8px",right:"8px",background:"rgba(255,107,53,0.15)",border:"1px solid rgba(255,107,53,0.3)",borderRadius:"5px",padding:"1px 6px",color:"#ff6b35",fontSize:"7px",fontWeight:"700"}}>ACTIVE</div>}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"7px"}}>
                    <div><div style={{color:"#e8eaf0",fontWeight:"700",fontSize:"13px"}}>{s.symbol}</div><div style={{color:"#5a6370",fontSize:"9px"}}>{s.name}</div></div>
                    <div style={{background:sig.dim,border:`1px solid ${sig.border}`,color:sig.color,padding:"2px 7px",borderRadius:"10px",fontSize:"9px",fontWeight:"700"}}>{sig.emoji} {sig.label}</div>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:"7px"}}>
                    <div><div style={{color:"#e8eaf0",fontWeight:"700",fontSize:"18px",fontFamily:"monospace"}}>₹{f2(s.ltp)}</div><div style={{color:pc,fontSize:"11px",fontWeight:"600"}}>{up?"▲":"▼"}{Math.abs(s.changePct).toFixed(2)}%</div></div>
                    <Spark pts={s.history} color={pc}/>
                  </div>
                  {sig.action!=="HOLD"&&<div style={{background:sig.dim,border:`1px solid ${sig.border}`,borderRadius:"6px",padding:"5px 8px",marginBottom:"7px"}}><div style={{color:sig.color,fontSize:"9px",fontWeight:"600"}}>{sig.conf} · RSI {Number(s.rsi).toFixed(0)} · MACD {Number(s.macd).toFixed(1)} · VWAP {s.ltp>=s.vwap?"Above":"Below"}</div><div style={{color:"#5a6370",fontSize:"9px",marginTop:"1px"}}>{sig.tip}</div></div>}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"4px",marginBottom:"8px"}}>
                    {[["RSI",Number(s.rsi).toFixed(0),s.rsi<35?"#00e676":s.rsi>65?"#ff1744":"#ffd740"],["MACD",s.macd>=0?`+${Number(s.macd).toFixed(1)}`:Number(s.macd).toFixed(1),s.macd>=0?"#00e676":"#ff1744"],["VWAP",s.ltp>=s.vwap?"↑":"↓",s.ltp>=s.vwap?"#00e676":"#ff1744"],["Vol",fv(s.volume),"#8b949e"]].map(([k,v,c])=>(
                      <div key={k} style={{background:"#060810",borderRadius:"5px",padding:"4px",textAlign:"center",border:"1px solid #1a2030"}}><div style={{color:"#5a6370",fontSize:"8px"}}>{k}</div><div style={{color:c,fontWeight:"600",fontSize:"10px"}}>{v}</div></div>
                    ))}
                  </div>
                  {!ot&&sig.action!=="HOLD"&&<div style={{display:"flex",gap:"5px"}}><button onClick={()=>setOrderModal({stock:s,action:"BUY"})} style={{flex:1,background:"rgba(0,230,118,0.1)",border:"1px solid rgba(0,230,118,0.25)",borderRadius:"7px",color:"#00e676",padding:"7px",fontSize:"10px",fontWeight:"700",cursor:"pointer"}}>📈 BUY</button><button onClick={()=>setOrderModal({stock:s,action:"SELL"})} style={{flex:1,background:"rgba(255,23,68,0.1)",border:"1px solid rgba(255,23,68,0.25)",borderRadius:"7px",color:"#ff5252",padding:"7px",fontSize:"10px",fontWeight:"700",cursor:"pointer"}}>📉 SELL</button></div>}
                  {!ot&&sig.action==="HOLD"&&<div style={{textAlign:"center",color:"#3d4450",fontSize:"9px",padding:"6px"}}>⚪ Wait for clearer signal</div>}
                  {ot&&<button onClick={()=>setCloseModal({trade:ot,ltp:s.ltp})} style={{width:"100%",background:livePnl>=0?"rgba(0,230,118,0.1)":"rgba(255,82,82,0.1)",border:`1px solid ${livePnl>=0?"rgba(0,230,118,0.3)":"rgba(255,82,82,0.25)"}`,borderRadius:"7px",color:livePnl>=0?"#00e676":"#ff5252",padding:"7px",fontSize:"10px",fontWeight:"700",cursor:"pointer"}}>📤 Close · P&L: {livePnl>=0?"+":""}₹{f2(Math.abs(livePnl))}</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab==="journal"&&<JournalTab trades={trades} stocks={stocks} onClose={t=>setCloseModal({trade:t,ltp:stocks.find(s=>s.symbol===t.symbol)?.ltp||t.entryPrice})} onDelete={deleteTrade}/>}

      {tab==="guide"&&(
        <div style={{padding:"14px"}}>
          {[
            {t:"📊 Market Tab",c:"#ff6b35",items:["Live NSE prices refresh every 15 seconds automatically","Each card shows Signal, RSI, MACD, VWAP, Volume","Green top glow = BUY signal · Red = SELL signal","Tap BUY or SELL → order placed on NSE + saved to Journal","Filter stocks by signal type using the buttons"]},
            {t:"📓 Journal Tab",c:"#58a6ff",items:["Every order auto-logged the moment it's placed","Open trades: live P&L updates every 15 seconds","Close trade → enter exit price → P&L calculated","Stats: Win Rate, Avg Win/Loss, Expectancy","Data saved in browser — survives refresh and close ✓"]},
            {t:"🟢 Signal Guide",c:"#00e676",items:["STRONG BUY = RSI<35 + MACD+ + Above VWAP (all 3 agree)","BUY = 2 of 3 indicators bullish — good entry","HOLD = mixed signals — do nothing, wait","SELL = 2 of 3 indicators bearish — consider exit","STRONG SELL = RSI>65 + MACD- + Below VWAP (all 3 agree)"]},
            {t:"⚡ Live Trading Rules",c:"#ff1744",items:["First month: only trade STRONG BUY / STRONG SELL signals","Start with 1–5 shares per trade — never large amounts","Always honour your Stop Loss — exit when SL is hit","Never hold intraday positions past 3:15 PM IST","If win rate drops below 50% — stop and review strategy","Missing a trade is fine. Protecting capital is more important."]},
          ].map(sec=>(
            <div key={sec.t} style={{background:"#0a0d14",border:`1px solid ${sec.c}22`,borderRadius:"13px",padding:"13px 15px",marginBottom:"9px"}}>
              <div style={{color:sec.c,fontWeight:"800",fontSize:"13px",marginBottom:"9px"}}>{sec.t}</div>
              {sec.items.map((item,i)=>(
                <div key={i} style={{display:"flex",gap:"7px",alignItems:"flex-start",marginBottom:"5px"}}>
                  <span style={{color:sec.c,fontSize:"10px",marginTop:"1px",flexShrink:0}}>→</span>
                  <span style={{color:"#8b949e",fontSize:"11px",lineHeight:"1.5"}}>{item}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{textAlign:"center",padding:"10px",color:"#3d4450",fontSize:"9px",borderTop:"1px solid #1a2030"}}>⚠️ Not financial advice · Always use stop losses · Trade responsibly</div>

      {banner&&<Banner msg={banner.msg} color={banner.color} onDone={()=>setBanner(null)}/>}
      <AlertToast alerts={alerts} onDismiss={dismissAlert} onAct={alertToTrade}/>
      {showPos&&<PositionsPanel session={session} onClose={()=>setShowPos(false)}/>}
      {orderModal&&<OrderModal stock={orderModal.stock} initAction={orderModal.action} session={session} onClose={()=>setOrderModal(null)} onTradeLogged={onTradeLogged}/>}
      {closeModal&&<CloseModal trade={closeModal.trade} ltp={closeModal.ltp} onClose={()=>setCloseModal(null)} onSave={closeTrade}/>}
    </div>
  );
}

export default function App() {
  const [session,setSession]=useState(null);
  if(!session) return (
    <>
      <LoginScreen onConnect={setSession}/>
      <Analytics />
    </>
  );
  return (
    <>
      <Dashboard session={session} onLogout={()=>setSession(null)}/>
      <Analytics />
    </>
  );
}
