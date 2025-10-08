import { io as WSIO } from "./lib/socket.io.esm.min.js";

/* ===============================
   background.js (MV3) — APO LNG
   - Import NEW: {shopId, file(.txt), type:"New"}
   - Report ALL: {shopId, file(.txt)}
   - Ads: gọi retrieveReport qua content-script (cookie/header chuẩn của tab Ads)
   - Xuất TXT: "Campaigns\tDate\tSpend"
   - Bổ sung:
     * Auto scheduler (5h mặc định) + điều khiển từ backend (SYNC_CONFIG/RUN_NOW qua Socket.IO)
     * Message API: AUTO_SET, AUTO_RUN_NOW
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

/* ---------- Storage ---------- */
async function getCfg(keys = []) {
  const all = await chrome.storage.local.get([
    "ingestUrl",
    "ingestToken",
    "shopId",
    "refNewOrders",
    "refAllOrders",
    // Ads (nếu bridge cần)
    "adsAccountId",
    "adsAdvertiserId",
    "adsClientId",
    "adsMarketplaceId",
    "adsCsrfData",
    "adsCsrfToken",
    // WS / Auto
    "wsBase",
    "autoEnabled",
    "autoIntervalMin",
    ...keys,
  ]);
  return all;
}
function deriveApiUrls(ingestUrl) {
  const base =
    ingestUrl?.replace(/\/ext\/ingest(?:\/.*)?$/i, "") || ingestUrl || "";
  return {
    importNewUrl: `${base}/api/order/update-from-xlsx`,
    reportAllUrl: `${base}/api/report/import-file`,
    adsSpendUrl: `${base}/api/ads/import-day`,
  };
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

  // append các key primitive (trừ file/filename)
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "file" || k === "filename") continue;
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }

  // file
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

/* ===============================
   FEATURES — Import NEW / Report ALL
   =============================== */
async function runImportNewOrders(referenceOverride) {
  const { ingestUrl, shopId, ingestToken, refNewOrders } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importNewUrl } = deriveApiUrls(ingestUrl);

  // 1) ref
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

  // 2) poll
  const st = await pollUntilReady(referenceId, {
    intervalMs: 10000,
    maxAttempts: 5,
  });

  // 3) tsv
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

  // 4) push
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
   ADS qua content-script (cookie/header y như tab Ads)
   =============================== */
async function ensureAdsTab() {
  // 1) tìm tab Ads
  let tabs = await chrome.tabs.query({ url: `${ADS_BASE}/*` });
  let tab;
  if (tabs.length) {
    tab = tabs[0];
  } else {
    // 2) mở tab Campaign Manager nếu chưa có
    tab = await chrome.tabs.create({
      url: `${ADS_BASE}/cm/campaigns`,
      active: false,
    });
  }

  // 3) chờ tab hoàn tất (để content-script được inject)
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

// Gửi message tới ads_bridge.js; nếu chưa có thì inject rồi retry
async function adsRetrieveViaContentScript(payload) {
  const tabId = await ensureAdsTab();

  const sendOnce = () =>
    chrome.tabs.sendMessage(tabId, {
      type: "ADS_FETCH_REPORT",
      url: ADS_RETRIEVE_URL,
      payload,
    });

  // thử gửi một lần
  try {
    const r = await sendOnce();
    if (r) return r;
  } catch (_) {}

  // inject bridge nếu chưa có
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ads_bridge.js"],
    });
    await new Promise((r) => setTimeout(r, 300));
  } catch (_) {}

  // retry tối đa 2 lần
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

// Wrapper: gửi qua content-script và PARSE JSON an toàn
async function fetchAdsJsonCS(payload) {
  const r = await adsRetrieveViaContentScript(payload); // {status, ok, text}
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

// Payload cho CrossProgramCampaignReport
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
      // KHÔNG đưa 'date' (API không hỗ trợ)
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

/** Lấy mọi bản ghi theo pagination; mặc định size=300 */
async function fetchAllCampaignSpend(startDate, endDate, pageSize = 300) {
  // ---- LẦN 1: dùng fetchAdsJsonCS (đÃ parse JSON) ----
  const firstJson = await fetchAdsJsonCS(
    buildCampaignSpendPayload({
      startDate,
      endDate,
      size: Math.max(1, Math.min(pageSize, 300)),
      offset: 0,
    })
  );

  // JSON thực tế: { report: { numberOfRecords, data: [...] } }
  // (giữ fallback cho { data: { report: {...} } } nếu có môi trường khác)
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

  // Chuẩn hoá còn 3 cột (date = startDate vì API ko trả cột ngày)
  return all.map((r) => ({
    campaignName: r.campaignName ?? "",
    date: startDate,
    spend: Number(r.spend ?? 0),
  }));
}

// Xuất TXT: Campaigns\tDate\tSpend
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

/* ====== SOCKET.IO (Kết nối tới server realtime) ====== */
let WS_sock = null;

// === ADD: emit STATUS về server ===
function wsStatus(phase, status, extra = {}) {
  try {
    WS_sock?.emit?.("STATUS", {
      jobId: extra.jobId || "ad-hoc",
      phase, // 'import' | 'report' | 'ads' | 'config'
      status, // 'start' | 'success' | 'fail'
      httpStatus: extra.httpStatus,
      ms: extra.ms,
      error: extra.error,
    });
  } catch {}
}

async function wsGetBase() {
  // Ưu tiên wsBase; nếu không có thì lấy ingestUrl; fallback localhost
  const s = await chrome.storage.local.get(["wsBase", "ingestUrl"]);
  let base = (s.wsBase || s.ingestUrl || "").trim();
  base = base.replace(/\/ext\/ingest(?:\/.*)?$/i, "").replace(/\/+$/, "");
  if (!base) base = "https://api.lngmerch.co";
  return base;
}

async function wsEnsureIdentity() {
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

/* --------- AUTO SCHEDULER (5h mặc định; có thể đổi) ---------- */
const AUTO_ALARM = "apo-auto-5h";
const DEF_INTERVAL_MIN = 300; // 5 giờ
let autoBusy = false;

// === ADD: helper chạy 1 phase có log ===
async function runStep(jobId, phase, fn) {
  wsStatus(phase, "start", { jobId });
  const t0 = performance.now();
  try {
    await fn();
    wsStatus(phase, "success", {
      jobId,
      ms: Math.round(performance.now() - t0),
    });
    return true;
  } catch (e) {
    wsStatus(phase, "fail", {
      jobId,
      ms: Math.round(performance.now() - t0),
      error: String(e?.message || e),
    });
    return false;
  }
}

// Thay thế hoàn toàn hàm runAutoJob:
async function runAutoJob(reason = "alarm", jobId) {
  if (autoBusy) {
    console.log("[AUTO] skip, job is running");
    wsStatus("config", "fail", { jobId, error: "busy" }); // log nhẹ nếu trùng
    return { ok: false, message: "busy" };
  }
  autoBusy = true;
  const tStart = Date.now();
  console.log("[AUTO] start", { reason, jobId });

  try {
    // Luôn chạy lần lượt: import -> report -> ads
    const importOk = await runStep(jobId, "import", () =>
      runImportNewOrders(undefined)
    );
    const reportOk = await runStep(jobId, "report", () =>
      runReportAllOrders(undefined)
    );

    const today = new Date().toISOString().slice(0, 10);
    const adsOk = await runStep(jobId, "ads", () => runExportAdsSpend(today));

    // Hoàn tất job: ok = đã chạy xong cả ba bước (không đồng nghĩa tất cả success)
    return {
      ok: true,
      ms: Date.now() - tStart,
      results: { import: importOk, report: reportOk, ads: adsOk },
    };
  } finally {
    autoBusy = false;
  }
}

async function scheduleAutoRun(enable = true, minutes = DEF_INTERVAL_MIN) {
  await chrome.alarms.clear(AUTO_ALARM);
  await chrome.alarms.clear(AUTO_ALARM + "-kick");
  minutes = Math.max(1, minutes | 0);

  await chrome.storage.local.set({
    autoEnabled: enable,
    autoIntervalMin: minutes,
  });

  if (!enable) {
    console.log("[AUTO] disabled");
    return { ok: true, enabled: false };
  }

  chrome.alarms.create(AUTO_ALARM, { periodInMinutes: minutes });
  // Kick 1 phát sau 10s để chạy ngay khi bật (có thể bỏ nếu không muốn)
  chrome.alarms.create(AUTO_ALARM + "-kick", { when: Date.now() + 10 * 1000 });

  console.log("[AUTO] scheduled every", minutes, "minutes");
  return { ok: true, enabled: true, minutes };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_ALARM || alarm.name === AUTO_ALARM + "-kick") {
    await runAutoJob("alarm:" + alarm.name);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(["autoEnabled", "autoIntervalMin"]);
  await scheduleAutoRun(
    st.autoEnabled ?? true,
    st.autoIntervalMin ?? DEF_INTERVAL_MIN
  );
});
chrome.runtime.onStartup.addListener(async () => {
  const st = await chrome.storage.local.get(["autoEnabled", "autoIntervalMin"]);
  if (st.autoEnabled ?? true) {
    await scheduleAutoRun(true, st.autoIntervalMin ?? DEF_INTERVAL_MIN);
  }
});

/* --------- Backend-controlled config via WS ---------- */
function applySyncConfig(cfg) {
  let minutes = DEF_INTERVAL_MIN;
  if (typeof cfg?.intervalMin === "number")
    minutes = Math.max(1, cfg.intervalMin | 0);
  if (typeof cfg?.intervalMs === "number")
    minutes = Math.max(1, Math.round(cfg.intervalMs / 60000));

  scheduleAutoRun(cfg?.enabled !== false, minutes)
    .then((r) => {
      console.log("[WS] SYNC_CONFIG applied →", r);
      try {
        WS_sock?.emit?.("STATUS", {
          jobId: "cfg-" + Date.now(),
          phase: "config",
          status: "success",
          ms: 0,
        });
      } catch {}
    })
    .catch((e) => {
      console.warn("[WS] SYNC_CONFIG error", e);
      try {
        WS_sock?.emit?.("STATUS", {
          jobId: "cfg-" + Date.now(),
          phase: "config",
          status: "fail",
          error: String(e),
        });
      } catch {}
    });
}

async function wsConnect() {
  if (WS_sock?.connected) return { ok: true, already: true };

  const base = await wsGetBase();
  const { clientId, clientLabel } = await wsEnsureIdentity();
  const ver = chrome.runtime.getManifest().version;

  WS_sock = WSIO(base, {
    path: "/socket",
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelayMax: 30000,
  });

  WS_sock.on("connect", () => {
    console.log("[WS] connected →", base);
    WS_sock.emit("HELLO", {
      clientId,
      label: clientLabel,
      version: "ext-" + ver,
    });
    chrome.runtime
      .sendMessage({ type: "WS_EVENT", event: "CONNECT", base })
      .catch(() => {});
  });

  WS_sock.on("connect_error", (err) => {
    console.warn("[WS] connect_error", err?.message || err);
    chrome.runtime
      .sendMessage({
        type: "WS_EVENT",
        event: "CONNECT_ERROR",
        error: String(err?.message || err),
      })
      .catch(() => {});
  });

  WS_sock.on("disconnect", (reason) => {
    console.warn("[WS] disconnect", reason);
    chrome.runtime
      .sendMessage({ type: "WS_EVENT", event: "DISCONNECT", reason })
      .catch(() => {});
  });

  // === Realtime commands ===
  WS_sock.on("RUN_JOB", ({ jobId, reason }) => {
    // tương thích lệnh cũ (ack + log). RUN_NOW mới là lệnh chạy thật.
    console.log("[WS] RUN_JOB", jobId, reason);
    try {
      WS_sock.emit("ACK", { jobId });
    } catch {}
    chrome.runtime
      .sendMessage({
        type: "WS_EVENT",
        event: "RUN_JOB",
        payload: { jobId, reason },
      })
      .catch(() => {});
  });

  WS_sock.on("SYNC_CONFIG", (payload) => {
    console.log("[WS] SYNC_CONFIG", payload);
    applySyncConfig(payload);
  });

  WS_sock.on("RUN_NOW", async (payload) => {
    console.log("[WS] RUN_NOW", payload);
    try {
      WS_sock.emit("ACK", { jobId: payload?.jobId || "run-" + Date.now() });
    } catch {}
    await runAutoJob("remote", payload?.jobId); // ← TRUYỀN jobId
  });

  return { ok: true, base };
}

function wsDisconnect() {
  try {
    WS_sock?.disconnect();
    WS_sock = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

/* ===============================
   Bridge cho Options / DevTools
   =============================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PING") return sendResponse({ ok: true });

      // chạy tay 3 bước
      if (msg.type === "RUN_IMPORT_NEW")
        return sendResponse(await runImportNewOrders(msg.payload?.referenceId));
      if (msg.type === "RUN_REPORT_ALL")
        return sendResponse(await runReportAllOrders(msg.payload?.referenceId));
      if (msg.type === "RUN_ADS_SPEND")
        return sendResponse(await runExportAdsSpend(msg.payload?.date));

      // WebSocket connect/disconnect
      if (msg.type === "WS_CONNECT") return sendResponse(await wsConnect());
      if (msg.type === "WS_DISCONNECT") return sendResponse(wsDisconnect());

      // Scheduler control từ Options/devtools
      if (msg.type === "AUTO_SET")
        return sendResponse(
          await scheduleAutoRun(!!msg.enabled, msg.minutes ?? DEF_INTERVAL_MIN)
        );
      if (msg.type === "AUTO_RUN_NOW")
        return sendResponse(await runAutoJob("manual"));

      sendResponse({ ok: false, message: "Unknown command" });
    } catch (e) {
      sendResponse({ ok: false, message: String(e?.message || e) });
    }
  })();
  return true;
});
