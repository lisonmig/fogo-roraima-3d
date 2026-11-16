// Fogo em Roraima 3D: realce das imagens Sentinel-2 por IA (super-resolução 4x), só para ilustrar.
// Modelo: SEN2SRLite RGBN x4 (ESA OpenSR / tacofoundation, licença CC0), convertido para ONNX (docs/ia/sen2srlite.onnx).
// A restrição física do modelo original (filtro de Fourier) é trocada por um filtro espacial: só os DETALHES finos vêm da IA,
// as cores e o brilho continuam os da foto real (o que se mede no relatório nunca usa estes pixels).
(function () {
  'use strict';
  const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  let sess = null;
  const loadScript = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('não carregou ' + src)); document.head.appendChild(s); });
  async function session() {
    if (sess) return sess;
    sess = (async () => {
      if (!window.ort) await loadScript(ORT + 'ort.min.js');
      window.ort.env.wasm.wasmPaths = ORT;
      window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      return window.ort.InferenceSession.create('ia/sen2srlite.onnx?v=1', { executionProviders: ['wasm'] });
    })();
    sess.catch(() => { sess = null; });
    return sess;
  }
  // desfoque de caixa separável (k ímpar), num plano w x h
  function boxBlur(src, w, h, k) {
    const r = k >> 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) { let s = 0; const o = y * w; for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[o + x] = s / k; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; } }
    for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / k; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
    return out;
  }
  // ampliação bilinear de um plano (w x h) por 4
  function up4(src, w, h) {
    const W = w * 4, H = h * 4, out = new Float32Array(W * H);
    for (let Y = 0; Y < H; Y++) { const fy = Math.min(h - 1, Math.max(0, (Y + 0.5) / 4 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
      for (let X = 0; X < W; X++) { const fx = Math.min(w - 1, Math.max(0, (X + 0.5) / 4 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
        out[Y * W + X] = (src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx) * (1 - ty) + (src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx) * ty; } }
    return out;
  }
  // tci: canvas da foto real (w x h); refl: Float32Array 4*w*h (R, G, B, NIR em reflectância, planos separados)
  // devolve um canvas D vezes maior (D = 2 a 4, saída até maxOut px) com os detalhes da IA somados à foto real
  async function realce(tci, refl, w, h, maxOut = 1800, onProg) {
    const s = await session();
    const D = maxOut / Math.max(w, h) >= 4 ? 4 : 2; // 4x quando cabe; senão 2x (média dos detalhes de cada 2x2)
    const out = document.createElement('canvas'); out.width = w * D; out.height = h * D;
    // base: a foto real reduzida ao tamanho real do satélite (desfaz pixels repetidos) e ampliada suave; a IA só soma os detalhes
    const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
    const sx = sm.getContext('2d'); sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = 'high'; sx.drawImage(tci, 0, 0, w, h);
    const ox = out.getContext('2d'); ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high'; ox.drawImage(sm, 0, 0, out.width, out.height);
    const base = ox.getImageData(0, 0, out.width, out.height), bd = base.data;
    const T = 112, M = 8, K = 9, GAIN = 255 / 0.2; // 0,2 de reflectância = 255 na foto 'visual' do Sentinel-2
    const tiles = []; for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
    let done = 0;
    for (const [tx, ty] of tiles) {
      const x0 = Math.max(0, tx - M), y0 = Math.max(0, ty - M), x1 = Math.min(w, tx + T + M), y1 = Math.min(h, ty + T + M), tw = x1 - x0, th = y1 - y0;
      const inp = new Float32Array(4 * tw * th);
      for (let c = 0; c < 4; c++) for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) inp[c * tw * th + y * tw + x] = refl[c * w * h + (y0 + y) * w + (x0 + x)];
      const res = await s.run({ lr: new window.ort.Tensor('float32', inp, [1, 4, th, tw]) });
      const sr = res.sr.data, TW = tw * 4, TH = th * 4, N = TW * TH;
      for (let c = 0; c < 3; c++) {
        const b = sr.subarray(c * N, (c + 1) * N).map(v => Math.max(0, v)), u = up4(inp.subarray(c * tw * th, (c + 1) * tw * th), tw, th);
        const bb = boxBlur(b, TW, TH, K), ub = boxBlur(u, TW, TH, K);
        // só o miolo do ladrilho (sem a margem), levado à escala D da saída
        const cx0 = (tx - x0) * 4, cy0 = (ty - y0) * 4, cw = Math.min(T, w - tx) * 4, ch = Math.min(T, h - ty) * 4, f = 4 / D;
        for (let Y = 0; Y < ch / f; Y++) for (let X = 0; X < cw / f; X++) {
          let hf = 0; for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) { const q = (cy0 + Y * f + j) * TW + (cx0 + X * f + i); hf += (b[q] - bb[q]) - (u[q] - ub[q]); }
          const o = ((ty * D + Y) * out.width + (tx * D + X)) * 4;
          if (bd[o + 3]) bd[o + c] = Math.max(0, Math.min(255, bd[o + c] + hf / (f * f) * GAIN));
        }
      }
      done++; if (onProg) onProg(done / tiles.length);
      await new Promise(r => setTimeout(r, 0)); // deixa a página respirar entre os ladrilhos
    }
    ox.putImageData(base, 0, 0);
    return out;
  }
  window.FRR_IA = { realce, modelo: 'SEN2SRLite RGBN x4 (ESA OpenSR, CC0)' };
})();
