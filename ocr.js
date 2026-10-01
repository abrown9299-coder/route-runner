/* RouteRunner ocr.js — lazy Tesseract.js wrapper for screenshot batch OCR. */
(function () {
  'use strict';
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector('script[data-rr="' + src + '"]')) return res();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.rr = src;
      s.onload = res; s.onerror = () => rej(new Error('cdn load failed'));
      document.head.appendChild(s);
    });
  }

  async function load(progressFn) {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      if (progressFn) progressFn('Loading text reader…');
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      if (progressFn) progressFn('Preparing reader (first run downloads language data)…');
      const worker = await Tesseract.createWorker('eng');
      return worker;
    })();
    return workerPromise;
  }

  async function recognize(file) {
    const worker = await workerPromise;
    const { data } = await worker.recognize(file);
    return data.text || '';
  }

  async function done() {
    // keep worker warm for the session — cheap, avoids re-downloading eng data
  }

  window.RR_OCR = { load, recognize, done };
})();
