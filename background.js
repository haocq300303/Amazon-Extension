// ===============================
// background.js (MV3) — APO LNG (poll 10s x 5, stop on TSV)
//  - 3 endpoints (importNew/reportAll/adsSpend)
//  - NEW ref:  /api/reportRequest
//  - ALL ref:  /api/v1/reportRequest
//  - Import NEW: gửi {shopId, file(.txt), type:"New"}
//  - Report ALL & Ads: chỉ {shopId, file(.txt)}
//  - Ads (retrieveReport): TXT header "Campaigns\tDate\tSpend"
// ===============================
const log = (...args) => console.log("[APO]", ...args);

const SC_BASE = "https://sellercentral.amazon.com";

// ---------- Cookies & CSRF ----------
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

// ---------- Fetch helpers ----------
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

// ---------- Storage ----------
async function getCfg(keys = []) {
  const all = await chrome.storage.local.get([
    "ingestUrl",
    "ingestToken",
    "shopId",
    "refNewOrders",
    "refAllOrders",
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

// ---------- Tiny TSV helper ----------
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

// ===============================
// ORDERS: xin ref + kiểm tra + tải
// ===============================
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

  // A) có thể trả file thẳng
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

// ===============================
// Poll helper (10s x 5) + chống trùng ref
// ===============================
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

// ===============================
// Push file về backend
// ===============================
async function postFileTo(url, fields) {
  const { ingestToken } = await getCfg();
  const fd = new FormData();

  if (fields.shopId) fd.append("shopId", fields.shopId);

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

  if (fields.type) fd.append("type", fields.type); // chỉ import NEW truyền vào

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

// ===============================
// FEATURES — Import NEW / Report ALL
// ===============================
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
  if (!referenceId) throw new Error("Không có referenceId cho NEW orders");

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

  // 4) Import NEW: {shopId, file(.txt), type:"New"}
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
  if (!referenceId) throw new Error("Không có referenceId cho ALL orders");

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

  // Report ALL: chỉ {shopId, file(.txt)}
  const ingest = await postFileTo(reportAllUrl, {
    shopId,
    file: { name: `orders-all-${referenceId}.txt`, text: tsv },
  });

  return { ok: true, rows, documentId, referenceId, ingest };
}

// ===============================
// ADS via retrieveReport (Campaigns, Date, Spend)
// ===============================
const ADS_RETRIEVE_URL =
  "https://advertising.amazon.com/a9g-api-gateway/cm/dds/retrieveReport";

/** payload chỉ lấy 3 field + filter ENABLED + phân trang */
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
      endDate, // "YYYY-MM-DD"
    },
    fields: ["campaignName", "date", "spend"],
    filter: {
      and: [
        {
          field: "state",
          values: ["ENABLED"],
          comparisonOperator: "IN",
          not: false,
        },
      ],
    },
    offsetPagination: { size, offset },
    reportId: "CrossProgramCampaignReport",
    startDate, // "YYYY-MM-DD"
    timeUnits: [timeUnit], // "DAILY" để có cột date
  };
}

async function fetchAdsJson(payload) {
  const headers = {
    ...(await amazonHeaders()),
    "content-type": "application/json;charset=UTF-8",
  };
  const res = await fetch(ADS_RETRIEVE_URL, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const sample = await res.text().catch(() => "");
    throw new Error(`retrieveReport ${res.status} — ${sample.slice(0, 200)}`);
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    const sample = await res.text().catch(() => "");
    throw new Error(`retrieveReport non-JSON: ${sample.slice(0, 200)}`);
  }
  return res.json();
}

/** Lấy mọi bản ghi theo count trả về; mặc định size=300 */
async function fetchAllCampaignSpend(startDate, endDate, pageSize = 300) {
  const firstPayload = buildCampaignSpendPayload({
    startDate,
    endDate,
    size: Math.max(1, Math.min(pageSize, 300)),
    offset: 0,
  });
  const firstJson = await fetchAdsJson(firstPayload);
  const report = firstJson?.data?.report || {};
  const count = report?.numberOfRecords ?? 0;
  const rows1 = Array.isArray(report?.data) ? report.data : [];
  if (count === 0 || rows1.length === 0) return [];

  const totalPages = Math.ceil(count / pageSize);
  let all = rows1;

  for (let page = 1; page < totalPages; page++) {
    const offset = page * pageSize;
    const payload = buildCampaignSpendPayload({
      startDate,
      endDate,
      size: pageSize,
      offset,
    });
    const js = await fetchAdsJson(payload);
    const more = Array.isArray(js?.data?.report?.data)
      ? js.data.report.data
      : [];
    if (more.length === 0) break;
    all = all.concat(more);
  }

  // chuẩn hoá còn 3 trường
  return all.map((r) => ({
    campaignName: r.campaignName ?? "",
    date: r.date ?? endDate,
    spend: Number(r.spend ?? 0),
  }));
}

/** Xuất TXT header: Campaigns\tDate\tSpend */
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

  // 1) lấy toàn bộ rows (ENABLED, fields 3 cột)
  const rows = await fetchAllCampaignSpend(date, date, 300);

  // 2) TXT "Campaigns\tDate\tSpend"
  const txt = campaignRowsToTxt(rows);

  // 3) gửi backend — chỉ shopId + file (.txt)
  const ingestRes = await postFileTo(adsSpendUrl, {
    shopId,
    file: { name: `ads-spend-${date}.txt`, text: txt },
  });

  return { ok: true, rows: rows.length, ingest: ingestRes };
}

// ===============================
// Bridge cho Options
// ===============================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PING") return sendResponse({ ok: true });
      if (msg.type === "RUN_IMPORT_NEW")
        return sendResponse(await runImportNewOrders(msg.payload?.referenceId));
      if (msg.type === "RUN_REPORT_ALL")
        return sendResponse(await runReportAllOrders(msg.payload?.referenceId));
      if (msg.type === "RUN_ADS_SPEND")
        return sendResponse(await runExportAdsSpend(msg.payload?.date));
      sendResponse({ ok: false, message: "Unknown command" });
    } catch (e) {
      sendResponse({ ok: false, message: String(e.message || e) });
    }
  })();
  return true;
});
