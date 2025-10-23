// options.js — APO LNG (Popup) - keep action keys & old log style

/* ========== Helpers ========== */
const $ = (s) => document.querySelector(s);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

// Log kiểu cũ: append xuống cuối, không dùng mảng/ghi đè
function log(...args) {
  const box = $("#log");
  if (!box) return;
  const line =
    `[${new Date().toLocaleTimeString()}] ` +
    args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  box.textContent += (box.textContent ? "\n" : "") + line;
}

function normalizeBaseUrl(u) {
  if (!u) return "";
  return u
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/ext\/ingest(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

function deriveApiUrls(base) {
  if (!base) return { importNewUrl: "", reportAllUrl: "", adsSpendUrl: "" };
  return {
    importNewUrl: `${base}/api/order/update-from-xlsx`,
    reportAllUrl: `${base}/api/report/import-file`,
    adsSpendUrl: `${base}/api/ads/import-day`,
  };
}

function setTodayDefault() {
  const d = $("#adsDate");
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
}

function previewEndpoints() {
  const raw = $("#ingestUrl")?.value || "";
  const base = normalizeBaseUrl(raw);
  const { importNewUrl, reportAllUrl, adsSpendUrl } = deriveApiUrls(base);

  const lines = base
    ? [
        "🔗 Endpoints:",
        `• ${importNewUrl}`,
        `• ${reportAllUrl}`,
        `• ${adsSpendUrl}`,
        "⏱ Auto anchors: 00:00 | 04:00 | 08:00 | 12:00 | 16:00 | 20:00",
      ]
    : ["⚠️ Nhập API Base URL (ví dụ: https://api.lngmerch.co)"];

  const box = $("#log");
  if (box) box.textContent = lines.join("\n");
}

/* ========== Init ========== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const {
      ingestUrl = "",
      shopId = "",
      autoEnabled = false,
      adsHeaderLastSeen,
    } = await chrome.storage.local.get([
      "ingestUrl",
      "shopId",
      "autoEnabled",
      "adsHeaderLastSeen",
    ]);

    if ($("#ingestUrl")) $("#ingestUrl").value = ingestUrl;
    if ($("#shopId")) $("#shopId").value = shopId;

    // Toggle có thể là #autoToggle hoặc .switch input (theo HTML của bạn)
    const autoToggle =
      $("#autoToggle") || document.querySelector(".switch input");
    if (autoToggle) autoToggle.checked = !!autoEnabled;

    setTodayDefault();
    previewEndpoints();

    if (adsHeaderLastSeen) {
      log(
        `ℹ️ Ads headers last captured: ${new Date(
          adsHeaderLastSeen
        ).toLocaleString()}`
      );
    }

    // Ping để chắc chắn SW đang sống
    chrome.runtime.sendMessage({ type: "PING" }, (res) => {
      if (chrome.runtime.lastError) {
        log("SW unreachable:", chrome.runtime.lastError.message);
      } else {
        log("PING ->", res || {});
      }
    });
  } catch (e) {
    log("Init error:", e?.message || e);
  }
});

/* ========== Live preview Base URL ========== */
on($("#ingestUrl"), "input", previewEndpoints);

/* ========== Save config ========== */
on($("#saveBtn"), "click", async () => {
  try {
    let ingestUrl = normalizeBaseUrl($("#ingestUrl")?.value || "");
    const shopId = ($("#shopId")?.value || "").trim();

    if (!ingestUrl)
      return ($("#status").textContent =
        "❌ Vui lòng nhập API Base URL hợp lệ.");
    if (!/^https?:\/\//i.test(ingestUrl))
      return ($("#status").textContent =
        "❌ URL phải bắt đầu bằng http:// hoặc https://");

    await chrome.storage.local.set({ ingestUrl, shopId });
    $("#status").textContent = "✅ Đã lưu cấu hình.";
    log("Saved config", { ingestUrl, shopId });
    previewEndpoints();

    setTimeout(() => ($("#status").textContent = ""), 1800);
  } catch (e) {
    log("Save error:", e?.message || e);
  }
});

/* ========== Auto enable/disable bằng toggle (nếu có) ========== */
const toggleEl = $("#autoToggle") || document.querySelector(".switch input");
on(toggleEl, "change", async (ev) => {
  const enabled = !!ev.target.checked;
  try {
    await chrome.storage.local.set({ autoEnabled: enabled });
    await chrome.runtime.sendMessage({
      type: enabled ? "AUTO_ENABLE" : "AUTO_DISABLE",
    });
    log(enabled ? "Auto ENABLE requested." : "Auto DISABLE requested.");
  } catch (e) {
    log("Auto toggle error:", e?.message || e);
  }
});

/* ========== Run now (gộp job) ========== */
on($("#btnAutoRunNow"), "click", async () => {
  $("#log").textContent = "Run job now...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "AUTO_RUN_NOW" });
    log(res);
  } catch (e) {
    log("❌ " + (e.message || e));
  }
});

/* ========== Export Ads theo ngày (nút riêng) ========== */
on($("#testAds"), "click", async () => {
  const date = $("#adsDate")?.value?.trim();
  if (!date) return log("❌ Vui lòng nhập ngày (YYYY-MM-DD)");
  try {
    await chrome.runtime.sendMessage({
      type: "RUN_ADS_SPEND",
      payload: { date },
    });
    log("RUN_ADS_SPEND sent:", date);
  } catch (e) {
    log("RUN_ADS_SPEND error:", e?.message || e);
  }
});

/* ========== (Tùy chọn) Connect backend nếu có nút #btnConnect ========== */
on($("#btnConnect"), "click", async () => {
  try {
    const base = normalizeBaseUrl($("#ingestUrl")?.value || "");
    if (base) await chrome.storage.local.set({ ingestUrl: base });
    log("Connecting to backend...");
    const r = await chrome.runtime.sendMessage({ type: "BACKEND_CONNECT" });
    if (r?.ok) log("✅ BACKEND_CONNECT →", r);
    else log("❌ BACKEND_CONNECT failed →", r || {});
  } catch (e) {
    log("❌ BACKEND_CONNECT error:", e?.message || e);
  }
});

/* ========== Nhận cập nhật từ background ========== */
chrome.runtime.onMessage.addListener((msg) => {
  // Đồng bộ trạng thái auto nếu background phát lại
  if (msg?.type === "AUTO_STATUS") {
    const t = $("#autoToggle") || document.querySelector(".switch input");
    if (t) t.checked = !!msg.enabled;
    log("AUTO_STATUS:", msg.enabled);
  }
  if (msg?.type === "LOG") log(msg.payload);
});
