// options.js — APO LNG (khớp background chạy theo mốc 0/4/8/12/16/20, không dùng WS)

const $ = (s) => document.querySelector(s);
const log = (...a) => {
  $("#log").textContent = [
    $("#log").textContent,
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
};

// ===== Helpers =====
function normalizeBaseUrl(u) {
  if (!u) return "";
  let s = u.trim();
  s = s.replace(/[?#].*$/, ""); // bỏ query/fragment
  s = s.replace(/\/ext\/ingest(?:\/.*)?$/i, ""); // bỏ đuôi cũ nếu có
  s = s.replace(/\/+$/, ""); // bỏ / thừa cuối
  return s;
}
function deriveApiUrls(base) {
  if (!base) return { importNewUrl: "", reportAllUrl: "", adsSpendUrl: "" };
  return {
    importNewUrl: `${base}/ext/import-new-orders`,
    reportAllUrl: `${base}/ext/report-all-orders`,
    adsSpendUrl: `${base}/ext/ads-spend`,
  };
}
function setTodayDefault() {
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    if (!$("#adsDate").value) $("#adsDate").value = `${y}-${m}-${d}`;
  } catch {}
}
function previewEndpoints() {
  const raw = $("#ingestUrl").value.trim();
  const base = normalizeBaseUrl(raw);
  const { importNewUrl, reportAllUrl, adsSpendUrl } = deriveApiUrls(base);

  const lines = [];
  if (base) {
    lines.push("🔗 Derived endpoints:");
    lines.push(`• ${importNewUrl}`);
    lines.push(`• ${reportAllUrl}`);
    lines.push(`• ${adsSpendUrl}`);
    lines.push(
      "⏱ Auto schedule: 00:00 | 04:00 | 08:00 | 12:00 | 16:00 | 20:00"
    );
  } else {
    lines.push("⚠️ Nhập API Base URL (ví dụ: https://api.lngmerch.co)");
  }
  $("#log").textContent = lines.join("\n");
}

// ===== Load saved config =====
(async () => {
  const st = await chrome.storage.local.get([
    "ingestUrl",
    "ingestToken",
    "shopId",
    "adsAccountId",
    "adsAdvertiserId",
    "adsClientId",
    "adsMarketplaceId",
    // NEW
    "adsCsrfData",
    "adsCsrfToken",
    // auto
    "autoEnabled",
  ]);
  if (st.ingestUrl) $("#ingestUrl").value = st.ingestUrl;
  if (st.ingestToken) $("#ingestToken").value = st.ingestToken;
  if (st.shopId) $("#shopId").value = st.shopId;

  // Ads headers
  if (st.adsAccountId) $("#adsAccountId").value = st.adsAccountId;
  if (st.adsAdvertiserId) $("#adsAdvertiserId").value = st.adsAdvertiserId;
  if (st.adsClientId) $("#adsClientId").value = st.adsClientId;
  if (st.adsMarketplaceId) $("#adsMarketplaceId").value = st.adsMarketplaceId;

  // NEW: CSRF Data/Token
  if (st.adsCsrfData) $("#adsCsrfData").value = st.adsCsrfData;
  if (st.adsCsrfToken) $("#adsCsrfToken").value = st.adsCsrfToken;

  // Auto status
  if ($("#autoStatus")) {
    $("#autoStatus").textContent =
      st.autoEnabled ?? true ? "Auto: ENABLED" : "Auto: DISABLED";
  }

  setTodayDefault();
  previewEndpoints();
})();

// Cập nhật preview khi gõ base URL
$("#ingestUrl").addEventListener("input", previewEndpoints);

// ===== Save config =====
$("#saveBtn").onclick = async () => {
  let ingestUrl = $("#ingestUrl").value.trim();
  const ingestToken = $("#ingestToken").value.trim();
  const shopId = $("#shopId").value.trim();

  // Ads headers
  const adsAccountId = $("#adsAccountId").value.trim();
  const adsAdvertiserId = $("#adsAdvertiserId").value.trim();
  const adsClientId = $("#adsClientId").value.trim();
  const adsMarketplaceId = $("#adsMarketplaceId").value.trim();

  // NEW: CSRF Data/Token
  const adsCsrfData = $("#adsCsrfData").value.trim();
  const adsCsrfToken = $("#adsCsrfToken").value.trim();

  ingestUrl = normalizeBaseUrl(ingestUrl);

  if (!ingestUrl) {
    $("#status").textContent = "❌ Vui lòng nhập API Base URL hợp lệ.";
    return;
  }
  if (!/^https?:\/\//i.test(ingestUrl)) {
    $("#status").textContent =
      "❌ API Base URL phải bắt đầu bằng http:// hoặc https://";
    return;
  }

  await chrome.storage.local.set({
    ingestUrl,
    ingestToken,
    shopId,
    adsAccountId,
    adsAdvertiserId,
    adsClientId,
    adsMarketplaceId,
    // NEW
    adsCsrfData,
    adsCsrfToken,
  });

  $("#status").textContent = "✅ Đã lưu (lần sau không cần nhập lại).";
  setTimeout(() => ($("#status").textContent = ""), 2200);

  previewEndpoints();
};

// ===== Test buttons =====
$("#testImport").onclick = async () => {
  $("#log").textContent = "Running Import (NEW)...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_IMPORT_NEW" });
    log(res);
  } catch (e) {
    log("❌ " + (e.message || e));
  }
};

$("#testReport").onclick = async () => {
  $("#log").textContent = "Running Report (ALL)...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_REPORT_ALL" });
    log(res);
  } catch (e) {
    log("❌ " + (e.message || e));
  }
};

$("#testAds").onclick = async () => {
  $("#log").textContent = "Running Ads Export...";
  const date = $("#adsDate").value.trim();
  if (!date) return log("❌ Vui lòng nhập ngày (YYYY-MM-DD)");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "RUN_ADS_SPEND",
      payload: { date },
    });
    log(res);
  } catch (e) {
    log("❌ " + (e.message || e));
  }
};

// ===== NEW: Connect backend (đăng ký client) =====
const btnConnect = $("#btnConnect");
if (btnConnect) {
  btnConnect.onclick = async () => {
    // đảm bảo base URL vừa nhập được lưu trước khi connect
    const base = normalizeBaseUrl($("#ingestUrl").value.trim());
    if (base) await chrome.storage.local.set({ ingestUrl: base });

    $("#log").textContent = "Connecting to backend...";
    try {
      const r = await chrome.runtime.sendMessage({ type: "BACKEND_CONNECT" });
      if (r?.ok) {
        log("✅ BACKEND_CONNECT → " + JSON.stringify(r));
      } else {
        log("❌ BACKEND_CONNECT failed → " + JSON.stringify(r || {}));
      }
    } catch (e) {
      log("❌ BACKEND_CONNECT error: " + (e.message || e));
    }
  };
}

// ===== NEW: Auto controls (enable/disable/run-now) =====
const btnAutoEnable = $("#btnAutoEnable");
if (btnAutoEnable) {
  btnAutoEnable.onclick = async () => {
    $("#log").textContent = "Enabling auto schedule (fixed anchors)...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "AUTO_ENABLE" });
      log(res);
      $("#autoStatus") && ($("#autoStatus").textContent = "Auto: ENABLED");
    } catch (e) {
      log("❌ " + (e.message || e));
    }
  };
}
const btnAutoDisable = $("#btnAutoDisable");
if (btnAutoDisable) {
  btnAutoDisable.onclick = async () => {
    $("#log").textContent = "Disabling auto schedule...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "AUTO_DISABLE" });
      log(res);
      $("#autoStatus") && ($("#autoStatus").textContent = "Auto: DISABLED");
    } catch (e) {
      log("❌ " + (e.message || e));
    }
  };
}
// Tuỳ chọn: chạy ngay một job đủ 3 bước
const btnAutoRunNow = $("#btnAutoRunNow");
if (btnAutoRunNow) {
  btnAutoRunNow.onclick = async () => {
    $("#log").textContent = "Run job now...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "AUTO_RUN_NOW" });
      log(res);
    } catch (e) {
      log("❌ " + (e.message || e));
    }
  };
}

// ===== Open Service Worker console =====
$("#openSW").onclick = () => {
  alert(
    "Mở log SW: chrome://extensions → bật Developer mode → Service worker (Inspect)."
  );
  chrome.runtime.sendMessage({ type: "PING" }).catch(() => {});
};
