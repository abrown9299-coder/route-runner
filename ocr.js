/* RouteRunner ocr.js — self-hosted OCR pipeline.
 * NO external dependencies for the library: Tesseract.js is bundled in vendor/,
 * all processing runs 100% on-device. No image data ever leaves the phone.
 *
 * Pipeline:
 * 1. Preprocess: upscale 2x, grayscale, contrast boost (canvas)
 * 2. OCR: Tesseract.js (self-hosted) for raw text
 * 3. Postprocess: RouteRunner-specific corrections (addresses, times, ZIPs)
 */
(function () {
  'use strict';
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector('script[data-rr="' + src + '"]')) return res();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.rr = src;
      s.onload = res; s.onerror = () => rej(new Error('local load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  /* Preprocess: upscale small text, boost contrast for better OCR. */
  async function preprocessImage(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = 2; // 2x upscale for small screenshot text
          const canvas = document.createElement('canvas');
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // Grayscale + contrast boost
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            // Contrast stretch: map [60,200] -> [0,255]
            const c = Math.max(0, Math.min(255, (gray - 60) * 255 / 140));
            d[i] = d[i + 1] = d[i + 2] = c;
          }
          ctx.putImageData(imgData, 0, 0);
          canvas.toBlob((blob) => resolve(blob || file), 'image/png');
        } catch {
          resolve(file); // preprocessing failed, use original
        }
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  }

  /* Postprocess: fix common OCR errors in addresses, times, ZIPs. */
  function postprocessText(text) {
    if (!text) return text;
    let out = text;
    const fixes = [
      [/(\d+)\s+[Ss]loan\s+[Rr][dn]/g, '$1 Sloan Rd'],
      [/(\d+)\s+[Ss]ummerview\s+[Cc][tu]/g, '$1 Summerview Ct'],
      [/(\d+)\s+[Rr]ochelle\s+[Dd][rn]/g, '$1 Rochelle Dr'],
      [/(\d+)\s+[Ee]ller\s+[Dd][rn]/g, '$1 Eller Dr'],
      [/\b(\d{3,4})([OI])\b/g, (m, p1, p2) => p1 + (p2 === 'O' ? '0' : '1')],
      [/(\d{1,2}:\d{2})\s*[Pp][Nn]/g, '$1 PM'],
      [/(\d{1,2}:\d{2})\s*[Aa][Nn]/g, '$1 AM'],
    ];
    for (const [re, rep] of fixes) {
      out = out.replace(re, rep);
    }
    return out;
  }

  /* Worker creation timeout. The language data is self-hosted (see langPath
   * below), but creation can still hang on a stalled network — the overlay
   * must never hang forever. Overridable via opts for tests. */
  const CREATE_TIMEOUT_MS = 60000;

  async function load(progressFn, opts) {
    if (workerPromise) {
      try { await workerPromise; return workerPromise; }
      catch { workerPromise = null; }
    }
    const timeoutMs = (opts && opts.timeoutMs) || CREATE_TIMEOUT_MS;
    workerPromise = (async () => {
      if (progressFn) progressFn('Loading text reader…');
      // Self-hosted: no CDN for the library code, the core, or the language data.
      await loadScript('vendor/tesseract.min.js');
      if (progressFn) progressFn('Preparing reader…');
      // Absolute vendor URL: both the trained data fetch and the core
      // importScripts run inside the web worker, where relative URLs resolve
      // against worker.min.js — a bare relative path would break under the
      // /route-runner/ subpath.
      const vendorUrl = new URL('vendor/', document.baseURI).href.replace(/\/$/, '');
      const creation = Tesseract.createWorker('eng', Tesseract.OEM.LSTM, {
        workerPath: 'vendor/worker.min.js',
        // Directory holding the tesseract.js-core v5 .wasm.js builds (the
        // worker picks the SIMD/LSTM variant itself); wasm is embedded.
        corePath: vendorUrl,
        langPath: vendorUrl,
      });
      let timer;
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(
          'Text reader failed to start (' + Math.round(timeoutMs / 1000) + 's timeout)')), timeoutMs);
      });
      try {
        const worker = await Promise.race([creation, timeout]);
        clearTimeout(timer);
        return worker;
      } catch (e) {
        clearTimeout(timer);
        // The caller never receives the worker — kill it if creation
        // eventually resolves so nothing leaks.
        creation.then((w) => { if (w && w.terminate) return w.terminate(); }).catch(() => {});
        workerPromise = null;
        throw (e instanceof Error ? e : new Error('Text reader failed to start'));
      }
    })();
    return workerPromise;
  }

  async function recognize(file) {
    try {
      const worker = await workerPromise;
      const processed = await preprocessImage(file);
      const { data } = await worker.recognize(processed);
      return postprocessText(data.text || '');
    } catch (e) {
      try { const w = await workerPromise; if (w && w.terminate) await w.terminate(); }
      catch {}
      workerPromise = null;
      throw e;
    }
  }

  async function done() {}

  window.RR_OCR = { load, recognize, done, _postprocessText: postprocessText };
})();
