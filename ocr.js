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

  async function load(progressFn) {
    if (workerPromise) {
      try { await workerPromise; return workerPromise; }
      catch { workerPromise = null; }
    }
    workerPromise = (async () => {
      if (progressFn) progressFn('Loading text reader…');
      // Self-hosted: no CDN for the library code
      await loadScript('vendor/tesseract.min.js');
      if (progressFn) progressFn('Preparing reader…');
      const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM, {
        workerPath: 'vendor/worker.min.js',
        corePath: 'vendor/tesseract-core.js',
        // langPath: trained data downloads once from default CDN on first use,
        // cached thereafter. Static download only — no user data is sent.
      });
      return worker;
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
