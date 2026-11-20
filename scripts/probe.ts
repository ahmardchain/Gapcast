/**
 * Gapcast probe (Step 1).
 *
 * Calls each candidate CoinMarketCap endpoint, saves the raw response bodies to
 * data/probe/ (never headers, never the key), and prints:
 *   - a table: endpoint, status, works, useful fields
 *   - (a) which quotes/historical intervals work and how far back hourly goes
 *   - (b) the tokenized stock/ETF universe (has_tokens, most traded)
 *   - (c) usable off-hours periods per stock in the hourly window
 *   - (d) per-wrapper history via /v3 quotes/historical and /v5 ohlcv/historical
 *   - (e) a STOP flag if most of the universe has < 15 usable periods
 *
 * Key: read from CMC_API_KEY. If unset, no key header is sent (a proxy-injected
 * network secret, if configured, supplies it). The key is never written to disk.
 *
 * Run: npm run probe
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";

const BASE = "https://pro-api.coinmarketcap.com";
const KEY = process.env.CMC_API_KEY?.trim() || "";
const OUT = join(process.cwd(), "data", "probe");
const NY = "America/New_York";
const UNIVERSE_MAX = 50;
const MAX_POINTS = 10_000;

mkdirSync(OUT, { recursive: true });

type Row = { name: string; endpoint: string; status: number; works: boolean; credits: number | null; note: string; fields: string };
const table: Row[] = [];
let callSeq = 0;

function redact(text: string): string {
  return KEY ? text.split(KEY).join("[REDACTED]") : text;
}

async function call(name: string, path: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (KEY) headers["X-CMC_PRO_API_KEY"] = KEY;
  const t0 = Date.now();
  let status = 0;
  let body: any = null;
  let raw = "";
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    raw = await res.text();
    try { body = JSON.parse(raw); } catch { body = { _non_json: raw.slice(0, 2000) }; }
  } catch (e: any) {
    body = { _fetch_error: String(e?.message ?? e) };
  }
  const ms = Date.now() - t0;
  callSeq += 1;
  const file = `${String(callSeq).padStart(2, "0")}_${name.replace(/[^a-z0-9]+/gi, "_")}.json`;
  const saved = {
    request: { method: "GET", path, params, url: `${BASE}${path}${qs ? `?${qs}` : ""}` },
    fetched_at: new Date().toISOString(),
    elapsed_ms: ms,
    http_status: status,
    body,
  };
  writeFileSync(join(OUT, file), redact(JSON.stringify(saved, null, 2)));
  const errCode = body?.status?.error_code;
  const ok = status === 200 && (errCode === 0 || errCode === "0" || errCode === undefined);
  return { status, body, ok, file, errCode, errMsg: body?.status?.error_message ?? body?._fetch_error ?? "", credits: body?.status?.credit_count ?? null };
}

function fieldsOf(obj: any, depth = 0): string[] {
  if (!obj || typeof obj !== "object" || depth > 2) return [];
  const o = Array.isArray(obj) ? obj[0] : obj;
  if (!o || typeof o !== "object") return [];
  return Object.keys(o).flatMap((k) => {
    const v = o[k];
    if (v && typeof v === "object" && depth < 2) {
      const inner = fieldsOf(v, depth + 1);
      return inner.length ? inner.map((i) => `${k}.${i}`) : [k];
    }
    return [k];
  });
}

function record(name: string, endpoint: string, r: Awaited<ReturnType<typeof call>>, note = "", fields?: string) {
  table.push({
    name, endpoint, status: r.status, works: r.ok, credits: r.credits,
    note: r.ok ? note : `${r.errCode ?? ""} ${String(r.errMsg ?? "").slice(0, 90)}`.trim(),
    fields: fields ?? (r.ok ? fieldsOf(r.body?.data).slice(0, 12).join(", ") : ""),
  });
}

// ---------- minimal NYSE calendar for the probe window (full version lives in lib/calendar.ts later) ----------
const HOLIDAYS_2026 = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
const EARLY_CLOSE_2026 = new Set(["2026-11-27", "2026-12-24"]);
function isSession(d: DateTime) { return d.weekday <= 5 && !HOLIDAYS_2026.has(d.toISODate()!); }
function closeHour(d: DateTime) { return EARLY_CLOSE_2026.has(d.toISODate()!) ? 13 : 16; }

type Period = { type: "overnight" | "weekend" | "holiday"; closeDay: string; openDay: string; close?: number; lastOff?: number; first?: number; usable: boolean; missing: string[]; volOff?: number };

function offHoursPeriods(points: { timestamp: string; average_tokenized_price: number; tokenized_volume_24h?: number }[], fromUtc: DateTime, toUtc: DateTime): Period[] {
  const byHour = new Map<string, { p: number; v?: number }>();
  for (const q of points) {
    const t = DateTime.fromISO(q.timestamp, { zone: "utc" }).setZone(NY);
    byHour.set(t.toFormat("yyyy-MM-dd'T'HH"), { p: q.average_tokenized_price, v: q.tokenized_volume_24h });
  }
  const sessions: DateTime[] = [];
  for (let d = fromUtc.setZone(NY).startOf("day"); d <= toUtc.setZone(NY); d = d.plus({ days: 1 })) if (isSession(d)) sessions.push(d);
  const out: Period[] = [];
  for (let i = 0; i + 1 < sessions.length; i++) {
    const d0 = sessions[i], d1 = sessions[i + 1];
    const gapDays = Math.round(d1.diff(d0, "days").days);
    const type: Period["type"] = gapDays === 1 ? "overnight" : d0.weekday === 5 && d1.weekday === 1 && gapDays === 3 ? "weekend" : "holiday";
    const kClose = d0.set({ hour: closeHour(d0) }).toFormat("yyyy-MM-dd'T'HH");
    const kLast = d1.set({ hour: 9 }).toFormat("yyyy-MM-dd'T'HH");
    const kFirst = d1.set({ hour: 10 }).toFormat("yyyy-MM-dd'T'HH");
    // only periods whose outcome hour is already in the past
    if (d1.set({ hour: 11 }) > toUtc.setZone(NY)) continue;
    const c = byHour.get(kClose), l = byHour.get(kLast), f = byHour.get(kFirst);
    const missing = [!c && "close", !l && "last_off_hours", !f && "first_hour"].filter(Boolean) as string[];
    out.push({ type, closeDay: d0.toISODate()!, openDay: d1.toISODate()!, close: c?.p, lastOff: l?.p, first: f?.p, usable: missing.length === 0, missing, volOff: l?.v });
  }
  return out;
}

function chunk<T>(a: T[], n: number): T[][] { const r: T[][] = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; }
const iso = (d: DateTime) => d.toUTC().toISO({ suppressMilliseconds: true })!;

async function main() {
  const now = DateTime.utc();
  console.log(`Gapcast probe @ ${iso(now)}  key source: ${KEY ? "CMC_API_KEY env" : "none in env (relying on proxy-injected secret)"}\n`);

  // 0. key/plan
  const key0 = await call("key_info_before", "/v1/key/info");
  record("key/info", "/v1/key/info", key0, `plan: ${key0.body?.data?.plan?.plan_name ?? "?"}; used today ${key0.body?.data?.usage?.current_day?.credits_used ?? "?"}`);
  if (key0.status === 401 || key0.status === 0) {
    console.error(`STOP: /v1/key/info -> HTTP ${key0.status} ${key0.errCode ?? ""} ${key0.errMsg}. No usable key/network; not spending further calls.`);
    printTable();
    process.exit(2);
  }
  const plan = key0.body?.data?.plan ?? {};
  console.log("Plan:", JSON.stringify(plan));
  const planName = String(plan.plan_name ?? "").toLowerCase();
  if (planName.includes("basic") || planName.includes("free")) {
    console.error(`STOP: key is on "${plan.plan_name}", not the hackathon Startup plan.`);
  }

  // 1. map (0 credits) — stocks + ETFs
  const mapStock = await call("rwa_map_stock", "/v5/real-world-assets/map", { asset_type: "stock", limit: 250 });
  record("rwa map (stock)", "/v5/real-world-assets/map", mapStock, `${mapStock.body?.data?.rwa_assets?.length ?? mapStock.body?.data?.length ?? "?"} stocks`);
  const mapEtf = await call("rwa_map_etf", "/v5/real-world-assets/map", { asset_type: "etf", limit: 250 });
  record("rwa map (etf)", "/v5/real-world-assets/map", mapEtf, `${mapEtf.body?.data?.rwa_assets?.length ?? mapEtf.body?.data?.length ?? "?"} etfs`);

  // 2. assets/list sorted by tokenized volume
  const listStock = await call("rwa_assets_list_stock", "/v5/real-world-assets/assets/list", { asset_type: "stock", sort: "tokenized_volume_24h", limit: 250 });
  record("rwa assets/list (stock)", "/v5/real-world-assets/assets/list", listStock);
  const listEtf = await call("rwa_assets_list_etf", "/v5/real-world-assets/assets/list", { asset_type: "etf", sort: "tokenized_volume_24h", limit: 250 });
  record("rwa assets/list (etf)", "/v5/real-world-assets/assets/list", listEtf);

  const arr = (b: any) => (Array.isArray(b?.data) ? b.data : b?.data?.rwa_assets ?? b?.data?.assets ?? []);
  const all = [...arr(listStock.body), ...arr(listEtf.body)];
  const vol = (a: any) => Number(a.tokenized_volume_24h ?? a.quote?.[0]?.tokenized_volume_24h ?? a.quote?.USD?.tokenized_volume_24h ?? 0);
  const withTokens = all.filter((a) => a.has_tokens !== false);
  const universe = withTokens.filter((a) => vol(a) > 0).sort((a, b) => vol(b) - vol(a)).slice(0, UNIVERSE_MAX);
  console.log(`\n(b) assets/list: ${all.length} stocks+ETFs, ${withTokens.length} has_tokens, ${universe.length} in universe (top ${UNIVERSE_MAX} by 24h tokenized volume, vol > 0)`);
  if (!universe.length) { printTable(); console.error("STOP: empty universe — inspect data/probe/*assets_list*.json"); process.exit(3); }
  const ids = universe.map((a) => a.rwa_id ?? a.id);
  const top = universe[0];
  const topId = top.rwa_id ?? top.id;

  // 3. info, quotes/latest, market pairs, issuers
  const info = await call("rwa_info", "/v5/real-world-assets/info", { rwa_id: ids.join(",") });
  record("rwa info", "/v5/real-world-assets/info", info);
  const latest = await call("rwa_quotes_latest", "/v5/real-world-assets/quotes/latest", { rwa_id: ids.join(",") });
  record("rwa quotes/latest", "/v5/real-world-assets/quotes/latest", latest);
  const pairs = await call("rwa_market_pairs", "/v5/real-world-assets/market-pairs/list", { rwa_id: topId, limit: 100 });
  record("rwa market-pairs/list", "/v5/real-world-assets/market-pairs/list", pairs, `${top.symbol}`);
  const issuers = await call("rwa_issuers_list", "/v5/real-world-assets/issuers/list", { limit: 250 });
  record("rwa issuers/list", "/v5/real-world-assets/issuers/list", issuers, `${issuers.body?.data?.issuers?.length ?? "?"} issuers`);
  const firstIssuer = (issuers.body?.data?.issuers ?? []).sort((a: any, b: any) => (b.num_tokens ?? 0) - (a.num_tokens ?? 0))[0];
  if (firstIssuer) {
    const iss = await call("rwa_issuer", "/v5/real-world-assets/issuers", { issuer_id: firstIssuer.issuer_id });
    record("rwa issuers (one)", "/v5/real-world-assets/issuers", iss, firstIssuer.name);
  }

  // 4. (a) quotes/historical: intervals + hourly depth + volume per point + 10k limit
  console.log(`\n(a) quotes/historical on ${top.symbol} (rwa_id ${topId})`);
  const intervals: [string, Record<string, string | number>][] = [
    ["hourly", { interval: "hourly", count: 5 }],
    ["1h", { interval: "1h", count: 5 }],
    ["4h", { interval: "4h", count: 5 }],
    ["daily", { interval: "daily", count: 5 }],
    ["15m", { interval: "15m", count: 5 }],
    ["5m", { interval: "5m", count: 5 }],
  ];
  const intervalResult: Record<string, string> = {};
  for (const [label, p] of intervals) {
    const r = await call(`rwa_hist_interval_${label}`, "/v5/real-world-assets/quotes/historical", { rwa_id: topId, ...p });
    const pts = r.body?.data?.rwa_assets?.[0]?.quotes ?? [];
    intervalResult[label] = r.ok ? `works (${pts.length} pts)` : `HTTP ${r.status} / ${r.errCode} ${r.errMsg}`;
    record(`rwa quotes/historical ${label}`, "/v5/real-world-assets/quotes/historical", r, `${pts.length} pts`);
  }
  console.table(intervalResult);

  const depthDays = [7, 29, 31, 35, 45, 60, 100];
  const depth: Record<string, string> = {};
  let hourlyReachDays = 0;
  for (const d of depthDays) {
    const start = now.minus({ days: d });
    const r = await call(`rwa_hist_depth_${d}d`, "/v5/real-world-assets/quotes/historical", { rwa_id: topId, interval: "hourly", time_start: iso(start), count: 2 });
    const pts = r.body?.data?.rwa_assets?.[0]?.quotes ?? [];
    depth[`${d}d back`] = r.ok ? `ok, first point ${pts[0]?.timestamp ?? "none"}` : `HTTP ${r.status} / ${r.errCode}`;
    if (r.ok && pts.length) hourlyReachDays = d;
    record(`rwa hist hourly depth ${d}d`, "/v5/real-world-assets/quotes/historical", r, pts[0]?.timestamp ?? "");
  }
  console.table(depth);

  // full hourly window for the universe, chunked under 10k points
  const windowDays = Math.max(hourlyReachDays, 7);
  const histStart = now.minus({ days: windowDays }).plus({ hours: 2 }); // small margin inside plan window
  const hoursInWindow = Math.ceil(now.diff(histStart, "hours").hours) + 1;
  const perReq = Math.max(1, Math.floor(MAX_POINTS / hoursInWindow));
  console.log(`Fetching hourly ${iso(histStart)} -> now (${hoursInWindow} periods) for ${ids.length} assets, ${perReq} assets/request`);

  // deliberate over-limit request to confirm the 10,000-point rule
  const overIds = ids.slice(0, Math.min(ids.length, perReq + 2));
  if (overIds.length * hoursInWindow > MAX_POINTS) {
    const over = await call("rwa_hist_over_10k", "/v5/real-world-assets/quotes/historical", { rwa_id: overIds.join(","), interval: "hourly", time_start: iso(histStart), time_end: iso(now) });
    record("rwa hist >10k points", "/v5/real-world-assets/quotes/historical", over, over.ok ? "UNEXPECTED: accepted" : "");
  }

  const series = new Map<string, any[]>();
  let volPresent = 0, ptsTotal = 0;
  for (const [i, group] of chunk(ids, perReq).entries()) {
    const r = await call(`rwa_hist_hourly_universe_${i}`, "/v5/real-world-assets/quotes/historical", { rwa_id: group.join(","), interval: "hourly", time_start: iso(histStart), time_end: iso(now), skip_invalid: "true" });
    record(`rwa hist hourly universe #${i}`, "/v5/real-world-assets/quotes/historical", r, `${group.length} assets`);
    for (const a of r.body?.data?.rwa_assets ?? []) {
      const q = (a.quotes ?? []).filter((x: any) => (x.convert_symbol ?? "USD") === "USD");
      series.set(a.symbol, q);
      ptsTotal += q.length;
      volPresent += q.filter((x: any) => typeof x.tokenized_volume_24h === "number").length;
    }
  }
  console.log(`(a) hourly points fetched: ${ptsTotal}; tokenized_volume_24h present on ${volPresent} (${ptsTotal ? ((100 * volPresent) / ptsTotal).toFixed(1) : 0}%)`);

  // 5. (c) off-hours periods per stock
  const perStock: Record<string, any> = {};
  let under15 = 0;
  const allUsable: Period[] = [];
  for (const a of universe) {
    const pts = series.get(a.symbol) ?? [];
    const periods = offHoursPeriods(pts, histStart, now);
    const usable = periods.filter((p) => p.usable);
    allUsable.push(...usable);
    const moved = usable.filter((p) => p.lastOff !== p.close).length;
    if (usable.length < 15) under15++;
    perStock[a.symbol] = {
      type: a.asset_type ?? "",
      vol24h: Math.round(vol(a)),
      hourly_pts: pts.length,
      overnight: usable.filter((p) => p.type === "overnight").length,
      weekend: usable.filter((p) => p.type === "weekend").length,
      holiday: usable.filter((p) => p.type === "holiday").length,
      usable: usable.length,
      missing: periods.length - usable.length,
      price_moved_offhours: moved,
    };
  }
  console.log(`\n(c) usable off-hours periods per asset (window ${iso(histStart)} -> now):`);
  console.table(perStock);

  // quick, non-final preview of the core question across all usable periods
  const sgn = (x: number) => (Math.abs(x) < 0.001 ? 0 : Math.sign(x));
  let hits = 0, dirN = 0, errTok = 0, errNaive = 0;
  for (const p of allUsable) {
    const pred = p.lastOff! / p.close! - 1, act = p.first! / p.close! - 1;
    if (sgn(pred) !== 0 && sgn(act) !== 0) { dirN++; if (sgn(pred) === sgn(act)) hits++; }
    errTok += Math.abs(p.lastOff! - p.first!) / p.close!;
    errNaive += Math.abs(p.first! - p.close!) / p.close!;
  }
  const preview = {
    usable_periods: allUsable.length,
    direction_hit_rate: dirN ? `${((100 * hits) / dirN).toFixed(1)}% of ${dirN} non-flat` : "n/a",
    mean_gap_error_pct: allUsable.length ? ((100 * errTok) / allUsable.length).toFixed(3) : "n/a",
    mean_naive_error_pct: allUsable.length ? ((100 * errNaive) / allUsable.length).toFixed(3) : "n/a",
    pooled_skill: errNaive ? (1 - errTok / errNaive).toFixed(3) : "n/a",
  };
  console.log("\nPreview (pooled, unfiltered — NOT the final method; no ex-div/split exclusions yet):");
  console.table(preview);

  // 6. (d) per-wrapper history
  const latestAssets = Array.isArray(latest.body?.data) ? latest.body.data : latest.body?.data?.rwa_assets ?? Object.values(latest.body?.data ?? {});
  const topLatest: any = latestAssets.find((x: any) => (x.rwa_id ?? x.id) === topId) ?? latestAssets[0];
  const tokens: any[] = topLatest?.tokens ?? topLatest?.underlying_tokens ?? [];
  const wrapper = [...tokens].sort((a, b) => Number(b.tokenized_volume_24h ?? 0) - Number(a.tokenized_volume_24h ?? 0))[0];
  const perWrapper: Record<string, string> = {};
  if (wrapper?.crypto_id) {
    const cid = wrapper.crypto_id;
    console.log(`\n(d) per-wrapper: ${top.symbol} wrapper ${wrapper.symbol} (crypto_id ${cid}); ${tokens.length} wrappers listed`);
    const cinfo = await call("crypto_info_wrapper", "/v2/cryptocurrency/info", { id: tokens.map((t) => t.crypto_id).filter(Boolean).join(",") });
    record("crypto info (wrappers)", "/v2/cryptocurrency/info", cinfo, `${tokens.length} wrappers`);
    for (const d of [7, 30, 60, 90]) {
      const r = await call(`v3_quotes_hist_${d}d`, "/v3/cryptocurrency/quotes/historical", { id: cid, interval: "hourly", time_start: iso(now.minus({ days: d })), count: 3 });
      const q = r.body?.data?.[cid]?.quotes ?? r.body?.data?.quotes ?? (Array.isArray(r.body?.data) ? r.body.data[0]?.quotes : undefined) ?? [];
      perWrapper[`v3 quotes/historical hourly ${d}d`] = r.ok ? `ok, first ${q[0]?.timestamp ?? "?"}` : `HTTP ${r.status} / ${r.errCode} ${r.errMsg}`;
      record(`v3 quotes/historical ${d}d`, "/v3/cryptocurrency/quotes/historical", r, q[0]?.timestamp ?? "");
    }
    for (const d of [7, 30, 60, 90]) {
      const r = await call(`v5_ohlcv_1h_${d}d`, "/v5/cryptocurrency/ohlcv/historical", { id: cid, interval: "1h", time_start: iso(now.minus({ days: d })), count: 3 });
      perWrapper[`v5 ohlcv/historical 1h ${d}d`] = r.ok ? `ok: ${JSON.stringify(r.body?.data).slice(0, 120)}` : `HTTP ${r.status} / ${r.errCode} ${r.errMsg}`;
      record(`v5 ohlcv/historical 1h ${d}d`, "/v5/cryptocurrency/ohlcv/historical", r);
    }

    // 7. DEX confidence endpoints, using the wrapper's contract
    const cdata = cinfo.body?.data?.[cid];
    const plat = cdata?.platform ?? (cdata?.contract_address ?? [])[0]?.platform;
    const contract = cdata?.platform?.token_address ?? (cdata?.contract_address ?? [])[0]?.contract_address;
    const network = String(plat?.slug ?? plat?.name ?? plat?.coin?.slug ?? "").toLowerCase();
    if (contract && network) {
      console.log(`DEX checks on ${network}:${contract}`);
      const pools = await call("dex_token_pools", "/v1/dex/token/pools", { network_slug: network, contract_address: contract });
      record("dex token/pools", "/v1/dex/token/pools", pools);
      const poolArr = Array.isArray(pools.body?.data) ? pools.body.data : pools.body?.data?.pools ?? [];
      const poolAddr = poolArr[0]?.pool_address ?? poolArr[0]?.contract_address ?? poolArr[0]?.address;
      if (poolAddr) {
        const pq = await call("dex_pairs_quotes_latest", "/v4/dex/pairs/quotes/latest", { network_slug: network, contract_address: poolAddr });
        record("dex pairs/quotes/latest", "/v4/dex/pairs/quotes/latest", pq);
      } else table.push({ name: "dex pairs/quotes/latest", endpoint: "/v4/dex/pairs/quotes/latest", status: 0, works: false, credits: null, note: "skipped: no pool address from token/pools", fields: "" });
      const tx = await call("dex_tokens_transactions", "/v1/dex/tokens/transactions", { network_slug: network, contract_address: contract });
      record("dex tokens/transactions", "/v1/dex/tokens/transactions", tx);
      const liq = await call("dex_liquidity_change", "/v1/dex/liquidity-change/list", { network_slug: network });
      record("dex liquidity-change/list", "/v1/dex/liquidity-change/list", liq);
      const sec = await call("dex_security_detail", "/v1/dex/security/detail", { network_slug: network, contract_address: contract });
      record("dex security/detail", "/v1/dex/security/detail", sec);
    } else {
      console.log(`DEX checks skipped: no contract/platform in /v2/cryptocurrency/info for ${cid}`);
    }
  } else {
    console.log("\n(d) per-wrapper: no crypto_id found in quotes/latest tokens — inspect rwa_quotes_latest.json");
  }
  if (Object.keys(perWrapper).length) console.table(perWrapper);

  const key1 = await call("key_info_after", "/v1/key/info");
  record("key/info (after)", "/v1/key/info", key1, `used today ${key1.body?.data?.usage?.current_day?.credits_used ?? "?"}`);

  printTable();

  const share = universe.length ? under15 / universe.length : 1;
  console.log(`\n(e) assets with < 15 usable off-hours periods: ${under15}/${universe.length} (${(100 * share).toFixed(0)}%)`);
  if (share > 0.5) console.log("(e) STOP: fewer than 15 usable periods for most of the universe.");
  writeFileSync(join(OUT, "_summary.json"), redact(JSON.stringify({ ran_at: iso(now), plan, intervalResult, depth, hourlyReachDays, perStock, preview, perWrapper, table, under15, universe: universe.map((a) => ({ rwa_id: a.rwa_id ?? a.id, symbol: a.symbol, name: a.name, asset_type: a.asset_type, vol24h: vol(a) })) }, null, 2)));
}

function printTable() {
  console.log("\nEndpoint table:");
  console.table(table.map((r) => ({ endpoint: r.endpoint, call: r.name, status: r.status, works: r.works ? "yes" : "no", credits: r.credits, note: r.note.slice(0, 60), fields: r.fields.slice(0, 80) })));
}

main().catch((e) => { console.error(e); printTable(); process.exit(1); });
