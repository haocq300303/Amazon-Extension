// ads_bridge.js
// Chạy trong content-script của advertising.amazon.com
// - Nghe background để gọi retrieveReport bằng headers từ Storage
// - TỰ ĐỘNG chụp headers Amazon Ads bằng cách inject script patch fetch/XHR trong page context
//   rồi postMessage về content-script -> lưu chrome.storage.local

(() => {
  const ADS_HOST = "advertising.amazon.com";
  const ADS_BASE = `https://${ADS_HOST}`;
  const RETRIEVE_URL = `${ADS_BASE}/a9g-api-gateway/cm/dds/retrieveReport`;
  const MSG_TYPE_SNIFF = "APO_ADS_HEADER_SNIFF";

  if (!location.host.endsWith(ADS_HOST)) {
    console.warn("[APO][ADS] Wrong host for ads_bridge.js:", location.href);
  }

  // ---------- Storage helpers ----------
  function getCfg(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        keys || [
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
  function setCfg(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  // ---------- Build headers cho retrieveReport ----------
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

    // CSRF bắt buộc
    if (adsCsrfData) h["Amazon-Advertising-Api-Csrf-Data"] = adsCsrfData;
    if (adsCsrfToken) h["Amazon-Advertising-Api-Csrf-Token"] = adsCsrfToken;

    // Cảnh báo nhẹ nếu thiếu cặp CSRF
    if (!adsCsrfData || !adsCsrfToken) {
      console.warn(
        "[APO][ADS] Missing CSRF headers in storage → request có thể 401. Hãy tương tác Ads UI để auto-capture."
      );
    }
    return h;
  }

  // ---------- Gọi retrieveReport bằng headers hiện tại ----------
  async function callRetrieveReport(payload) {
    const headers = await buildAdsHeaders();

    console.log("[APO][ADS] retrieveReport → headers(use)", headers);
    console.log("[APO][ADS] retrieveReport → payload", payload);

    const res = await fetch(RETRIEVE_URL, {
      method: "POST",
      credentials: "include",
      mode: "cors",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    console.log("[APO][ADS] retrieveReport ←", res.status, text.slice(0, 300));
    return { status: res.status, ok: res.ok, text };
  }

  // ---------- Inject page script để bắt headers từ request gốc ----------
  function injectSniffer() {
    const code = `
      (function() {
        const TARGET_HOST = ${JSON.stringify(ADS_HOST)};
        const MSG_TYPE = ${JSON.stringify(MSG_TYPE_SNIFF)};

        function pickHeaders(h) {
          // Chuẩn hoá object thường từ Headers (hoặc plain object)
          const out = {};
          if (!h) return out;
          try {
            if (typeof h.forEach === 'function') {
              h.forEach((v, k) => out[String(k)] = String(v));
            } else {
              for (const k in h) out[String(k)] = String(h[k]);
            }
          } catch {}
          return out;
        }

        function extractAdsHeaders(headersObj) {
          const h = {};
          const src = {};
          for (const [k, v] of Object.entries(headersObj || {})) {
            const K = k.toLowerCase();
            src[K] = v;
          }
          // Map các header quan trọng
          const M = {
            "amazon-ads-account-id": "adsAccountId",
            "amazon-advertising-api-advertiserid": "adsAdvertiserId",
            "amazon-advertising-api-clientid": "adsClientId",
            "amazon-advertising-api-marketplaceid": "adsMarketplaceId",
            "amazon-advertising-api-csrf-data": "adsCsrfData",
            "amazon-advertising-api-csrf-token": "adsCsrfToken"
          };
          Object.keys(M).forEach((lk) => {
            if (src[lk]) h[M[lk]] = src[lk];
          });
          return h;
        }

        function shouldCapture(url) {
          try {
            const u = new URL(url, location.href);
            return u.host.endsWith(TARGET_HOST);
          } catch {
            return false;
          }
        }

        function send(headersObj) {
          try {
            const data = extractAdsHeaders(headersObj);
            if (Object.keys(data).length === 0) return;
            window.postMessage({ __apo: true, type: MSG_TYPE, data, ts: Date.now() }, "*");
          } catch (e) {}
        }

        // ---- Patch fetch ----
        const _fetch = window.fetch;
        window.fetch = function(input, init) {
          try {
            const url = (typeof input === 'string') ? input : (input && input.url ? input.url : String(input));
            if (shouldCapture(url)) {
              const hdrs = pickHeaders(init && init.headers);
              // Nếu page tự gắn headers vào fetch -> capture
              send(hdrs);
            }
          } catch {}
          return _fetch.apply(this, arguments);
        };

        // ---- Patch XHR ----
        const _open = XMLHttpRequest.prototype.open;
        const _send = XMLHttpRequest.prototype.send;
        const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function(method, url) {
          try {
            this.__apo_url = url;
            this.__apo_headers = {};
          } catch {}
          return _open.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
          try {
            if (!this.__apo_headers) this.__apo_headers = {};
            this.__apo_headers[k] = v;
          } catch {}
          return _setReqHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
          try {
            if (shouldCapture(this.__apo_url)) {
              send(this.__apo_headers || {});
            }
          } catch {}
          return _send.apply(this, arguments);
        };

        // Đánh dấu đã ready
        console.log("[APO][ADS] page sniffer injected");
      })();
    `;
    const s = document.createElement("script");
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  // ---------- Nhận headers từ page → lưu storage ----------
  let lastWrite = 0;
  window.addEventListener("message", async (evt) => {
    const msg = evt && evt.data;
    if (!msg || !msg.__apo || msg.type !== MSG_TYPE_SNIFF) return;
    const data = msg.data || {};
    try {
      // debounce nhỏ để tránh spam storage
      const now = Date.now();
      if (now - lastWrite < 300) return;
      lastWrite = now;

      const toSave = { ...data, adsHeaderLastSeen: now };
      await setCfg(toSave);
      console.log("[APO][ADS] captured headers -> storage", toSave);
    } catch (e) {
      console.warn("[APO][ADS] save headers error:", e);
    }
  });

  injectSniffer();

  // ---------- Bridge từ background ----------
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
    return true; // async
  });

  console.log("[APO][ADS] ads_bridge.js ready on", location.href);
})();
