/* ===============================
   background.js (MV3) — APO LNG (No Socket.IO)
   - Import NEW / Report ALL / Ads (gọi Amazon như cũ)
   - Lịch cố định: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 (giờ LOCAL)
   - Gửi LOG TỔNG khi AUTO/CLICK: POST /api/logs/ext/log
   - Đăng ký client thủ công: POST /api/shop/ext/connect (qua BACKEND_CONNECT)
   - Bật/tắt auto: AUTO_ENABLE / AUTO_DISABLE / AUTO_SET
   - MỚI: Auto-capture Amazon Ads CSRF/Headers qua webRequest để token luôn mới
   =============================== */

const log = (...args) => console.log("[APO]", ...args);

const SC_BASE = "https://sellercentral.amazon.com";
const ADS_BASE = "https://advertising.amazon.com";
const ADS_RETRIEVE_URL =
  "https://advertising.amazon.com/a9g-api-gateway/cm/dds/retrieveReport";

/* ---------- Cookies & CSRF (Seller Central) ---------- */
async function getCookie(url, name) {
  try {
    const ck = await chrome.cookies.get({ url, name });
    return ck?.value || "";
  } catch {
    return "";
  }
}
async function amazonHeaders() {
  const a2z = await getCookie(`${SC_BASE}/`, "anti-csrftoken-a2z");
  const xcsrf = await getCookie(`${SC_BASE}/`, "x-amz-csrf");
  const h = {
    accept: "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
    referer: `${SC_BASE}/order-reports-and-feeds/reports`,
  };
  if (a2z) h["anti-csrftoken-a2z"] = a2z;
  if (xcsrf) h["x-amz-csrf-token"] = xcsrf;
  return h;
}

/* ---------- Fetch helpers ---------- */
function isJson(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json");
}
function isTsvish(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return (
    ct.includes("text/plain") ||
    ct.includes("text/tab-separated-values") ||
    ct.includes("octet-stream") ||
    ct.includes("text/xls")
  );
}
async function requestOnce(url, init = {}) {
  const headers = { ...(await amazonHeaders()), ...(init.headers || {}) };
  return fetch(url, {
    credentials: "include",
    redirect: "manual",
    ...init,
    headers,
  });
}

/* ---------- Storage / URLs ---------- */
async function getCfg(keys = []) {
  const all = await chrome.storage.local.get([
    "ingestUrl",
    "ingestToken",
    "shopId",
    "refNewOrders",
    "refAllOrders",
    // Ads headers (tự động cập nhật)
    "adsAccountId",
    "adsAdvertiserId",
    "adsClientId",
    "adsMarketplaceId",
    "adsCsrfData",
    "adsCsrfToken",
    "adsHeaderLastSeen",
    // Auto
    "autoEnabled",
    ...keys,
  ]);
  return all;
}
function deriveApiUrls(ingestUrl) {
  const base =
    ingestUrl?.replace(/\/ext\/ingest(?:\/.*)?$/i, "") || ingestUrl || "";
  return {
    base,
    importNewUrl: `${base}/api/order/update-from-xlsx`,
    reportAllUrl: `${base}/api/report/import-file`,
    adsSpendUrl: `${base}/api/ads/import-day`,
    logCollectUrl: `${base}/api/logs/ext/log`,
    clientRegisterUrl: `${base}/api/shop/ext/connect`,
  };
}

/* ---------- Identity ---------- */
async function ensureIdentity() {
  let { clientId, clientLabel } = await chrome.storage.local.get([
    "clientId",
    "clientLabel",
  ]);
  if (!clientId) {
    clientId =
      "cid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await chrome.storage.local.set({ clientId });
  }
  if (!clientLabel) {
    clientLabel = "Machine-" + clientId.slice(-4);
    await chrome.storage.local.set({ clientLabel });
  }
  return { clientId, clientLabel };
}

/* ---------- Tiny TSV helper ---------- */
function parseTSV(tsv) {
  const clean = tsv.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows: [] };
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((l) => {
    const c = l.split("\t");
    const o = {};
    headers.forEach(
      (h, i) => (o[h.trim().toLowerCase()] = (c[i] ?? "").trim())
    );
    return o;
  });
  return { rows };
}

/* ===============================
   ORDERS: xin ref + kiểm tra + tải
   =============================== */
function buildNewOrdersPayload() {
  return {
    type: "newOrdersReport",
    reportVersion: "new",
    includeSalesChannel: false,
    numDays: "1",
    numMonth: "0",
    numYear: "2015",
  };
}
function buildAllOrdersPayload(startDur = "P1D", endDur = "P0D") {
  return {
    type: "allOrdersReport",
    reportVersion: "orderDateVersion",
    includeSalesChannel: null,
    startDate: startDur,
    endDate: endDur,
  };
}
async function requestReferenceIdNew(body) {
  const url = `${SC_BASE}/order-reports-and-feeds/api/reportRequest`;
  const res = await requestOnce(url, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `reportRequest NEW ${res.status} — ${(
        await res.text().catch(() => "")
      ).slice(0, 200)}`
    );
  if (!isJson(res)) throw new Error(`reportRequest NEW non-JSON`);
  const j = await res.json();
  return j?.referenceId || j?.data?.referenceId;
}
async function requestReferenceIdAll(body) {
  const url = `${SC_BASE}/order-reports-and-feeds/api/v1/reportRequest`;
  const res = await requestOnce(url, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `reportRequest ALL ${res.status} — ${(
        await res.text().catch(() => "")
      ).slice(0, 200)}`
    );
  if (!isJson(res)) throw new Error(`reportRequest ALL non-JSON`);
  const j = await res.json();
  return j?.referenceId || j?.data?.referenceId;
}
async function checkReportReady(referenceId) {
  const url = `${SC_BASE}/order-reports-and-feeds/api/documentMetadata?referenceId=${encodeURIComponent(
    referenceId
  )}`;
  const res = await requestOnce(url, { method: "GET" });

  if (res.status >= 300 && res.status < 400)
    return { ready: false, reason: "PENDING_REDIRECT" };

  if (isTsvish(res)) {
    const tsv = await res.text();
    const { rows } = parseTSV(tsv);
    if (rows.length > 0) return { ready: true, direct: true, tsv };
    return { ready: false, reason: "EMPTY_TSV" };
  }

  if (!isJson(res)) return { ready: false, reason: "PENDING_NON_JSON" };

  const j = await res.json().catch(() => ({}));
  const documentId = j?.data?.documentId;
  if (!documentId) return { ready: false, reason: "NO_DOCUMENT_ID_YET" };
  return { ready: true, documentId };
}
async function downloadByDocumentId(documentId) {
  const dlUrl = `${SC_BASE}/order-reports-and-feeds/feeds/download?documentId=${encodeURIComponent(
    documentId
  )}&fileType=txt`;
  const r = await requestOnce(dlUrl, { method: "GET" });
  if (!r.ok) throw new Error(`Amazon download ${r.status}`);
  const tsv = await r.text();
  const { rows } = parseTSV(tsv);
  return { tsv, rows: rows.length, documentId };
}

/* ===============================
   Poll helper (10s x 5) + chống trùng ref
   =============================== */
const activeRefs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntilReady(
  referenceId,
  { intervalMs = 10000, maxAttempts = 5 } = {}
) {
  if (activeRefs.has(referenceId)) return activeRefs.get(referenceId);
  const job = (async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const st = await checkReportReady(referenceId);
      if (st.ready) {
        activeRefs.delete(referenceId);
        if (st.direct) return { direct: true, tsv: st.tsv };
        return { documentId: st.documentId };
      }
      if (attempt < maxAttempts) await sleep(intervalMs);
    }
    activeRefs.delete(referenceId);
    throw new Error(
      `Report ${referenceId} chưa sẵn sàng sau ${
        (intervalMs * maxAttempts) / 1000
      }s`
    );
  })();
  activeRefs.set(referenceId, job);
  return job;
}

/* ===============================
   Push file về backend
   =============================== */
async function postFileTo(url, fields) {
  const { ingestToken } = await getCfg();
  const fd = new FormData();

  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "file" || k === "filename") continue;
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }
  if (typeof fields.file === "string") {
    const name = fields.filename || "file.txt";
    fd.append("file", new Blob([fields.file], { type: "text/plain" }), name);
  } else if (fields.file && typeof fields.file.text === "string") {
    const name = fields.file.name || "file.txt";
    fd.append(
      "file",
      new Blob([fields.file.text], { type: "text/plain" }),
      name
    );
  } else {
    throw new Error("postFileTo: file missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "x-access-token": ingestToken || "" },
    body: fd,
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json")
    ? res.json()
    : { ok: true, raw: await res.text() };
}

/* ---------- Gửi LOG TỔNG (AUTO/CLICK) ---------- */
async function postRunLog({ trigger, phases, extraMeta = {} }) {
  try {
    const { ingestUrl, ingestToken, shopId } = await getCfg();
    const { base, logCollectUrl } = deriveApiUrls(ingestUrl);
    if (!base) {
      console.warn("[APO] No ingestUrl → skip log");
      return;
    }
    const { clientId, clientLabel } = await ensureIdentity();

    const payload = {
      trigger, // 'AUTO' | 'CLICK'
      shopId: shopId || null, // để backend populate sang Shop
      clientId,
      label: clientLabel,
      phases, // [{type:'import'|'report'|'ads', status:'success'|'fail'}]
      meta: extraMeta,
    };

    const res = await fetch(logCollectUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-token": ingestToken || "",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("[APO] postRunLog failed", res.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.error("[APO] postRunLog error:", e?.message || e);
  }
}

/* ---------- Đăng ký client (thủ công) ---------- */
async function connectBackend() {
  const { ingestUrl, shopId, autoEnabled } = await getCfg();
  const { base, clientRegisterUrl } = deriveApiUrls(ingestUrl);
  if (!base) throw new Error("Missing ingestUrl (Options)");
  const { clientId, clientLabel } = await ensureIdentity();
  const ver = chrome.runtime.getManifest().version;

  const payload = {
    clientId,
    label: clientLabel,
    shopId: shopId || "",
    version: "ext-" + ver,
    ua: navigator.userAgent,
    autoEnabled: !!(autoEnabled ?? true),
    connectedAt: Date.now(),
  };

  const res = await fetch(clientRegisterUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`Register ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return { ok: true, result: j };
}

/* ===============================
   FEATURES — Import NEW / Report ALL / ADS
   =============================== */
async function runImportNewOrders(referenceOverride) {
  const { ingestUrl, shopId, ingestToken, refNewOrders } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importNewUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    try {
      referenceId = await requestReferenceIdNew(buildNewOrdersPayload());
    } catch (e) {
      log("[APO] NEW reportRequest failed → dùng ref lưu:", e.message);
      referenceId = refNewOrders;
    }
  }
  if (!referenceId) throw new Error("No referenceId found for NEW orders.");

  const st = await pollUntilReady(referenceId, {
    intervalMs: 10000,
    maxAttempts: 5,
  });

  let tsv,
    documentId = null,
    rows = 0;
  if (st.direct) {
    tsv = st.tsv;
    rows = parseTSV(tsv).rows.length;
  } else {
    const r = await downloadByDocumentId(st.documentId);
    tsv = r.tsv;
    documentId = r.documentId;
    rows = r.rows;
  }

  const fd = new FormData();
  if (shopId) fd.append("shopId", shopId);
  fd.append(
    "file",
    new Blob([tsv], { type: "text/plain" }),
    `orders-new-${referenceId}.txt`
  );
  fd.append("type", "New");

  const resp = await fetch(importNewUrl, {
    method: "POST",
    headers: { "x-access-token": ingestToken || "" },
    body: fd,
  });
  if (!resp.ok) throw new Error(`Backend ${resp.status}`);
  const ingest = (resp.headers.get("content-type") || "")
    .toLowerCase()
    .includes("application/json")
    ? await resp.json()
    : { ok: true, raw: await resp.text() };

  return { ok: true, rows, documentId, referenceId, ingest };
}

async function runReportAllOrders(referenceOverride) {
  const { ingestUrl, shopId, refAllOrders } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { reportAllUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    try {
      referenceId = await requestReferenceIdAll(
        buildAllOrdersPayload("P1D", "P0D")
      );
    } catch (e) {
      log("[APO] ALL reportRequest failed → dùng ref lưu:", e.message);
      referenceId = refAllOrders;
    }
  }
  if (!referenceId) throw new Error("No referenceId found for ALL orders");

  const st = await pollUntilReady(referenceId, {
    intervalMs: 10000,
    maxAttempts: 5,
  });

  let tsv,
    documentId = null,
    rows = 0;
  if (st.direct) {
    tsv = st.tsv;
    rows = parseTSV(tsv).rows.length;
  } else {
    const r = await downloadByDocumentId(st.documentId);
    tsv = r.tsv;
    documentId = r.documentId;
    rows = r.rows;
  }

  const ingest = await postFileTo(reportAllUrl, {
    shopId,
    file: { name: `orders-all-${referenceId}.txt`, text: tsv },
  });

  return { ok: true, rows, documentId, referenceId, ingest };
}

/* ===============================
   ADS via content-script
   =============================== */
async function ensureAdsTab() {
  let tabs = await chrome.tabs.query({ url: `${ADS_BASE}/*` });
  let tab;
  if (tabs.length) tab = tabs[0];
  else {
    tab = await chrome.tabs.create({
      url: `${ADS_BASE}/cm/campaigns`,
      active: false,
    });
  }
  if (tab.status !== "complete") {
    await new Promise((resolve) => {
      const onUpdated = (tid, info) => {
        if (tid === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }
  return tab.id;
}

async function adsRetrieveViaContentScript(payload) {
  const tabId = await ensureAdsTab();
  const sendOnce = () =>
    chrome.tabs.sendMessage(tabId, {
      type: "ADS_FETCH_REPORT",
      url: ADS_RETRIEVE_URL,
      payload,
    });

  try {
    const r = await sendOnce();
    if (r) return r;
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ads_bridge.js"],
    });
    await new Promise((r) => setTimeout(r, 300));
  } catch (_) {}

  for (let i = 0; i < 2; i++) {
    try {
      const r = await sendOnce();
      if (r) return r;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error("Could not establish connection to ads_bridge.js");
}

async function fetchAdsJsonCS(payload) {
  const r = await adsRetrieveViaContentScript(payload);
  if (!r) throw new Error("retrieveReport no response");
  if (!r.ok) {
    const sample =
      typeof r.text === "string" ? r.text : JSON.stringify(r.text || "");
    throw new Error(`retrieveReport ${r.status} — ${sample.slice(0, 200)}`);
  }
  let j;
  try {
    j = JSON.parse(r.text || "{}");
  } catch {
    const sample =
      typeof r.text === "string" ? r.text : JSON.stringify(r.text || "");
    throw new Error(`retrieveReport non-JSON: ${sample.slice(0, 200)}`);
  }
  return j;
}

function buildCampaignSpendPayload({
  startDate,
  endDate,
  size,
  offset,
  timeUnit = "DAILY",
}) {
  return {
    reportConfig: {
      reportId: "CrossProgramCampaignReport",
      currencyOfView: "USD",
      endDate,
      fields: ["campaignName", "spend", "state"],
      filter: {
        and: [
          {
            comparisonOperator: "IN",
            field: "state",
            not: false,
            values: ["ENABLED", "PAUSED", "ARCHIVED"],
          },
        ],
      },
      offsetPagination: { size, offset },
      startDate,
      timeUnits: [timeUnit],
    },
  };
}

async function fetchAllCampaignSpend(startDate, endDate, pageSize = 300) {
  const firstJson = await fetchAdsJsonCS(
    buildCampaignSpendPayload({
      startDate,
      endDate,
      size: Math.max(1, Math.min(pageSize, 300)),
      offset: 0,
    })
  );

  const report0 = firstJson?.report || firstJson?.data?.report || {};
  const count = report0?.numberOfRecords ?? 0;
  const rows1 = Array.isArray(report0?.data) ? report0.data : [];
  if (count === 0 || rows1.length === 0) return [];

  const totalPages = Math.ceil(count / pageSize);
  let all = rows1;

  for (let page = 1; page < totalPages; page++) {
    const js = await fetchAdsJsonCS(
      buildCampaignSpendPayload({
        startDate,
        endDate,
        size: pageSize,
        offset: page * pageSize,
      })
    );
    const report = js?.report || js?.data?.report || {};
    const more = Array.isArray(report?.data) ? report.data : [];
    if (!more.length) break;
    all = all.concat(more);
  }

  return all.map((r) => ({
    campaignName: r.campaignName ?? "",
    date: startDate,
    spend: Number(r.spend ?? 0),
  }));
}

function campaignRowsToTxt(rows) {
  const header = "Campaigns\tDate\tSpend";
  const lines = rows.map((r) =>
    [
      String(r.campaignName).replace(/\t/g, " ").replace(/\r?\n/g, " "),
      r.date,
      r.spend,
    ].join("\t")
  );
  return [header, ...lines].join("\n");
}

async function runExportAdsSpend(date) {
  const { ingestUrl, shopId } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { adsSpendUrl } = deriveApiUrls(ingestUrl);
  if (!date) throw new Error("date (YYYY-MM-DD) required");

  const rows = await fetchAllCampaignSpend(date, date, 300);
  const txt = campaignRowsToTxt(rows);

  const ingestRes = await postFileTo(adsSpendUrl, {
    shopId,
    day: date,
    file: { name: `ads-spend-${date}.txt`, text: txt },
  });

  return { ok: true, rows: rows.length, ingest: ingestRes };
}

/* ===============================
   AUTO SCHEDULER — 0h/4h/8h/12h/16h/20h (LOCAL)
   =============================== */
const AUTO_ALARM = "apo-auto-fixed";
let autoBusy = false;

function nextAlignedTs(fromTs = Date.now(), baseHour = 0, everyHours = 4) {
  const d = new Date(fromTs);
  d.setMinutes(0, 0, 0);
  let h = d.getHours();
  const mod = (((h - baseHour) % everyHours) + everyHours) % everyHours;
  if (mod !== 0 || fromTs > d.getTime()) {
    h = h + (everyHours - mod);
    d.setHours(h, 0, 0, 0);
  }
  if (d.getTime() <= fromTs) d.setHours(d.getHours() + everyHours, 0, 0, 0);
  return d.getTime();
}

async function scheduleNextAnchor() {
  await chrome.alarms.clear(AUTO_ALARM);
  const when = nextAlignedTs(Date.now(), 0, 4);
  chrome.alarms.create(AUTO_ALARM, { when });
  log("[AUTO] next tick at", new Date(when).toLocaleString());
}

async function scheduleAutoRun(enable = true) {
  await chrome.alarms.clear(AUTO_ALARM);
  await chrome.storage.local.set({ autoEnabled: enable });

  if (!enable) {
    log("[AUTO] disabled");
    return { ok: true, enabled: false };
  }
  await scheduleNextAnchor();
  return {
    ok: true,
    enabled: true,
    schedule: "00:00 | 04:00 | 08:00 | 12:00 | 16:00 | 20:00",
  };
}

// chạy đủ 3 bước và GỬI LOG TỔNG
async function runFullFlowAndLog(trigger = "AUTO") {
  const phases = [];
  try {
    await runImportNewOrders(undefined);
    phases.push({ type: "import", status: "success" });
  } catch {
    phases.push({ type: "import", status: "fail" });
  }

  try {
    await runReportAllOrders(undefined);
    phases.push({ type: "report", status: "success" });
  } catch {
    phases.push({ type: "report", status: "fail" });
  }

  try {
    // lấy ngày LOCAL (tự động) cho Ads
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const todayLocal = `${yyyy}-${mm}-${dd}`;
    await runExportAdsSpend(todayLocal);
    phases.push({ type: "ads", status: "success" });
  } catch {
    phases.push({ type: "ads", status: "fail" });
  }

  await postRunLog({ trigger, phases });
  return { ok: true, phases };
}

async function runAutoJob() {
  if (autoBusy) {
    console.log("[AUTO] skip, job is running");
    return { ok: false, message: "busy" };
  }
  autoBusy = true;
  try {
    return await runFullFlowAndLog("AUTO");
  } finally {
    autoBusy = false;
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_ALARM) {
    await runAutoJob();
    await scheduleNextAnchor();
  }
});

/* ===============================
   Auto-capture Amazon Ads headers (CSRF) qua webRequest
   Lưu vào chrome.storage.local để luôn có token/ids mới.
   =============================== */
const ADS_HEADER_KEYS = {
  "amazon-ads-account-id": "adsAccountId",
  "amazon-advertising-api-advertiserid": "adsAdvertiserId",
  "amazon-advertising-api-clientid": "adsClientId",
  "amazon-advertising-api-marketplaceid": "adsMarketplaceId",
  "amazon-advertising-api-csrf-data": "adsCsrfData",
  "amazon-advertising-api-csrf-token": "adsCsrfToken",
};

function collectAdsHeaders(requestHeaders = []) {
  const out = {};
  for (const h of requestHeaders) {
    const k = String(h.name || "").toLowerCase();
    const key = ADS_HEADER_KEYS[k];
    if (key) out[key] = h.value || "";
  }
  return out;
}

async function saveAdsHeadersIfAny(found) {
  const keys = Object.keys(found);
  if (!keys.length) return;

  const current = await chrome.storage.local.get(keys);
  let changed = false;
  for (const k of keys) {
    if (found[k] && found[k] !== current[k]) {
      changed = true;
      break;
    }
  }
  if (changed) {
    await chrome.storage.local.set({
      ...found,
      adsHeaderLastSeen: Date.now(),
    });
    log("[ADS] headers updated:", Object.keys(found).join(", "));
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      // chỉ quan tâm domain Ads
      if (!details?.url?.startsWith(ADS_BASE)) return;
      const found = collectAdsHeaders(details.requestHeaders || []);
      saveAdsHeadersIfAny(found);
    } catch {}
  },
  { urls: [`${ADS_BASE}/*`] },
  ["requestHeaders", "extraHeaders"]
);

/* ===============================
   Bridge cho Options / DevTools
   =============================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PING") return sendResponse({ ok: true });

      // Manual single steps (không gửi log tổng)
      if (msg.type === "RUN_IMPORT_NEW")
        return sendResponse(await runImportNewOrders(msg.payload?.referenceId));
      if (msg.type === "RUN_REPORT_ALL")
        return sendResponse(await runReportAllOrders(msg.payload?.referenceId));
      if (msg.type === "RUN_ADS_SPEND")
        return sendResponse(await runExportAdsSpend(msg.payload?.date));

      // Manual full flow (CLICK) + log tổng
      if (msg.type === "AUTO_RUN_NOW")
        return sendResponse(await runFullFlowAndLog("CLICK"));

      // Auto on/off
      if (msg.type === "AUTO_ENABLE")
        return sendResponse(await scheduleAutoRun(true));
      if (msg.type === "AUTO_DISABLE")
        return sendResponse(await scheduleAutoRun(false));
      if (msg.type === "AUTO_SET")
        return sendResponse(await scheduleAutoRun(!!msg.enabled));

      // Đăng ký client (thủ công từ Options)
      if (msg.type === "BACKEND_CONNECT")
        return sendResponse(await connectBackend());

      sendResponse({ ok: false, message: "Unknown command" });
    } catch (e) {
      sendResponse({ ok: false, message: String(e?.message || e) });
    }
  })();
  return true;
});

/* ---------- Lifecycle ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(["autoEnabled"]);
  await ensureIdentity();
  await scheduleAutoRun(st.autoEnabled ?? true);
  // tự đăng ký client 1 lần lúc cài/ cập nhật
  try {
    await connectBackend();
  } catch {}
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await chrome.storage.local.get(["autoEnabled"]);
  await ensureIdentity();
  if (st.autoEnabled ?? true) await scheduleNextAnchor();
  else await chrome.alarms.clear(AUTO_ALARM);
  // tự đăng ký lại khi máy/VPS khởi động
  try {
    await connectBackend();
  } catch {}
});
