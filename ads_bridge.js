// ads_bridge.js
// Chạy trong content-script của trang advertising.amazon.com
// Nhận payload từ background, build headers từ Options, gọi fetch retrieveReport
// và trả kết quả về lại background qua sendResponse.

(() => {
  const ADS_BASE = "https://advertising.amazon.com";
  const RETRIEVE_URL = `${ADS_BASE}/a9g-api-gateway/cm/dds/retrieveReport`;

  // Đảm bảo đang ở đúng domain
  if (!location.host.endsWith("advertising.amazon.com")) {
    console.warn("[APO][ADS] Wrong host for ads_bridge.js:", location.href);
  }

  // Helper: lấy config đã lưu ở Options
  async function getCfg() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [
          "adsAccountId",
          "adsAdvertiserId",
          "adsClientId",
          "adsMarketplaceId",
          "adsCsrfData",
          "adsCsrfToken",
        ],
        (st) => resolve(st || {})
      );
    });
  }

  // Build header đúng tên như request hợp lệ trong DevTools
  async function buildAdsHeaders() {
    const {
      adsAccountId,
      adsAdvertiserId,
      adsClientId,
      adsMarketplaceId,
      adsCsrfData,
      adsCsrfToken,
    } = await getCfg();

    const h = {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json;charset=UTF-8",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5",
      referer: `${ADS_BASE}/cm/campaigns`,
      Advertisertype: "SELLER",
    };

    if (adsAccountId) h["Amazon-Ads-Account-Id"] = adsAccountId;
    if (adsAdvertiserId)
      h["Amazon-Advertising-Api-Advertiserid"] = adsAdvertiserId;
    if (adsClientId) h["Amazon-Advertising-Api-Clientid"] = adsClientId;
    if (adsMarketplaceId)
      h["Amazon-Advertising-Api-Marketplaceid"] = adsMarketplaceId;

    // CSRF bắt buộc — thiếu 1 trong 2 sẽ bị 401
    if (adsCsrfData) h["Amazon-Advertising-Api-Csrf-Data"] = adsCsrfData;
    if (adsCsrfToken) h["Amazon-Advertising-Api-Csrf-Token"] = adsCsrfToken;

    return h;
  }

  // Gọi fetch trong content-script (cùng origin → tự dùng cookie/phiên)
  async function callRetrieveReport(payload) {
    const headers = await buildAdsHeaders();

    // Log để bạn xem được trên DevTools (tab Ads) mục Console & Network
    console.log("[APO][ADS] retrieveReport → headers", headers);
    console.log("[APO][ADS] retrieveReport → payload", payload);

    const res = await fetch(RETRIEVE_URL, {
      method: "POST",
      credentials: "include",
      mode: "cors",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    // Hiện ra Network như bạn mong muốn; log thêm kết quả
    console.log("[APO][ADS] retrieveReport ←", res.status, text.slice(0, 300));

    // Trả về cho background (background sẽ parse JSON nếu ok)
    return { status: res.status, ok: res.ok, text };
  }

  // Bridge message từ background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type !== "ADS_FETCH_REPORT") return;
      try {
        const r = await callRetrieveReport(msg.payload);
        sendResponse(r);
      } catch (e) {
        console.error("[APO][ADS] retrieveReport error:", e);
        sendResponse({
          ok: false,
          status: 0,
          text: String(e && e.message ? e.message : e),
        });
      }
    })();
    return true; // keep sendResponse async
  });

  console.log("[APO][ADS] ads_bridge.js ready on", location.href);
})();
