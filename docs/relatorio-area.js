/* Fogo em Roraima 3D · Relatório técnico da área (queimada, degradação ou desmatamento).
   Loaded only when someone asks for the report of an area. The main page exposes its data in window.FRR.
   Everything here is computed in the browser from public data; nothing about the area is sent anywhere,
   except the area's bounding box to the image (Microsoft Planetary Computer, NASA GIBS), weather (Open-Meteo)
   and photo (Wikimedia Commons) services. */
(function () {
  'use strict';
  const PC = 'https://planetarycomputer.microsoft.com/api';
  const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
  const OM = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
  const OMAQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  const OMARCH = 'https://archive-api.open-meteo.com/v1/archive';
  const VERSION = '1.0';
  const LAYERS = {};
  const layer = name => LAYERS[name] || (LAYERS[name] = fetch('rel/' + name, { cache: 'force-cache' }).then(r => r.ok ? r.json() : null).catch(() => null));

  // ---------- small helpers
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nf = (n, d = 0) => (n == null || !isFinite(n)) ? '–' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const haTxt = h => h == null ? '–' : (h < 10 ? nf(h, 2) : h < 100 ? nf(h, 1) : nf(h, 0)) + ' ha';
  const kmTxt = k => k == null ? '–' : k < 1 ? nf(k * 1000, 0) + ' m' : (k < 10 ? nf(k, 1) : nf(k, 0)) + ' km';
  const br = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '–';
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const today = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
  const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error('tempo esgotado')), ms))]);
  const getJSON = (u, ms = 30000) => withTimeout(fetch(u).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }), ms);
  const DIRS = ['norte', 'nordeste', 'leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste'];
  const dirName = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  const gms = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60; return d + '°' + String(m).padStart(2, '0') + "'" + s.toFixed(1).padStart(4, '0') + '"' + (v >= 0 ? pos : neg); };

  // delta-encoded integer rings (rel/*.json, car_todos.json) -> flat [lon, lat, lon, lat, ...]
  function decRings(list, ox, oy, q) {
    return list.map(fl => { let x = fl[0], y = fl[1]; const r = [ox + x / q, oy + y / q]; for (let k = 2; k < fl.length; k += 2) { x += fl[k]; y += fl[k + 1]; r.push(ox + x / q, oy + y / q); } return r; });
  }
  function boxOf(rings) {
    let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
    rings.forEach(r => { for (let j = 0; j < r.length; j += 2) { a = Math.min(a, r[j]); b = Math.max(b, r[j]); c = Math.min(c, r[j + 1]); d = Math.max(d, r[j + 1]); } });
    return [a, c, b, d];
  }
  const boxHit = (A, B) => A[0] <= B[2] && A[2] >= B[0] && A[1] <= B[3] && A[3] >= B[1];
  function pip(lon, lat, r) {
    let ins = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  const inRings = (lon, lat, rings) => rings.some(r => pip(lon, lat, r));
  const kmx = lat => 111.32 * Math.cos(lat * Math.PI / 180);
  function ringHa(r) { // planar area on a local projection (good for areas up to tens of km)
    let lat0 = 0; for (let j = 1; j < r.length; j += 2) lat0 += r[j]; lat0 /= r.length / 2;
    const kx = kmx(lat0), ky = 110.57; let s = 0;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += (r[j] * kx) * (r[i + 1] * ky) - (r[i] * kx) * (r[j + 1] * ky);
    return Math.abs(s) / 2 * 100;
  }
  function ringPerimKm(r) { let s = 0; for (let i = 2; i < r.length; i += 2) s += distKm(r[i - 2], r[i - 1], r[i], r[i + 1]); return s; }
  const distKm = (lo1, la1, lo2, la2) => Math.hypot((lo2 - lo1) * kmx((la1 + la2) / 2), (la2 - la1) * 110.57);
  function segDistKm(lon, lat, a, b) { // point to segment, km
    const kx = kmx(lat), ax = (a[0] - lon) * kx, ay = (a[1] - lat) * 110.57, bx = (b[0] - lon) * kx, by = (b[1] - lat) * 110.57;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  function ringDistKm(lon, lat, r) { let best = 1e9; for (let i = 2; i < r.length; i += 2) best = Math.min(best, segDistKm(lon, lat, [r[i - 2], r[i - 1]], [r[i], r[i + 1]])); return best; }
  // distance between the area and another polygon: 0 when they touch; else the smallest distance from the area's samples/vertices
  function polyDistKm(area, rings, box) {
    if (boxHit(area.box, box) && area.samples.some(p => inRings(p[0], p[1], rings))) return 0;
    let best = 1e9;
    const pts = area.edge;
    for (const r of rings) for (const p of pts) best = Math.min(best, ringDistKm(p[0], p[1], r));
    return best;
  }
  // regular sample of points inside the area (about 1500), used to measure overlaps as a share of the area
  function samplesOf(rings, box) {
    const n = 60, sx = (box[2] - box[0]) / n, sy = (box[3] - box[1]) / n, out = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const lon = box[0] + (i + 0.5) * sx, lat = box[1] + (j + 0.5) * sy; if (inRings(lon, lat, rings)) out.push([lon, lat]); }
    if (!out.length) { const r = rings[0]; out.push([r[0], r[1]]); }
    return out;
  }
  function edgeOf(rings) { const out = []; rings.forEach(r => { const st = Math.max(2, Math.floor(r.length / 2 / 80) * 2); for (let j = 0; j < r.length; j += st) out.push([r[j], r[j + 1]]); }); return out; }
  const share = (area, test) => { let k = 0; for (const p of area.samples) if (test(p[0], p[1])) k++; return k / area.samples.length; };

  // ---------- satellite images: Sentinel-2 L2A (10 m) from the Microsoft Planetary Computer, cropped to the area
  async function s2Search(bbox, from, to) {
    const u = PC + '/stac/v1/search?collections=sentinel-2-l2a&bbox=' + bbox.map(v => v.toFixed(5)).join(',') + '&datetime=' + from + 'T00:00:00Z/' + to + 'T23:59:59Z&limit=60';
    const J = await getJSON(u, 30000);
    return (J.features || []).map(f => ({ id: f.id, date: f.properties.datetime.slice(0, 10), cloud: f.properties['eo:cloud_cover'] }));
  }
  const cropUrl = (id, b, w, h, q) => PC + '/data/v1/item/bbox/' + b.map(v => v.toFixed(5)).join(',') + '/' + w + 'x' + h + '.png?collection=sentinel-2-l2a&item=' + encodeURIComponent(id) + '&dst_crs=epsg:4326&' + q;
  const Q_RGB = 'assets=visual&asset_bidx=visual%7C1,2,3&nodata=0';
  const Q_NBR = 'expression=' + encodeURIComponent('(B08-B12)/(B08+B12)') + '&asset_as_band=true&rescale=-1,1';
  const Q_SCL = 'assets=SCL';
  async function loadPixels(url, ms = 45000) {
    const r = await withTimeout(fetch(url), ms); if (!r.ok) throw new Error('HTTP ' + r.status);
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
    return { w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data, canvas: c };
  }
  // share of the area's pixels that are clear (not cloud, shadow, or missing) in a scene, from the scene classification (SCL)
  function clearShare(scl, mask) { let n = 0, ok = 0; for (let k = 0; k < mask.length; k++) if (mask[k]) { n++; const v = scl.data[k * 4], a = scl.data[k * 4 + 3]; if (a && v !== 0 && v !== 1 && v !== 3 && v !== 8 && v !== 9 && v !== 10) ok++; } return n ? ok / n : 0; }
  async function bestScene(cands, frame, mask, prefer) {
    if (!cands.length) return null;
    cands.sort((a, b) => (a.cloud - b.cloud) || (Math.abs(dayDiff(prefer, a.date)) - Math.abs(dayDiff(prefer, b.date))));
    const near = cands.slice().sort((a, b) => Math.abs(dayDiff(prefer, a.date)) - Math.abs(dayDiff(prefer, b.date))).filter(c => c.cloud < 60).slice(0, 3);
    const order = [...new Map(near.concat(cands.slice(0, 4)).map(c => [c.id, c])).values()].slice(0, 6);
    let best = null;
    for (const c of order) {
      try {
        const scl = await loadPixels(cropUrl(c.id, frame.b, frame.w, frame.h, Q_SCL), 30000);
        const cs = clearShare(scl, mask);
        if (!best || cs > best.clear + 0.02) best = Object.assign({}, c, { clear: cs, scl });
        if (cs >= 0.9) break;
      } catch (e) { /* try the next one */ }
    }
    return best;
  }
  function frameOf(area) {
    const b = area.box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, kx = kmx(cy);
    let wk = (b[2] - b[0]) * kx, hk = (b[3] - b[1]) * 110.57; const side = Math.max(1.2, Math.max(wk, hk) * 1.35);
    const halfLon = side / 2 / kx, halfLat = side / 2 / 110.57;
    const bb = [cx - halfLon, cy - halfLat, cx + halfLon, cy + halfLat];
    const px = Math.max(256, Math.min(900, Math.round(side * 1000 / 10)));
    return { b: bb, w: px, h: px, km: side };
  }
  function maskOf(area, frame) {
    const m = new Uint8Array(frame.w * frame.h), [x0, y0, x1, y1] = frame.b;
    for (let j = 0; j < frame.h; j++) { const lat = y1 - (j + 0.5) / frame.h * (y1 - y0); for (let i = 0; i < frame.w; i++) { const lon = x0 + (i + 0.5) / frame.w * (x1 - x0); if (lon >= area.box[0] && lon <= area.box[2] && lat >= area.box[1] && lat <= area.box[3] && inRings(lon, lat, area.rings)) m[j * frame.w + i] = 1; } }
    return m;
  }
  // draws the area outline, a scale bar and north arrow over an image; returns a JPEG data URL
  function figure(canvas, area, frame, label) {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext('2d');
    // parts outside the satellite pass have no data: light grey with thin stripes, so they are not mistaken for burned land
    x.fillStyle = '#dcd7cf'; x.fillRect(0, 0, c.width, c.height); x.strokeStyle = 'rgba(0,0,0,.08)'; x.lineWidth = 1;
    for (let k = -c.height; k < c.width; k += 10) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k + c.height, c.height); x.stroke(); }
    x.drawImage(canvas, 0, 0);
    const [x0, y0, x1, y1] = frame.b, P = (lon, lat) => [(lon - x0) / (x1 - x0) * c.width, (y1 - lat) / (y1 - y0) * c.height];
    x.lineWidth = Math.max(2, c.width / 300); x.strokeStyle = '#ffe14d'; x.shadowColor = 'rgba(0,0,0,.8)'; x.shadowBlur = 3;
    area.rings.forEach(r => { x.beginPath(); for (let j = 0; j < r.length; j += 2) { const [px, py] = P(r[j], r[j + 1]); j ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); x.stroke(); });
    x.shadowBlur = 0;
    // scale bar
    const kmPerPx = frame.km / c.width, nice = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50].find(v => v / kmPerPx > c.width * 0.18) || 50, L = nice / kmPerPx;
    const fs = Math.max(11, Math.round(c.width / 45)), bx = 12, by = c.height - 14;
    x.fillStyle = 'rgba(255,255,255,.85)'; x.fillRect(bx - 6, by - fs - 12, L + 12 + fs * 3, fs + 20);
    x.fillStyle = '#111'; x.fillRect(bx, by - 6, L, 6); x.fillStyle = '#fff'; x.fillRect(bx + L / 2, by - 5, L / 2 - 1, 4);
    x.fillStyle = '#111'; x.font = '600 ' + fs + 'px system-ui, sans-serif'; x.fillText(nice < 1 ? (nice * 1000) + ' m' : nice + ' km', bx + L + 6, by);
    // north arrow
    const nx = c.width - 22, ny = 16;
    x.fillStyle = 'rgba(255,255,255,.85)'; x.beginPath(); x.arc(nx, ny + 12, 15, 0, 7); x.fill();
    x.fillStyle = '#111'; x.beginPath(); x.moveTo(nx, ny); x.lineTo(nx - 6, ny + 16); x.lineTo(nx + 6, ny + 16); x.closePath(); x.fill();
    x.font = '700 10px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText('N', nx, ny + 26);
    if (label) { x.textAlign = 'left'; x.font = '600 ' + fs + 'px system-ui, sans-serif'; const tw = x.measureText(label).width; x.fillStyle = 'rgba(0,0,0,.65)'; x.fillRect(8, 8, tw + 14, fs + 10); x.fillStyle = '#fff'; x.fillText(label, 15, 8 + fs + 2); }
    return c.toDataURL('image/jpeg', 0.86);
  }
  // burn severity (dNBR = NBR before − NBR after; Key & Benson, USGS FIREMON), only on clear pixels inside the area
  const DESM_NAME = { 'Sem queima detectável': 'Sem mudança detectável', 'Baixa': 'Perda baixa', 'Moderada-baixa': 'Perda moderada-baixa', 'Moderada-alta': 'Perda moderada-alta', 'Alta': 'Perda alta' };
  const SEV = [[-9, -0.1, 'Rebrota / aumento do verde', '#1a9850'], [-0.1, 0.1, 'Sem queima detectável', '#d9ef8b'], [0.1, 0.27, 'Baixa', '#fee08b'],
    [0.27, 0.44, 'Moderada-baixa', '#fdae61'], [0.44, 0.66, 'Moderada-alta', '#f46d43'], [0.66, 9, 'Alta', '#a50026']];
  function severity(pre, post, sclPre, sclPost, mask, frame) {
    const ok = (s, k) => { const v = s.data[k * 4]; return s.data[k * 4 + 3] && v !== 0 && v !== 1 && v !== 3 && v !== 8 && v !== 9 && v !== 10; };
    const cnt = new Array(SEV.length).fill(0); let n = 0, sum = 0, used = 0, inside = 0;
    const c = document.createElement('canvas'); c.width = frame.w; c.height = frame.h;
    const x = c.getContext('2d'), img = x.createImageData(frame.w, frame.h);
    for (let k = 0; k < mask.length; k++) {
      const good = pre.data[k * 4 + 3] && post.data[k * 4 + 3] && ok(sclPre, k) && ok(sclPost, k);
      const d = good ? (pre.data[k * 4] / 255 * 2 - 1) - (post.data[k * 4] / 255 * 2 - 1) : null;
      if (d != null) {
        const s = SEV.findIndex(v => d >= v[0] && d < v[1]), col = SEV[Math.max(0, s)][3];
        img.data[k * 4] = parseInt(col.slice(1, 3), 16); img.data[k * 4 + 1] = parseInt(col.slice(3, 5), 16); img.data[k * 4 + 2] = parseInt(col.slice(5, 7), 16); img.data[k * 4 + 3] = mask[k] ? 255 : 90;
      } else { img.data[k * 4 + 3] = mask[k] ? 255 : 0; img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = 120; }
      if (!mask[k]) continue; inside++;
      if (d == null) continue; used++; sum += d; cnt[Math.max(0, SEV.findIndex(v => d >= v[0] && d < v[1]))]++;
    }
    x.putImageData(img, 0, 0);
    const pxHa = Math.pow(frame.km * 1000 / frame.w, 2) / 1e4;
    return { canvas: c, mean: used ? sum / used : null, cover: inside ? used / inside : 0, classes: SEV.map((s, i) => ({ name: s[2], color: s[3], ha: cnt[i] * pxHa, pct: used ? cnt[i] / used : 0 })), burnedHa: cnt.slice(2).reduce((a, b) => a + b, 0) * pxHa };
  }
  async function imagery(area, ctx, step) {
    if (area.ano && area.ano < 2017) return imageryLs(area, ctx, step);
    const frame = frameOf(area), mask = maskOf(area, frame), d = area.date, t = today();
    step('Procurando imagens Sentinel-2 sem nuvem (antes e depois)');
    const [preC, postC, nowC] = await Promise.all([
      s2Search(frame.b, addDays(d, -150), addDays(d, -2)).catch(() => []),
      s2Search(frame.b, addDays(area.date1 || d, 1), addDays(area.date1 || d, 75) > t ? t : addDays(area.date1 || d, 75)).catch(() => []),
      dayDiff(addDays(area.date1 || d, 75), t) > 20 ? s2Search(frame.b, addDays(t, -90), t).catch(() => []) : Promise.resolve([])]);
    step('Conferindo nuvens sobre a área em cada imagem');
    let [pre, post, now] = await Promise.all([bestScene(preC, frame, mask, addDays(d, -10)), bestScene(postC, frame, mask, addDays(area.date1 || d, 10)), bestScene(nowC, frame, mask, t)]);
    // fire ended a few days ago (or still burning): no clear image after it yet, so take the one with the least cloud over the area
    // since the fire started, even if cloudy, and say it is from during the fire
    if (!post) {
      step('Sem imagem limpa depois do fogo: buscando a de menos nuvem desde o início do incêndio');
      const durC = await s2Search(frame.b, d, t).catch(() => []);
      post = await bestScene(durC, frame, mask, t);
    }
    // 'depois' only for images taken after the last day of the fire; on or before it, with fire in the area, the image is 'durante'
    if (post) post.during = post.date <= (area.date1 || d);
    const out = { frame, pre, post, now, figs: {} };
    step('Baixando as imagens recortadas na área');
    const jobs = [];
    for (const [k, sc, lab] of [['pre', pre, 'ANTES'], ['post', post, post && post.during ? 'DURANTE O FOGO' : 'DEPOIS'], ['now', now, 'HOJE']]) if (sc) jobs.push(loadPixels(cropUrl(sc.id, frame.b, frame.w, frame.h, Q_RGB)).then(p => { out.figs[k] = figure(p.canvas, area, frame, lab + ' · ' + br(sc.date)); }).catch(() => {}));
    if (pre && post) jobs.push(Promise.all([loadPixels(cropUrl(pre.id, frame.b, frame.w, frame.h, Q_NBR)), loadPixels(cropUrl(post.id, frame.b, frame.w, frame.h, Q_NBR))])
      .then(([a, b]) => { out.sev = severity(a, b, pre.scl, post.scl, mask, frame); out.figs.sev = figure(out.sev.canvas, area, frame, 'GRAVIDADE (dNBR)'); }).catch(() => {}));
    await Promise.all(jobs);
    // backup when the Planetary Computer is down: NASA HLS (30 m) for the same dates, no measurement
    if (!out.figs.pre && !out.figs.post) {
      step('Usando imagem de reserva (NASA HLS, 30 m)');
      for (const [k, day, lab] of [['pre', addDays(d, -20), 'ANTES (HLS)'], ['post', addDays(area.date1 || d, 10) > t ? t : addDays(area.date1 || d, 10), 'DEPOIS (HLS)']]) {
        try {
          const u = GIBS + '?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=HLS_S30_Nadir_BRDF_Adjusted_Reflectance&STYLES=&SRS=EPSG:4326&BBOX=' + frame.b.join(',') + '&WIDTH=' + Math.min(frame.w, 512) + '&HEIGHT=' + Math.min(frame.h, 512) + '&FORMAT=image/jpeg&TIME=' + day;
          const p = await loadPixels(u, 30000); out.figs[k] = figure(p.canvas, area, frame, lab + ' · ~' + br(day)); out.hls = true;
        } catch (e) {}
      }
    }
    return out;
  }

  // ---------- relatorio de um ano: o mesmo relatorio completo, com as datas e os focos daquele ano no local
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  async function lsSearch(bbox, from, to) {
    const u = PC + '/stac/v1/search?collections=landsat-c2-l2&bbox=' + bbox.map(v => v.toFixed(5)).join(',') + '&datetime=' + from + 'T00:00:00Z/' + to + 'T23:59:59Z&limit=60';
    const J = await getJSON(u, 30000);
    return (J.features || []).map(f => ({ id: f.id, date: f.properties.datetime.slice(0, 10), cloud: f.properties['eo:cloud_cover'], plat: f.properties.platform || '' }));
  }
  const lsCrop = (id, b, w, h) => PC + '/data/v1/item/bbox/' + b.map(v => v.toFixed(5)).join(',') + '/' + w + 'x' + h + '.png?collection=landsat-c2-l2&item=' + encodeURIComponent(id) +
    '&dst_crs=epsg:4326&assets=red&assets=green&assets=blue&rescale=7300,14000&nodata=0';
  // Landsat: a cena com menos nuvem sobre a propria area, entre as candidatas (mede a nuvem dentro da area pelos pixels muito claros)
  async function pickLs(c, frame, m, w, h, prefer) {
    if (!c.length) return null;
    const score = s => s.cloud + (s.plat === 'landsat-7' && s.date > '2003-05-31' ? 30 : 0) + Math.abs(dayDiff(prefer, s.date)) / 10;
    let best = null;
    for (const sc of c.slice().sort((a, b) => score(a) - score(b)).slice(0, 4)) {
      try {
        const p = await loadPixels(lsCrop(sc.id, frame.b, w, h), 30000); let n = 0, cl = 0;
        for (let k = 0; k < m.length; k++) { if (!m[k]) continue; n++; if (!p.data[k * 4 + 3] || (p.data[k * 4] > 200 && p.data[k * 4 + 1] > 200 && p.data[k * 4 + 2] > 200)) cl++; }
        const clear = n ? 1 - cl / n : 0;
        if (!best || clear > best.clear + 0.02) best = { sc, p, clear };
        if (clear >= 0.95) break;
      } catch (e) { /* proxima cena */ }
    }
    return best;
  }
  // antes de 2017 não há Sentinel-2 contínuo: antes e depois com Landsat (sem medir a gravidade)
  async function imageryLs(area, ctx, step) {
    const frame = frameOf(area), d = area.date, d1 = area.date1 || d, w = Math.min(frame.w, 600), h = Math.min(frame.h, 600), m = maskOf(area, { b: frame.b, w, h });
    step('Procurando imagens Landsat antes e depois do fogo (anteriores ao Sentinel-2)');
    const [preC, postC] = await Promise.all([lsSearch(frame.b, addDays(d, -150), addDays(d, -2)).catch(() => []), lsSearch(frame.b, addDays(d1, 1), addDays(d1, 75)).catch(() => [])]);
    const [pre, post] = await Promise.all([pickLs(preC, frame, m, w, h, addDays(d, -10)), pickLs(postC, frame, m, w, h, addDays(d1, 10))]);
    const out = { frame, pre: null, post: null, now: null, figs: {}, ls: true };
    if (pre) { out.pre = { date: pre.sc.date, clear: pre.clear }; out.figs.pre = figure(pre.p.canvas, area, frame, 'ANTES · Landsat · ' + br(pre.sc.date)); }
    if (post) { out.post = { date: post.sc.date, clear: post.clear }; out.figs.post = figure(post.p.canvas, area, frame, 'DEPOIS · Landsat · ' + br(post.sc.date)); }
    return out;
  }
  // um relatorio por ano: fecha o que estiver aberto e monta o relatorio completo daquele ano
  function showYearMsg(y, msg) {
    const el = document.getElementById('report') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'report' }));
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Relatório do ano ' + y);
    el.innerHTML = '<div class="rep-page ar-page"><p class="rep-kick">Fogo em Roraima 3D · relatório técnico do ano ' + y + '</p><h1>Fogo em ' + y + ' no local</h1><p>' + esc(msg) + '</p><div class="rep-actions"><button class="btn" data-a="close">Fechar</button></div></div>';
    el.onclick = e => { if (e.target.dataset && e.target.dataset.a === 'close') el.remove(); };
  }
  async function openYearReport(area, rec, y) {
    const J = await fetch('rel/anos/' + y + '.json', { cache: 'force-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!J) { showYearMsg(y, 'Não foi possível carregar os focos de ' + y + '. Tente de novo com internet.'); return; }
    const G = J.g, [ox, oy] = J.origin, cells = new Set(rec.cells), T0 = Date.parse(window.FRR.D.meta.t0.replace('Z', ':00Z')), fires = [];
    for (let k = 0; k < J.f.length; k += 4) {
      if (!cells.has(J.f[k] + ',' + J.f[k + 1])) continue;
      const dia = J.f[k + 2], hora = J.f[k + 3];
      fires.push({ lon: ox + J.f[k] * G, lat: oy + J.f[k + 1] * G, t: (Date.UTC(y, 0, dia, hora) - T0) / 60000, dia });
    }
    if (!fires.length) { showYearMsg(y, 'Nenhum foco do satélite de referência nos quadrados da área em ' + y + '.'); return; }
    const iso = d => new Date(Date.UTC(y, 0, d)).toISOString().slice(0, 10);
    const dmin = Math.min(...fires.map(f => f.dia)), dmax = Math.max(...fires.map(f => f.dia));
    open(Object.assign({}, area, { title: 'Fogo de ' + y }), { ano: { y, fires, date: iso(dmin), date1: iso(dmax) } });
  }
  // ---------- land cover history: MODIS IGBP 2001–2023 (NASA GIBS), majority class inside the area
  const LC_NAMES = ['Floresta', 'Lavrado / savana', 'Campo ou pasto', 'Agricultura', 'Área alagável', 'Área urbana', 'Água', 'Outros'];
  const IGBP = [[[33, 138, 33], 0], [[49, 204, 49], 0], [[152, 204, 49], 0], [[150, 250, 150], 0], [[141, 186, 141], 0], [[186, 141, 141], 1], [[245, 222, 179], 1], [[218, 235, 157], 1], [[255, 213, 0], 1],
    [[240, 185, 103], 2], [[71, 131, 181], 4], [[250, 239, 115], 3], [[255, 0, 0], 5], [[153, 147, 86], 3], [[134, 202, 227], 6]];
  function igbpClass(r, g, b) { let best = 7, bd = 30; for (const [c, k] of IGBP) { const d = Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b); if (d < bd) { bd = d; best = k; } } return best; }
  async function landHistory(area) {
    const b = area.box, pad = 0.004, bb = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], W = 40, H = 40, years = [];
    for (let y = 2001; y <= 2023; y += 1) years.push(y);
    const res = await Promise.all(years.map(y => loadPixels(GIBS + '?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual&STYLES=&SRS=EPSG:4326&BBOX=' + bb.join(',') + '&WIDTH=' + W + '&HEIGHT=' + H + '&FORMAT=image/png&TIME=' + y + '-01-01', 25000).then(p => {
      const cnt = new Array(8).fill(0);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const lon = bb[0] + (i + .5) / W * (bb[2] - bb[0]), lat = bb[3] - (j + .5) / H * (bb[3] - bb[1]); if (!inRings(lon, lat, area.rings)) continue; const k = (j * W + i) * 4; if (p.data[k + 3] < 128) continue; cnt[igbpClass(p.data[k], p.data[k + 1], p.data[k + 2])]++; }
      const tot = cnt.reduce((a, c) => a + c, 0); if (!tot) return null;
      const top = cnt.map((c, k) => [k, c]).sort((a, b2) => b2[1] - a[1]);
      return { y, cls: top[0][0], pct: top[0][1] / tot, mix: top.filter(t => t[1] / tot >= 0.15).map(t => [t[0], t[1] / tot]) };
    }).catch(() => null)));
    return res.filter(Boolean);
  }

  // ---------- weather and air before/after the date (Open-Meteo: weather model, not a station)
  async function weather(area) {
    const [lon, lat] = area.center, d0 = addDays(area.date, -30), d1 = addDays(area.date1 || area.date, 2) > today() ? today() : addDays(area.date1 || area.date, 2);
    const u = (area.date < '2022-01-01' ? OMARCH : OM) + '?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) + '&start_date=' + d0 + '&end_date=' + d1 +
      '&daily=precipitation_sum,temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,wind_direction_10m_dominant&timezone=America%2FBoa_Vista';
    const J = await getJSON(u, 30000), D = J.daily;
    const days = D.time.map((t, i) => ({ t, rain: D.precipitation_sum[i], tmax: D.temperature_2m_max[i], rh: D.relative_humidity_2m_min[i], wind: D.wind_speed_10m_max[i], dir: D.wind_direction_10m_dominant[i] }));
    const before = days.filter(x => x.t < area.date), at = days.find(x => x.t === area.date) || days[days.length - 1];
    let dry = 0; for (let i = before.length - 1; i >= 0; i--) { if ((before[i].rain || 0) >= 5) break; dry++; }
    const rain30 = before.reduce((a, x) => a + (x.rain || 0), 0);
    let air = null;
    try {
      if (area.date < '2013-01-01') throw new Error('sem dados de qualidade do ar antes de 2013');
      const A = await getJSON(OMAQ + '?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) + '&hourly=pm2_5&start_date=' + addDays(area.date, -1) + '&end_date=' + (addDays(area.date1 || area.date, 3) > today() ? today() : addDays(area.date1 || area.date, 3)) + '&timezone=America%2FBoa_Vista', 25000);
      const by = new Map(); A.hourly.time.forEach((t, i) => { const v = A.hourly.pm2_5[i]; if (v == null) return; const k = t.slice(0, 10); const o = by.get(k) || [0, 0]; o[0] += v; o[1]++; by.set(k, o); });
      const daily = [...by].map(([k, [s, n]]) => [k, s / n]).sort((a, b) => b[1] - a[1]);
      if (daily.length) air = { day: daily[0][0], pm: daily[0][1] };
    } catch (e) {}
    return { days, at, dry, rain30, air };
  }

  // ---------- photos near the area (Wikimedia Commons, free licences)
  async function photos(area) {
    const [lon, lat] = area.center;
    const J = await getJSON('https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=' + lat.toFixed(5) + '%7C' + lon.toFixed(5) + '&ggsradius=10000&ggsnamespace=6&ggslimit=8&prop=imageinfo%7Ccoordinates&iiprop=url%7Cextmetadata&iiurlwidth=320&format=json&origin=*', 20000);
    const pages = J.query && J.query.pages ? Object.values(J.query.pages) : [];
    return pages.map(p => { const ii = p.imageinfo && p.imageinfo[0]; if (!ii) return null; const m = ii.extmetadata || {}; const c = p.coordinates && p.coordinates[0];
      const strip = h => String(h || '').replace(/<[^>]+>/g, '').trim();
      return { thumb: ii.thumburl, page: ii.descriptionurl, title: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''), author: strip(m.Artist && m.Artist.value).slice(0, 60), lic: strip(m.LicenseShortName && m.LicenseShortName.value), km: c ? distKm(lon, lat, c.lon, c.lat) : null };
    }).filter(Boolean).sort((a, b) => (a.km || 99) - (b.km || 99)).slice(0, 4);
  }

  // ---------- layers prepared by scripts/prep_relatorio.py
  async function polyLayer(name) {
    const J = await layer(name); if (!J) return null;
    const [ox, oy] = J.origin || [0, 0], q = J.q || 1e4;
    return { meta: J, items: J.itens.map(it => { const rings = decRings(it[it.length - 1] || [], ox, oy, q); return { a: it, rings, box: rings.length ? boxOf(rings) : [0, 0, -1, -1] }; }) };
  }
  function overlaps(area, L, maxKm) {
    const out = [];
    if (!L) return out;
    const pad = maxKm / 100, big = [area.box[0] - pad, area.box[1] - pad, area.box[2] + pad, area.box[3] + pad];
    for (const it of L.items) {
      if (!it.rings.length || !boxHit(big, it.box)) continue;
      const sh = boxHit(area.box, it.box) ? share(area, (lo, la) => inRings(lo, la, it.rings)) : 0;
      const dk = sh > 0 ? 0 : polyDistKm(area, it.rings, it.box);
      if (sh > 0 || dk <= maxKm) out.push({ it, share: sh, km: dk });
    }
    return out.sort((a, b) => b.share - a.share || a.km - b.km);
  }

  // ---------- the report
  const isDesm = area => area.kind === 'deter' || area.kind === 'prodes';
  const LEVEL = { 3: ['alto', 'Indício forte', '#b42318'], 2: ['medio', 'Atenção', '#b54708'], 1: ['info', 'Informação', '#475467'] };
  let running = false;
  // aviso curto na tela (quando um pedido chega enquanto outro relatorio ainda esta montando)
  function avisa(txt) {
    let t = document.getElementById('arAviso');
    if (!t) { t = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'arAviso' })); t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10000;background:#1b1917;color:#fff;padding:10px 14px;border-radius:8px;font:14px system-ui,sans-serif;max-width:90vw;box-shadow:0 4px 16px rgba(0,0,0,.3)'; }
    t.textContent = txt; clearTimeout(t._h); t._h = setTimeout(() => t.remove(), 4000);
  }
  async function open(area0, opts) {
    if (running) { avisa('Aguarde o relatório atual terminar (ou cancele) e tente de novo.'); return; } running = true;
    const A = window.FRR;
    const el = document.getElementById('report') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'report' }));
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Relatório técnico da área');
    el.innerHTML = '<div class="rep-page ar-wait"><p class="rep-kick">Fogo em Roraima 3D · relatório técnico da área</p><h1>Montando o relatório…</h1><p class="rep-sub">Juntando dados públicos de várias fontes. Leva de 20 a 60 segundos, conforme a internet.</p><ol id="arSteps"></ol><button class="btn" id="arCancel">Cancelar</button></div>';
    let cancelled = false;
    el.querySelector('#arCancel').onclick = () => { cancelled = true; el.remove(); running = false; };
    const stepsEl = el.querySelector('#arSteps');
    const step = t => { if (cancelled) return; const li = document.createElement('li'); li.textContent = t; stepsEl.appendChild(li); };
    try {
      const area = Object.assign({}, area0);
      if (opts && opts.ano) { area.date = opts.ano.date; area.date1 = opts.ano.date1; area.ano = opts.ano.y; }
      area.rings = area0.rings.filter(r => r.length >= 6);
      area.box = boxOf(area.rings);
      area.samples = samplesOf(area.rings, area.box);
      area.edge = edgeOf(area.rings);
      const cx = area.samples.reduce((a, p) => a + p[0], 0) / area.samples.length, cy = area.samples.reduce((a, p) => a + p[1], 0) / area.samples.length;
      area.center = inRings(cx, cy, area.rings) ? [cx, cy] : area.samples[Math.floor(area.samples.length / 2)];
      area.haCalc = area.rings.reduce((a, r) => a + ringHa(r), 0);
      area.perim = area.rings.reduce((a, r) => a + ringPerimKm(r), 0);

      step('Lendo os dados do mapa (focos, imóveis, terras indígenas, rios)');
      await Promise.all([A.loadCarTodos ? A.loadCarTodos() : null, A.loadProdes ? A.loadProdes() : null].filter(Boolean)).catch(() => {});

      step('Carregando camadas oficiais (florestas públicas, UCs, embargos, autorizações, solos, população, saúde)');
      const [FP, UC, EMB, SOL, GEO] = await Promise.all(['florestas_publicas.json', 'ucs.json', 'embargos.json', 'solos.json', 'geologia.json'].map(polyLayer));
      const [ASV, POP, SAU, REC] = await Promise.all(['asv.json', 'populacao.json', 'saude.json', 'recorrencia.json'].map(layer));

      const tasks = {
        img: imagery(area, A, step).catch(e => ({ err: e.message })),
        lc: (step('Buscando a vegetação de 2001 a 2023 (MODIS)'), landHistory(area).catch(() => [])),
        wx: (step('Buscando chuva, umidade, vento e fumaça do período'), weather(area).catch(e => ({ err: e.message }))),
        ph: photos(area).catch(() => [])
      };
      const [img, lc, wx, ph] = await Promise.all([tasks.img, tasks.lc, tasks.wx, tasks.ph]);
      if (cancelled) return;
      step('Cruzando tudo e escrevendo o relatório');
      const R = analyse(area, A, { FP, UC, EMB, SOL, GEO, ASV, POP, SAU, REC, img, lc, wx, ph, anoFires: opts && opts.ano ? opts.ano.fires : null, ano: opts && opts.ano ? opts.ano.y : null });
      render(el, area, R);
      if (opts && opts.cars && opts.cars.length) {
        const preps = [];
        for (let k = 0; k < opts.cars.length; k++) {
          try { preps.push(await carBlock(el, opts.cars[k], area, R, k + 1, opts.cars.length)); }
          catch (e) { el.querySelector('.rep-page').insertAdjacentHTML('beforeend', '<p style="color:#b42318">Não foi possível montar o imóvel ' + (k + 1) + ' do CAR: ' + esc(e.message) + '</p>'); }
        }
        if (preps.length > 1) await overlapBlock(el, opts.cars, preps, area).catch(e => { el.querySelector('.rep-page').insertAdjacentHTML('beforeend', '<p style="color:#b42318">Não foi possível montar a sobreposição: ' + esc(e.message) + '</p>'); });
      }
    } catch (e) {
      el.querySelector('.rep-page').insertAdjacentHTML('beforeend', '<p style="color:#b42318">Não foi possível montar o relatório: ' + esc(e.message) + '</p>');
      console.error(e);
    } finally { running = false; }
  }

  function analyse(area, A, L) {
    const R = { flags: [], sec: {} }, D = A.D, F = A.F;
    const flag = (lvl, txt) => R.flags.push([lvl, txt]);
    const [lon, lat] = area.center;

    // --- identification
    R.where = A.whereText ? A.whereText(lon, lat) : '';
    R.mun = (() => { const m = (D.munis || []).find(m => (m.r || []).some(r => pip(lon, lat, r))); return m ? m.nome : area.mun || ''; })();
    R.bvKm = distKm(lon, lat, -60.6758, 2.8235);
    R.elev = A.elevAt ? (() => { const v = area.samples.map(p => A.elevAt(p[0], p[1])).filter(x => x != null && isFinite(x)); return v.length ? { min: Math.min(...v), max: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length } : null; })() : null;

    // --- fires seen by satellites since the map's start (Dec 2025), inside the area or within 500 m
    const fires = [];
    const pad = 0.006;
    if (L.anoFires) { // ano: focos do satélite de referência daquele ano (sem potência)
      for (const f of L.anoFires) {
        const inside = inRings(f.lon, f.lat, area.rings);
        if (!inside && Math.min(...area.rings.map(r => ringDistKm(f.lon, f.lat, r))) > 0.5) continue;
        fires.push({ i: -1, inside, t: f.t, frp: null, sat: 'INPE (satélite de referência)', viirs: false });
      }
    } else for (let i = 0; i < F.t.length; i++) {
      const fl = F.lon[i], fa = F.lat[i];
      if (fl < area.box[0] - pad || fl > area.box[2] + pad || fa < area.box[1] - pad || fa > area.box[3] + pad) continue;
      const inside = inRings(fl, fa, area.rings);
      if (!inside && Math.min(...area.rings.map(r => ringDistKm(fl, fa, r))) > 0.5) continue;
      fires.push({ i, inside, t: F.t[i], frp: F.f[i], sat: D.sats[F.s[i]], viirs: !!F.v[i] });
    }
    fires.sort((a, b) => a.t - b.t);
    R.fires = fires;
    if (fires.length) {
      const hrs = fires.map(f => A.loc(f.t).getUTCHours()), night = hrs.filter(h => h >= 19 || h < 6).length;
      R.fireStats = { n: fires.length, inside: fires.filter(f => f.inside).length, first: A.fmtT(fires[0].t), last: A.fmtT(fires[fires.length - 1].t), firstDay: A.dayOf(fires[0].t), lastDay: A.dayOf(fires[fires.length - 1].t),
        frpMax: Math.max(...fires.map(f => f.frp)), frpSum: fires.reduce((a, f) => a + Math.max(0, f.frp), 0), night, sats: [...new Set(fires.map(f => f.sat))],
        days: new Set(fires.map(f => A.dayOf(f.t))).size };
      if (night / fires.length >= 0.3 && fires.length >= 3) flag(2, 'Fogo ativo também à noite (' + nf(night) + ' de ' + nf(fires.length) + ' detecções): queima que segue sem controle depois do dia, típico de incêndio.');
    }
    // official INPE fire events touching the area
    R.inpe = (A.IN && A.IN.ev || []).filter(e => (!L.ano || String(e.d0).slice(0, 4) === String(L.ano))).filter(e => e.r && e.r.some(rr => { const b = boxOf([rr]); return boxHit(b, area.box) && (area.samples.some(p => pip(p[0], p[1], rr)) || inRings(e.c[0], e.c[1], area.rings)); }))
      .map(e => ({ tipo: e.tipo, d0: e.d0, d1: e.d1, ha: e.ha, id: e.id, desm: e.desm, veg: e.veg }));
    R.inpe.forEach(e => { if (/inc[eê]ndio/i.test(e.tipo)) flag(2, 'O INPE classificou um evento de fogo nesta área como incêndio (' + br(e.d0) + ' a ' + br(e.d1) + ').'); });

    // --- recurrence 2003–2025
    if (L.REC) {
      const G = L.REC.g, [ox, oy] = L.REC.origin, set = new Set(), cells = new Map(L.REC.itens.map(c => [c[0] + ',' + c[1], c[2]]));
      area.samples.forEach(p => set.add(Math.round((p[0] - ox) / G) + ',' + Math.round((p[1] - oy) / G)));
      let bits = 0; set.forEach(k => { bits |= cells.get(k) || 0; });
      const years = L.REC.anos.filter(y => bits & (1 << (y - L.REC.ano0)));
      R.rec = { years, total: L.REC.anos.length, from: L.REC.anos[0], to: L.REC.anos[L.REC.anos.length - 1], cells: [...set] };
      if (years.length >= 8) flag(2, 'Fogo recorrente: o local teve foco de calor em ' + years.length + ' dos ' + L.REC.anos.length + ' anos entre ' + R.rec.from + ' e ' + R.rec.to + '. Fogo que volta em muitos anos costuma indicar uso do fogo para manejo de pasto ou roça.');
      else if (years.length >= 4) flag(1, 'O local teve foco de calor em ' + years.length + ' dos ' + L.REC.anos.length + ' anos entre ' + R.rec.from + ' e ' + R.rec.to + '.');
    }

    // --- vegetation now (MODIS 2023 map of the site) and history
    const lcCnt = new Array(8).fill(0); if (A.lcAt) area.samples.forEach(p => lcCnt[A.lcAt(p[0], p[1])]++);
    R.lcNow = lcCnt.map((c, k) => [k, c / area.samples.length]).filter(x => x[1] > 0.04).sort((a, b) => b[1] - a[1]);
    R.lcHist = L.lc;
    const nat = (R.lcNow.find(x => x[0] === 0) || [0, 0])[1] + (R.lcNow.find(x => x[0] === 1) || [0, 0])[1] + (R.lcNow.find(x => x[0] === 4) || [0, 0])[1];
    R.native = nat;
    if (L.lc && L.lc.length > 3) {
      const first = L.lc[0], last = L.lc[L.lc.length - 1];
      if (first.cls === 0 && last.cls !== 0) flag(2, 'Mudança de uso da terra: era ' + LC_NAMES[0].toLowerCase() + ' em ' + first.y + ' e aparece como ' + LC_NAMES[last.cls].toLowerCase() + ' em ' + last.y + ' (MODIS, 500 m).');
    }

    // --- deforestation before the fire (PRODES yearly, DETER alerts)
    const PRD = A.PRD && A.PRD.list || [];
    R.prodes = PRD.filter(p => boxHit(p.box, area.box)).map(p => ({ y: p.y, sh: share(area, (lo, la) => p.r.some(r => pip(lo, la, r))) })).filter(x => x.sh > 0.01).sort((a, b) => a.y - b.y);
    const detAll = (A.DET || []).concat(A.QM || []);
    R.deter = detAll.filter(d => { const b = d.box || boxOf(d.r); return boxHit(b, area.box); }).map(d => ({ d: d.d, cls: d.cls, ha: d.km2 * 100, sh: share(area, (lo, la) => d.r.some(r => pip(lo, la, r))) }))
      .filter(x => x.sh > 0.01).sort((a, b) => a.d < b.d ? -1 : 1);
    const desmBefore = R.deter.filter(x => /^DESMATAMENTO|^CS_|MINERACAO/.test(x.cls) && x.d <= (area.date1 || area.date));
    R.desmAny = isDesm(area) || desmBefore.length > 0 || R.prodes.length > 0;
    if (!isDesm(area) && (desmBefore.length || R.prodes.length)) flag(3, 'Desmatamento registrado no mesmo lugar antes do fogo ' + (desmBefore.length ? '(DETER, ' + br(desmBefore[0].d) + ')' : '(PRODES ' + R.prodes.map(p => p.y).join(', ') + ')') + '. Queimar área recém-desmatada é a etapa típica de "limpeza" depois da derrubada e exige autorização.');
    const fireAfter = isDesm(area) ? fires.find(f => A.dayOf(f.t) >= area.date) : null;
    if (fireAfter) flag(3, 'Fogo depois do desmatamento: satélites viram focos de calor na área a partir de ' + br(A.dayOf(fireAfter.t)) + '. É a sequência típica de derrubada seguida de queima.');

    // --- land tenure and protected areas
    const CT = A.CT && A.CT.list || [];
    R.car = CT.filter(c => boxHit(c.box, area.box)).map(c => ({ c, sh: share(area, (lo, la) => c.r.some(r => pip(lo, la, r))) })).filter(x => x.sh > 0.005)
      .sort((a, b) => b.sh - a.sh).slice(0, 8).map(x => ({ cod: x.c.cod, tipo: x.c.tipo, area: x.c.area, cond: x.c.cond, mun: x.c.mun, sh: x.sh, haIn: x.sh * area.haCalc }));
    R.carNone = !R.car.length && A.CT && A.CT.ok;
    const carSum = R.car.reduce((a, c) => a + c.sh, 0);
    if (R.car.length > 1 && carSum > 1.1) flag(2, 'Cadastros sobrepostos: ' + R.car.length + ' imóveis do CAR declaram a mesma área (juntos somam ' + nf(carSum * 100, 0) + '% dela). Sobreposição de CAR pode indicar conflito de posse ou cadastro irregular.');
    R.car.forEach(c => { if (/cancel|suspens/i.test(c.cond || '')) flag(2, 'Imóvel ' + c.cod + ' tem o CAR com situação "' + c.cond + '".'); });
    // vegetation removal permits for those CAR codes (SINAFLOR)
    R.asv = [];
    if (L.ASV) {
      const codes = new Set(R.car.map(c => (c.cod || '').replace(/[^0-9A-Z]/gi, '').toUpperCase()));
      L.ASV.itens.forEach(a => { const k = (a[4] || '').replace(/[^0-9A-Z]/gi, '').toUpperCase(); const near = a[9] ? distKm(lon, lat, a[9][0], a[9][1]) : null;
        if (k && codes.has(k)) R.asv.push({ num: a[0], em: a[1], val: a[2], car: a[4], fin: a[5], ha: a[6], sit: a[7], org: a[8], km: near, sameCar: k && codes.has(k) }); });
      const ref = area.date1 || area.date;
      R.asvValid = R.asv.filter(a => a.sameCar && a.em && a.val && a.em <= ref && a.val >= area.date);
      if (R.desmAny && R.car.length && !R.asvValid.length) flag(3, 'Não há autorização de supressão de vegetação (SINAFLOR/IBAMA) registrada para ' + (R.car.length > 1 ? 'os imóveis do CAR atingidos' : 'o imóvel do CAR atingido') + ' no período. Autorizações emitidas só no sistema estadual podem não aparecer nessa base: confirmar com a FEMARH.');
      if (R.asvValid.length) flag(1, 'Há autorização de supressão de vegetação válida no período para o imóvel (nº ' + R.asvValid.map(a => a.num).join(', ') + '). Conferir se a área autorizada corresponde a esta.');
    }
    // public forests (CNFP)
    R.fp = overlaps(area, L.FP, 3).map(o => ({ nome: o.it.a[0], cat: o.it.a[1], prot: o.it.a[2], tipo: o.it.a[3], gov: o.it.a[4], orgao: o.it.a[6], sh: o.share, km: o.km }));
    const fpFree = R.fp.filter(f => f.sh > 0.02 && (/SEM DESTINA/i.test(f.prot) || /GLEBA/i.test(f.cat)));
    if (fpFree.length) flag(3, 'A área está em terra pública não destinada: ' + fpFree.map(f => (f.nome || f.cat) + ' (' + f.gov.toLowerCase() + ', ' + nf(f.sh * 100, 0) + '% da área)').join('; ') + '. Desmatar ou queimar terra pública não destinada é um dos principais sinais de grilagem.');
    // conservation units
    R.uc = overlaps(area, L.UC, 10).map(o => ({ nome: o.it.a[0], cat: o.it.a[1], grupo: o.it.a[2], esfera: o.it.a[3], ano: o.it.a[4], gestor: o.it.a[6], sh: o.share, km: o.km }));
    R.uc.forEach(u => { if (u.sh > 0.01) flag(/integral/i.test(u.grupo) ? 3 : 2, 'A área está dentro da Unidade de Conservação ' + u.nome + ' (' + u.cat + ', ' + u.grupo.toLowerCase() + ').'); else if (u.km <= 3) flag(1, 'A área fica a ' + kmTxt(u.km) + ' da Unidade de Conservação ' + u.nome + '.'); });
    // indigenous lands (FUNAI, already in the map)
    R.ti = (D.tis || []).map(t => { const b = t.box || boxOf(t.r); return { t, b }; }).filter(x => boxHit([area.box[0] - .1, area.box[1] - .1, area.box[2] + .1, area.box[3] + .1], x.b))
      .map(x => { const sh = share(area, (lo, la) => x.t.r.some(r => pip(lo, la, r))); return { nome: x.t.nome, etnia: x.t.etnia, fase: x.t.fase, sh, km: sh > 0 ? 0 : polyDistKm(area, x.t.r, x.b) }; })
      .filter(x => x.sh > 0 || x.km <= 10).sort((a, b) => a.km - b.km);
    R.ti.forEach(t => { if (t.sh > 0.01) flag(2, 'A área está na Terra Indígena ' + t.nome + '. O uso tradicional do fogo pelos indígenas é permitido; se o fogo foi causado por terceiros, a multa é em dobro (art. 60 do Decreto 6.514/2008).'); });
    // IBAMA embargoes
    R.emb = [];
    if (L.EMB) {
      for (const it of L.EMB.items) {
        const a = it.a; let sh = 0, km = null;
        if (it.rings.length) { if (boxHit([area.box[0] - .05, area.box[1] - .05, area.box[2] + .05, area.box[3] + .05], it.box)) { sh = boxHit(area.box, it.box) ? share(area, (lo, la) => inRings(lo, la, it.rings)) : 0; km = sh > 0 ? 0 : polyDistKm(area, it.rings, it.box); } }
        else if (a[10]) km = inRings(a[10][0], a[10][1], area.rings) ? 0 : Math.min(...area.edge.map(p => distKm(p[0], p[1], a[10][0], a[10][1])));
        if (km != null && km <= 5) R.emb.push({ termo: a[0], data: a[1], mun: a[2], ha: a[3], tipo: a[4], sit: a[5], des: a[6], orig: a[7], auto: a[8], sh, km, poly: it.rings.length > 0 });
      }
      R.emb.sort((x, y) => x.km - y.km);
      const onTop = R.emb.filter(e => e.km === 0 && e.sit === 'ativo');
      if (onTop.length) flag(3, 'Há embargo ativo do IBAMA sobre esta área (termo ' + onTop.map(e => e.termo).join(', ') + '). Queimar ou usar área embargada é nova infração (art. 79 do Decreto 6.514/2008).');
      else if (R.emb.length) flag(1, nf(R.emb.length) + (R.emb.length === 1 ? ' embargo' : ' embargos') + ' do IBAMA a até 5 km da área.');
    }

    // --- physical setting
    const pickClass = Lx => { if (!Lx) return []; const cnt = new Map(); area.samples.forEach(p => { const it = Lx.items.find(x => boxHit([p[0], p[1], p[0], p[1]], x.box) && inRings(p[0], p[1], x.rings)); if (it) { const k = it.a[0]; cnt.set(k, (cnt.get(k) || 0) + 1); } });
      return [...cnt].map(([k, c]) => { const it = Lx.items.find(x => x.a[0] === k); return { name: k, a: it.a, sh: c / area.samples.length }; }).sort((a, b) => b.sh - a.sh).slice(0, 3); };
    R.solo = pickClass(L.SOL); R.geo = pickClass(L.GEO);
    // rivers and permanent preservation areas (APP): at least 30 m along any river (Código Florestal, art. 4º); wider rivers need more
    R.river = null; R.appSh = 0;
    if (A.RV && A.RV.ok) {
      let best = null;
      const segs = A.RV.psegs, grid = A.RV.pgrid, G = A.RV.G;
      const near = (lo, la, tol) => { let bd = null; const gr = Math.ceil(tol / (G * 110)) , gx0 = Math.floor(lo / G), gy0 = Math.floor(la / G);
        for (let gx = gx0 - gr; gx <= gx0 + gr; gx++) for (let gy = gy0 - gr; gy <= gy0 + gr; gy++) { const l = grid.get(gx * 10000 + gy); if (!l) continue; for (const s of l) { const g = segs[s], d = segDistKm(lo, la, g[0], g[1]); if (d <= tol && (!bd || d < bd.d)) bd = { d, n: g[2] }; } }
        return bd; };
      area.edge.concat([area.center]).forEach(p => { const r = near(p[0], p[1], 10); if (r && (!best || r.d < best.d)) best = r; });
      if (best) R.river = { km: area.samples.some(p => { const r = near(p[0], p[1], 0.03); return !!r; }) ? 0 : best.d, name: best.n >= 0 ? A.RV.names[best.n] : '' };
      R.appSh = share(area, (lo, la) => !!near(lo, la, 0.03));
      if (R.appSh > 0.005) flag(2, 'Cerca de ' + haTxt(R.appSh * area.haCalc) + ' da área ficam a menos de 30 m de um rio: faixa mínima de Área de Preservação Permanente (APP). Pode ser maior em rios largos.');
    }

    // --- people
    R.pop = null;
    if (L.POP) {
      const rings = [5, 10, 20].map(km => ({ km, p: 0, d: 0 }));
      L.POP.itens.forEach(c => { if (Math.abs(c[0] - lon) > 0.25 || Math.abs(c[1] - lat) > 0.25) return; const d = Math.min(distKm(lon, lat, c[0], c[1]), ...area.edge.slice(0, 40).map(p => distKm(p[0], p[1], c[0], c[1])));
        rings.forEach(r => { if (d <= r.km) { r.p += c[2]; r.d += c[3]; } }); });
      R.pop = rings;
      if (rings[0].p >= 1000) flag(2, 'Cerca de ' + nf(rings[0].p) + ' pessoas moram a até 5 km da área (Censo 2022): risco de fumaça para a saúde e de o fogo chegar a casas.');
    }
    R.health = L.SAU ? L.SAU.itens.map(s => ({ nome: s[0], tipo: s[1], km: distKm(lon, lat, s[2], s[3]), hosp: s[4] })).sort((a, b) => a.km - b.km).slice(0, 4) : [];
    R.places = (A.RD && A.RD.places || []).filter(p => p.kind >= 2 && p.kind !== 5).map(p => ({ name: p.name, km: distKm(lon, lat, p.lon, p.lat), dir: (Math.atan2((p.lon - lon) * Math.cos(lat * Math.PI / 180), p.lat - lat) * 180 / Math.PI + 360) % 360 })).sort((a, b) => a.km - b.km).slice(0, 5);
    if (L.wx && !L.wx.err && L.wx.at && L.wx.at.dir != null) {
      const to = (L.wx.at.dir + 180) % 360; // wind comes FROM dir; smoke goes TO dir+180
      R.smoke = { to, towns: (A.RD && A.RD.places || []).filter(p => p.kind >= 2 && p.kind !== 5).map(p => ({ name: p.name, km: distKm(lon, lat, p.lon, p.lat), dir: (Math.atan2((p.lon - lon) * Math.cos(lat * Math.PI / 180), p.lat - lat) * 180 / Math.PI + 360) % 360 }))
        .filter(p => p.km <= 40 && Math.abs(((p.dir - to + 540) % 360) - 180) <= 30).sort((a, b) => a.km - b.km).slice(0, 4) };
    }

    // --- emissions (order of magnitude): fuel burned per hectare × emission factor, IPCC 2006 vol. 4 tables 2.4 and 2.5
    const ha = area.ha || area.haCalc;
    const fuel = { 0: 100, 1: 6, 2: 5, 3: 5, 4: 6 }; // t of dry matter burned per ha (rounded IPCC reference values)
    let co2 = 0; R.lcNow.forEach(([k, s]) => { co2 += ha * s * (fuel[k] || 0) * (k === 0 ? 1.58 : 1.61); });
    R.co2 = co2;

    // --- legal framework (educational)
    const nativeShare = R.native, rateNative = 10000, rateFarm = 3000;
    R.fine = { haBase: Math.ceil((R.sevHa != null ? R.sevHa : ha)), native: nativeShare, low: Math.ceil(ha) * rateFarm, high: Math.ceil(ha) * rateNative, ti: R.ti.some(t => t.sh > 0.01) };

    // --- images and severity
    R.img = L.img; R.wx = L.wx; R.ph = L.ph;
    if (L.img && L.img.sev) {
      const s = L.img.sev;
      R.burned = s.burnedHa;
      if (s.cover >= 0.5 && s.mean != null && s.mean >= 0.2) flag(1, isDesm(area) ? 'As imagens confirmam a perda de vegetação entre ' + br(L.img.pre.date) + ' e ' + br(L.img.post.date) + ' (dNBR médio ' + nf(s.mean, 2) + ').' : 'As imagens mostram queima de gravidade ' + (s.mean >= 0.44 ? 'moderada a alta' : 'moderada') + ' (dNBR médio ' + nf(s.mean, 2) + ').');
    }
    if (nativeShare >= 0.5) flag(1, 'A maior parte da área era vegetação nativa (' + nf(nativeShare * 100, 0) + '%, MODIS): qualquer queima ali exige autorização.');
    R.flags.sort((a, b) => b[0] - a[0]);
    return R;
  }

  // ---------- writing
  function render(el, area, R) {
    const A = window.FRR, now = new Date();
    const gen = now.toLocaleDateString('pt-BR') + ' às ' + now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const code = 'FRR-' + (area.kind || 'A').slice(0, 2).toUpperCase() + '-' + (area.date || '').replace(/-/g, '') + '-' + Math.abs(Math.round(area.center[0] * 1e4 * 31 + area.center[1] * 1e4)).toString(36).toUpperCase().slice(-5);
    const [lon, lat] = area.center, ha = area.ha || area.haCalc;
    const T = (rows) => '<table>' + rows.filter(Boolean).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>').join('') + '</table>';
    const H2 = (n, t) => '<h2><span class="ar-n">' + n + '</span>' + esc(t) + '</h2>';
    const note = t => '<p class="ar-note">' + t + '</p>';
    const strong = R.flags.filter(f => f[0] === 3).length, mid = R.flags.filter(f => f[0] === 2).length;
    const verdict = strong ? ['alto', 'Pede verificação prioritária', strong + (strong === 1 ? ' indício forte' : ' indícios fortes') + (mid ? ' e ' + mid + ' de atenção' : '')]
      : mid ? ['medio', 'Pede atenção', mid + (mid === 1 ? ' ponto de atenção' : ' pontos de atenção')] : ['info', 'Sem indícios fortes nos dados', 'nenhum cruzamento de dados aponta irregularidade'];
    let h = '';
    h += '<div class="rep-actions"><button class="btn" data-a="print">🖨 Imprimir ou salvar em PDF</button><button class="btn" data-a="kml">Baixar contorno (KML)</button><button class="btn" data-a="geojson">GeoJSON</button><button class="btn" data-a="copy">Copiar resumo</button><button class="btn" data-a="close">Fechar</button></div>';
    h += '<p class="rep-kick">Fogo em Roraima 3D · ' + (area.ano ? 'relatório técnico do ano ' + area.ano : 'relatório técnico da área') + '</p><h1>' + esc(area.title) + (R.mun ? ' · ' + esc(R.mun) : '') + '</h1>';
    h += '<p class="rep-sub">Relatório nº <b>' + esc(code) + '</b> · gerado em ' + esc(gen) + ' (horário de Roraima) · fogororaima.com.br<br>Fonte da área: ' + esc(area.source) + ' · data de referência <b>' + br(area.date) + '</b>' + (area.date1 && area.date1 !== area.date ? ' a <b>' + br(area.date1) + '</b>' : '') + '</p>';
    const main = R.img && (R.img.figs.post || R.img.figs.now || R.img.figs.pre);
    if (main) h += '<img class="ar-hero" src="' + main + '" alt="Imagem de satélite da área com o contorno em amarelo">';

    // 1. summary
    h += H2(1, 'Resumo');
    h += '<div class="ar-verdict ar-' + verdict[0] + '"><b>' + esc(verdict[1]) + '</b><span>' + esc(verdict[2]) + '</span></div>';
    const sumTxt = [];
    const clsTxt = area.cls && area.cls.toLowerCase() !== area.title.toLowerCase() ? area.cls : '';
    sumTxt.push('Área de ' + haTxt(ha) + ' (' + esc(area.title.toLowerCase()) + (clsTxt ? ', ' + esc(clsTxt) : '') + ') ' + (R.mun ? 'em ' + esc(R.mun) : 'em Roraima') + (area.ano ? ', contorno de ' + esc(area.source) + ', com focos de ' + area.ano + ' neste local.' : ', registrada por ' + esc(area.source) + ' em ' + br(area.date) + '.'));
    if (R.burned != null && R.img.sev.cover >= 0.5) sumTxt.push('As imagens Sentinel-2 de ' + br(R.img.pre.date) + ' e ' + br(R.img.post.date) + ' mostram ' + (isDesm(area) ? 'perda de vegetação' : 'sinal de queima') + ' em cerca de ' + haTxt(R.burned) + ' dentro do contorno.');
    if (R.fireStats) sumTxt.push(area.ano ? 'O satélite de referência do INPE registrou ' + nf(R.fireStats.n) + (R.fireStats.n === 1 ? ' foco de calor' : ' focos de calor') + ' em ' + area.ano + ' na área ou a até 500 m, entre ' + esc(R.fireStats.first) + ' e ' + esc(R.fireStats.last) + '.' : 'Satélites detectaram ' + nf(R.fireStats.n) + ' focos de calor na área ou a até 500 m, entre ' + esc(R.fireStats.first) + ' e ' + esc(R.fireStats.last) + '.');
    if (R.rec) sumTxt.push('Historicamente, o local teve fogo em ' + R.rec.years.length + ' dos ' + R.rec.total + ' anos entre ' + R.rec.from + ' e ' + R.rec.to + '.');
    if (R.car.length) sumTxt.push(nf(R.car[0].sh * 100, 0) + '% da área está no imóvel do CAR ' + esc(R.car[0].cod) + (R.car.length > 1 ? ' (e mais ' + (R.car.length - 1) + ')' : '') + '.');
    else if (R.carNone) sumTxt.push('A área não está dentro de nenhum imóvel declarado no CAR.');
    h += '<p>' + sumTxt.join(' ') + '</p>';
    if (R.flags.length) h += '<ul class="ar-flags">' + R.flags.map(([l, t]) => '<li class="ar-' + LEVEL[l][0] + '"><b>' + LEVEL[l][1] + '.</b> ' + esc(t) + '</li>').join('') + '</ul>';
    h += note('Indícios vêm do cruzamento automático de dados públicos de satélite e cadastros. Não são prova nem acusação contra ninguém: só a fiscalização, com vistoria e consulta às autorizações, confirma uma infração.');

    // 2. identification
    h += H2(2, 'Identificação e localização');
    h += T([['Tipo', esc(area.title) + (clsTxt ? ' · ' + esc(clsTxt) : '')], ['Fonte do contorno', esc(area.source)], ['Data de referência', br(area.date) + (area.date1 && area.date1 !== area.date ? ' a ' + br(area.date1) : '')],
      area.ano ? ['Relatório do ano', 'focos e datas de ' + area.ano + ' nos quadrados de ~1 km que tocam esta área; o contorno é o da área atual'] : null,
      ['Área informada pela fonte', area.ha != null ? haTxt(area.ha) : '–'], ['Área medida no contorno', haTxt(area.haCalc)], ['Perímetro', kmTxt(area.perim)],
      ['Centro (graus decimais)', nf(lat, 5) + ', ' + nf(lon, 5)], ['Centro (graus, min, seg)', gms(lat, 'N', 'S') + ' · ' + gms(lon, 'L', 'O')],
      ['Município', esc(R.mun || '–')], R.where ? ['Referência', esc(R.where)] : null, ['Distância de Boa Vista', kmTxt(R.bvKm)],
      R.elev ? ['Altitude', nf(R.elev.min, 0) + ' a ' + nf(R.elev.max, 0) + ' m (média ' + nf(R.elev.mean, 0) + ' m)'] : null,
      area.extra ? ['Detalhes da fonte', esc(area.extra)] : null]);
    h += '<p class="ar-links"><a href="https://www.google.com/maps/@' + lat.toFixed(5) + ',' + lon.toFixed(5) + ',2500m/data=!3m1!1e3" target="_blank" rel="noopener">Abrir no Google Maps (satélite)</a> · <a href="https://browser.dataspace.copernicus.eu/?zoom=14&lat=' + lat.toFixed(5) + '&lng=' + lon.toFixed(5) + '" target="_blank" rel="noopener">Copernicus Browser</a> · <a href="https://plataforma.alerta.mapbiomas.org/" target="_blank" rel="noopener">MapBiomas Alerta</a></p>';

    // 3. images
    h += H2(3, 'Imagens de satélite: antes, depois e hoje');
    const I = R.img;
    if (!I || I.err || !Object.keys(I.figs || {}).length) h += '<p>Não foi possível obter imagens de satélite agora' + (I && I.err ? ' (' + esc(I.err) + ')' : '') + '. Tente gerar o relatório de novo mais tarde.</p>';
    else {
      const fig = (k, cap) => I.figs[k] ? '<figure><img src="' + I.figs[k] + '" alt="' + esc(cap) + '"><figcaption>' + cap + '</figcaption></figure>' : '';
      const fimFogo = area.date1 || area.date;
      // every image shows how many days it is from the start (before/during) or from the end of the fire (after)
      const diasTxt = (sc, lab) => {
        if (!sc) return '';
        if (lab === 'Antes') return ' · ' + Math.abs(dayDiff(sc.date, area.date)) + ' dias antes do início do fogo';
        if (sc.during) return ' · ' + Math.abs(dayDiff(area.date, sc.date)) + ' dias depois do início do fogo';
        return ' · ' + dayDiff(fimFogo, sc.date) + ' dias depois do fim do fogo';
      };
      const capOf = (sc, lab) => sc ? lab + ': ' + br(sc.date) + diasTxt(sc, lab) + ' · ' + nf(sc.clear * 100, 0) + '% da área sem nuvem' : lab;
      // pasture and grassland (lavrado) turn green again in weeks: the reading is reliable only up to 15 days after the fire
      const pasto = (R.lcNow || []).filter(x => x[0] === 1 || x[0] === 2).reduce((a, x) => a + x[1], 0) >= 0.5;
      h += '<div class="ar-grid">' + fig('pre', capOf(I.pre, 'Antes')) + fig('post', capOf(I.post, I.post && I.post.during ? 'Durante o fogo' : 'Depois')) + fig('now', capOf(I.now, 'Hoje')) + fig('sev', (isDesm(area) ? 'Perda de vegetação' : 'Gravidade da queima') + ' (dNBR) dentro do contorno') + '</div>';
      if (I.sev && I.sev.cover < 0.3) {
        h += note('<b>Não foi possível medir a gravidade:</b> ' + nf(I.sev.cover * 100, 0) + '% da área sem nuvem nas duas imagens (mínimo: 30%). Por isso o relatório não mostra as classes de gravidade. Gere o relatório de novo em alguns dias.');
      } else if (I.sev) {
        const s = I.sev;
        h += '<table class="ar-sev"><tr><th>' + (isDesm(area) ? 'Mudança na vegetação (dNBR)' : 'Gravidade da queima (dNBR)') + '</th><th>Área</th><th>% medido</th></tr>' + s.classes.map(c => '<tr><td><i style="background:' + c.color + '"></i>' + esc(isDesm(area) ? (DESM_NAME[c.name] || c.name) : c.name) + '</td><td>' + haTxt(c.ha) + '</td><td>' + nf(c.pct * 100, 0) + '%</td></tr>').join('') + '</table>';
        h += note((isDesm(area) ? 'Em desmatamento, o dNBR mede a troca da floresta por solo exposto ou palha, com ou sem fogo; a queima se confirma pelos focos de calor e pela cor escura na imagem do depois. ' : '') + 'dNBR médio na área: <b>' + nf(s.mean, 2) + '</b>. Medido em ' + nf(s.cover * 100, 0) + '% dos pixels da área (o resto estava sob nuvem, sombra ou sem dado). Classes de Key e Benson (USGS FIREMON). Em lavrado e pasto a queima rebrota em semanas, então imagens distantes da data mostram gravidade menor que a real.');
      } else if (I.pre && !I.post) h += note('Não há imagem sem nuvem depois da data para medir a gravidade.');
      if (I.ls && I.pre && I.post) h += note('Antes de 2017 o Sentinel-2 não cobre esta área de forma contínua, então as imagens são Landsat (30 m). A gravidade (dNBR) não é medida nestas imagens: compare-as visualmente.');
      if (I.post && !I.post.during && pasto && I.sev && I.sev.cover >= 0.3) {
        const dias = dayDiff(fimFogo, I.post.date);
        h += note(dias > 15
          ? '<b>Gravidade subestimada pela rebrota:</b> a imagem de depois é de ' + dias + ' dias após o fim do fogo. Em lavrado e pasto o capim volta a crescer em semanas, então a queimada aparece menor do que foi.'
          : 'Leitura confiável para lavrado e pasto: a imagem de depois é de ' + dias + ' dias após o fim do fogo (até 15 dias).');
      }
      if (I.post && I.post.during) h += note('<b>Ainda não há imagem limpa depois do fim do fogo.</b> A segunda imagem é a de menos nuvem sobre a área desde o início do incêndio (' + br(I.post.date) + '), mesmo com nuvem ou fumaça. A gravidade medida com ela pode estar <b>subestimada</b>: gere o relatório de novo em alguns dias para ter a imagem do depois.');
      h += note((I.ls ? 'Landsat (30 m), USGS, via Microsoft Planetary Computer.' : 'Sentinel-2 nível 2A (10 m), Copernicus/ESA, via Microsoft Planetary Computer.') + (I.hls ? ' Imagens de reserva: NASA HLS (30 m), via GIBS.' : '') + ' Contorno da área em amarelo; partes listradas em cinza ficaram fora da passagem do satélite (sem dado). Imagens escolhidas pela menor cobertura de nuvem sobre a própria área.');
    }

    // 4. fire history
    h += H2(4, 'Histórico do fogo no local');
    if (R.fireStats) {
      const f = R.fireStats;
      const inPer = R.fires.filter(x => { const d = A.dayOf(x.t); return d >= addDays(area.date, -3) && d <= addDays(area.date1 || area.date, 3); }).length;
      h += T([[area.ano ? 'Focos de calor de ' + area.ano + ' (satélite de referência, na área ou a até 500 m)' : 'Focos de calor desde dez/2025 (na área ou a até 500 m)', nf(f.n) + ' (' + nf(f.inside) + ' dentro do contorno)'], ['No período da área (' + br(addDays(area.date, -3)) + ' a ' + br(addDays(area.date1 || area.date, 3)) + ')', nf(inPer)], ['Primeiro e último', esc(f.first) + ' · ' + esc(f.last)], ['Dias com fogo', nf(f.days)],
        ['Detecções à noite (19h às 6h)', nf(f.night)], (area.ano ? null : ['Maior potência (FRP)', nf(f.frpMax, 1) + ' MW']), ['Satélites', esc(f.sats.join(', '))]]);
    } else h += '<p>Nenhum foco de calor registrado na área desde dezembro de 2025 (início dos dados do mapa).</p>';
    if (R.inpe.length) h += '<p><b>Eventos de fogo do INPE na área:</b></p>' + T(R.inpe.map(e => [e.tipo + ' · nº ' + e.id, br(e.d0) + ' a ' + br(e.d1) + ' · ' + haTxt(e.ha) + (e.desm != null ? ' · ' + nf(e.desm, 0) + '% em área desmatada' : '')]));
    if (R.rec) {
      h += '<p><b>Anos com fogo no local, ' + R.rec.from + '–' + R.rec.to + '</b> (satélite de referência do INPE, quadrados de ~1 km):</p><div class="ar-years">' +
        Array.from({ length: R.rec.to - R.rec.from + 1 }, (_, k) => R.rec.from + k).map(y => R.rec.years.includes(y) ? '<button type="button" class="on" data-ano="' + y + '" title="Abrir o relatório de ' + y + '">' + String(y).slice(2) + '</button>' : '<span title="' + y + '">' + String(y).slice(2) + '</span>').join('') + '</div>' +
        note('Teve fogo em <b>' + R.rec.years.length + '</b> de ' + R.rec.total + ' anos. O satélite de referência passa uma vez por tarde e não vê todo fogo: é um índice de recorrência, não a contagem completa.');
    }

    // 5. vegetation and land use
    h += H2(5, 'Vegetação e uso da terra');
    if (R.lcNow.length) h += T(R.lcNow.map(([k, s]) => ['Hoje (MODIS 2023) · ' + LC_NAMES[k], nf(s * 100, 0) + '%']));
    if (R.lcHist && R.lcHist.length) {
      const groups = []; R.lcHist.forEach(x => { const g = groups[groups.length - 1]; if (g && g.cls === x.cls) g.to = x.y; else groups.push({ cls: x.cls, from: x.y, to: x.y }); });
      h += '<p><b>Trajetória 2001–2023</b> (classe dominante na área, MODIS 500 m): ' + groups.map(g => esc(LC_NAMES[g.cls]) + ' (' + (g.from === g.to ? g.from : g.from + '–' + g.to) + ')').join(' → ') + '</p>';
    }
    if (R.prodes.length) h += '<p><b>Desmatamento medido (PRODES):</b> ' + R.prodes.map(p => 'ano ' + p.y + ' (' + nf(p.sh * 100, 0) + '% da área)').join(', ') + '.</p>';
    if (R.deter.length) h += '<p><b>Alertas DETER na área:</b></p>' + T(R.deter.slice(0, 8).map(d => [br(d.d) + ' · ' + (A.DET_CLS[d.cls] || d.cls.replace(/_/g, ' ').toLowerCase()), haTxt(d.ha) + ' · ' + nf(d.sh * 100, 0) + '% desta área']));
    if (!R.prodes.length && !R.deter.length) h += '<p>Nenhum desmatamento PRODES (últimos 3 anos) ou alerta DETER (desde dez/2024) sobre a área.</p>';
    h += '<p><b>' + (isDesm(area) ? 'Emissão se a vegetação derrubada for queimada' : 'Emissão estimada da queima') + ':</b> cerca de <b>' + nf(R.co2, 0) + ' t de CO₂</b>.</p>' + note('Ordem de grandeza: área × combustível queimado por hectare × fator de emissão (valores de referência do IPCC 2006, vol. 4, tabelas 2.4 e 2.5). Floresta ~100 t de matéria seca por ha; lavrado e pasto ~5–6 t/ha. Incerteza alta.');

    // 6. land tenure
    h += H2(6, 'Situação fundiária e áreas protegidas');
    if (R.car.length) h += '<p><b>Imóveis do CAR atingidos</b> (dados públicos do SICAR, sem nome do dono):</p>' + T(R.car.map(c => [esc(c.cod), esc(A.CAR_TIPO[c.tipo] || c.tipo || '') + ' · ' + nf(c.area, 0) + ' ha declarados · ' + esc(c.cond || 'situação não informada') + ' · <b>' + haTxt(c.haIn) + ' desta área (' + nf(c.sh * 100, 0) + '%)</b>']));
    else h += '<p>' + (R.carNone ? 'Nenhum imóvel do CAR sobre a área.' : 'Não foi possível consultar o CAR agora.') + '</p>';
    const sitFogo = a => a.val < area.date ? 'vencida antes do fogo' : a.em > (area.date1 || area.date) ? 'emitida depois do fogo' : 'vigente na data do fogo';
    if (R.asv.length) h += '<p><b>Autorizações de supressão de vegetação (SINAFLOR) do imóvel do CAR:</b></p>' + T(R.asv.slice(0, 6).map(a => ['Nº ' + esc(a.num), 'emitida ' + br(a.em) + ', válida até ' + br(a.val) + ' · <b>' + sitFogo(a) + '</b> · ' + esc(a.fin) + (a.ha ? ' · ' + nf(a.ha, 1) + ' ha' : '') + ' · ' + esc(a.sit)])) + '<p class="ar-note">O SINAFLOR registra autorização para retirar vegetação (supressão), não para queimar: a autorização de queima é da FEMARH. Esta base pode não trazer todas as autorizações estaduais.</p>';
    else h += '<p>Nenhuma autorização de supressão de vegetação (SINAFLOR/IBAMA) registrada para o imóvel do CAR.</p>';
    if (R.fp.length) h += '<p><b>Florestas públicas (CNFP 2025):</b></p>' + T(R.fp.slice(0, 5).map(f => [esc(f.nome || f.cat), esc(f.cat) + ' · ' + esc(f.gov.toLowerCase()) + ' · ' + esc(f.prot.toLowerCase().replace('sustentavel', 'sustentável').replace('destinacao', 'destinação')) + ' · ' + (f.sh > 0 ? '<b>' + nf(f.sh * 100, 0) + '% da área</b>' : 'a ' + kmTxt(f.km))]));
    else h += '<p>A área não está em floresta pública cadastrada (CNFP 2025).</p>';
    h += T([['Unidades de Conservação', R.uc.length ? R.uc.slice(0, 3).map(u => esc(u.nome) + ' (' + esc(u.cat) + ', ' + esc(u.grupo.toLowerCase()) + ') · ' + (u.sh > 0 ? '<b>' + nf(u.sh * 100, 0) + '% da área</b>' : 'a ' + kmTxt(u.km))).join('<br>') : 'nenhuma a até 10 km'],
      ['Terras Indígenas', R.ti.length ? R.ti.slice(0, 3).map(t => 'TI ' + esc(t.nome) + (t.etnia ? ' (' + esc(t.etnia) + ')' : '') + ' · ' + (t.sh > 0 ? '<b>' + nf(t.sh * 100, 0) + '% da área</b>' : 'a ' + kmTxt(t.km))).join('<br>') : 'nenhuma a até 10 km']]);
    if (R.emb.length) h += '<p><b>Embargos do IBAMA a até 5 km</b> (sem nomes):</p>' + T(R.emb.slice(0, 8).map(e => ['Termo ' + esc(e.termo) + ' · ' + br(e.data), (e.ha ? nf(e.ha, 1) + ' ha · ' : '') + esc(e.sit) + (e.des ? ' em ' + br(e.des) : '') + ' · ' + (e.km === 0 ? '<b>sobre a área</b>' : 'a ' + kmTxt(e.km)) + (e.poly ? '' : ' (só o ponto)')]));
    else h += '<p>Nenhum embargo do IBAMA a até 5 km.</p>';

    // 7. physical setting
    h += H2(7, 'Meio físico');
    h += T([['Solo (IBGE 1:250.000)', R.solo.length ? R.solo.map(s => esc(s.name) + ' (' + nf(s.sh * 100, 0) + '%)').join('<br>') : '–'],
      ['Geologia (IBGE)', R.geo.length ? R.geo.map(s => esc(s.name) + (s.a[2] && s.a[2].split(' ').length > 2 && !s.a[2].includes(s.name) ? ' · ' + esc(s.a[2].split(' ').slice(-2).join(' ')) : '') + ' (' + nf(s.sh * 100, 0) + '%)').join('<br>') : '–'],
      ['Rio mais próximo', R.river ? (R.river.name ? esc(R.river.name) + ' · ' : '') + (R.river.km === 0 ? 'cruza a área' : 'a ' + kmTxt(R.river.km)) : 'nenhum mapeado a até 10 km'],
      ['Faixa de APP (30 m de rios) dentro da área', R.appSh > 0 ? '<b>≈ ' + haTxt(R.appSh * area.haCalc) + '</b>' : 'nenhuma detectada']]);
    h += note('A largura da APP depende da largura do rio (30 m a 500 m, Código Florestal art. 4º); aqui usa-se o mínimo de 30 m sobre os rios do mapa (OpenStreetMap). Nascentes e veredas não estão mapeadas.');

    // 8. weather
    h += H2(8, 'Clima e fumaça no período');
    const X = R.wx;
    if (X && !X.err) {
      h += T([['Chuva nos 30 dias antes', nf(X.rain30, 0) + ' mm'], ['Dias seguidos sem chuva (≥ 5 mm) antes da data', nf(X.dry)],
        X.at ? ['No dia ' + br(X.at.t), 'máx. ' + nf(X.at.tmax, 0) + ' °C · umidade mín. ' + nf(X.at.rh, 0) + '% · vento até ' + nf(X.at.wind, 0) + ' km/h vindo do ' + dirName(X.at.dir)] : null,
        X.air ? ['Pior dia de fumaça (PM2,5, média do dia)', nf(X.air.pm, 0) + ' µg/m³ em ' + br(X.air.day) + (X.air.pm > 15 ? ' · <b>acima do limite diário da OMS (15)</b>' : '')] : null,
        !X.air && area.ano ? ['Qualidade do ar (PM2,5)', 'sem dados deste período no modelo usado (começa em 2013)'] : null,
        R.smoke ? ['Fumaça seguiu para', dirName(R.smoke.to) + (R.smoke.towns.length ? ' · em direção a ' + R.smoke.towns.map(t => esc(t.name) + ' (' + kmTxt(t.km) + ')').join(', ') : '')] : null]);
      h += '<div class="ar-rain">' + X.days.filter(d => d.t <= (area.date1 || area.date)).slice(-30).map(d => '<span title="' + br(d.t) + ': ' + nf(d.rain || 0, 1) + ' mm" style="height:' + Math.min(40, 2 + (d.rain || 0) * 1.2) + 'px"></span>').join('') + '</div>';
      h += note('Chuva diária nos 30 dias antes da data (cada barra é um dia). Modelo meteorológico (Open-Meteo), não estação: valores aproximados.');
    } else h += '<p>Dados de tempo indisponíveis agora.</p>';

    // 9. people and services
    h += H2(9, 'Pessoas e serviços por perto');
    h += T([R.pop ? ['Moradores (Censo 2022)', R.pop.map(r => 'até ' + r.km + ' km: <b>' + nf(r.p) + '</b>').join(' · ')] : null,
      ['Vilas e cidades mais próximas', R.places.length ? R.places.slice(0, 4).map(p => esc(p.name) + ' (' + kmTxt(p.km) + ' a ' + dirName(p.dir) + ')').join('<br>') : '–'],
      ['Unidades de saúde mais próximas', R.health.length ? R.health.map(s => esc(s.nome) + ' · ' + esc(s.tipo) + ' · ' + kmTxt(s.km) + ' em linha reta').join('<br>') : '–']]);

    // 10. law
    h += H2(10, 'O que a lei prevê (educativo)');
    h += '<ul class="ar-law"><li><b>Código Florestal (Lei 12.651/2012), art. 38:</b> o uso de fogo na vegetação é proibido, salvo queima controlada autorizada pelo órgão ambiental (em Roraima, FEMARH) e uso tradicional por povos indígenas e comunidades.</li>' +
      '<li><b>Decreto 6.514/2008, art. 58:</b> fogo em área agropastoril sem autorização: <b>R$ 3.000 por hectare</b> ou fração. <b>Art. 58-A:</b> incêndio em floresta ou vegetação nativa: <b>R$ 10.000 por hectare</b>. <b>Art. 60:</b> multa em dobro se atingir Terra Indígena ou Unidade de Conservação.</li>' +
      '<li><b>Lei 9.605/1998, art. 41:</b> provocar incêndio em mata ou floresta é crime (reclusão de 2 a 4 anos e multa).</li>' +
      '<li><b>Lei 14.944/2024:</b> Política Nacional de Manejo Integrado do Fogo (queima prescrita, controlada e uso tradicional).</li></ul>';
    const hb = Math.ceil(ha), mult = R.fine.ti ? 2 : 1;
    if (isDesm(area)) h += '<ul class="ar-law"><li><b>Decreto 6.514/2008, art. 52:</b> desmatar a corte raso fora da reserva legal sem autorização: <b>R$ 1.000 por hectare</b> ou fração. <b>Art. 51:</b> desmatar dentro da reserva legal: <b>R$ 5.000 por hectare</b>.</li><li><b>Código Florestal, art. 26:</b> a supressão de vegetação nativa depende de o imóvel estar no CAR e de autorização prévia do órgão estadual (em Roraima, FEMARH).</li></ul>' +
      T([['Área considerada', nf(hb) + ' ha'], ['Desmatamento fora da reserva legal (art. 52)', esc(brl(hb * 1000 * mult))], ['Desmatamento em reserva legal (art. 51)', esc(brl(hb * 5000 * mult))], ['Se a área também foi queimada sem autorização (art. 58-A)', esc(brl(hb * 10000 * mult))]]);
    else h += T([['Área considerada', nf(hb) + ' ha (arredondado para cima, como na lei)'], ['Se fosse queima sem autorização em pasto ou roça (art. 58)', esc(brl(hb * 3000 * mult))], ['Se fosse incêndio em vegetação nativa (art. 58-A)', esc(brl(hb * 10000 * mult))], R.fine.ti ? ['Terra Indígena', 'valores já em dobro (art. 60)'] : null]);
    h += note('Simulação para entender a lei. Não é multa aplicada nem parecer jurídico: a autuação depende de identificar quem causou o fogo, de não haver autorização e do processo administrativo, com direito de defesa (em geral 20 dias após a ciência do auto de infração). <b>Multa e embargo são coisas diferentes:</b> a multa é uma sanção em dinheiro; o embargo proíbe usar a área até ela ser regularizada (art. 15-A e 16 do Decreto 6.514/2008).');

    // 11. photos
    if (R.ph && R.ph.length) {
      h += H2(11, 'Fotos de referência perto do local');
      h += '<div class="ar-photowarn"><b>⚠️ Estas fotos não são do evento.</b> Não mostram esta queimada nem este desmatamento, e podem não mostrar nem a própria área. ' +
        'Foram encontradas <b>automaticamente</b> num banco público de imagens (Wikimedia Commons), que busca qualquer foto publicada por terceiros com localização a até 10 km daqui. ' +
        'O sistema não sabe o que cada foto mostra: servem <b>só para conhecer a paisagem da região</b> e podem ter sido tiradas anos antes, em outro ponto, por qualquer pessoa.</div>';
      h += '<div class="ar-photos">' + R.ph.map(p => '<figure><a href="' + esc(p.page) + '" target="_blank" rel="noopener"><img src="' + esc(p.thumb) + '" alt="' + esc(p.title) + '" loading="lazy"></a><figcaption><b>Foto de terceiros, não é do evento</b>' + (p.km != null ? ' · tirada a ' + kmTxt(p.km) + ' do centro da área' : '') + '<br>' + esc(p.title) + '<br>' + esc(p.author) + ' · ' + esc(p.lic) + '</figcaption></figure>').join('') + '</div>';
      h += note('Fonte: Wikimedia Commons, fotos livres enviadas por voluntários. Para ver o local de verdade, use as imagens de satélite da seção 3, que têm data e contorno da área.');
    }

    // 12. sources
    h += H2(R.ph && R.ph.length ? 12 : 11, 'Métodos, fontes e limitações');
    h += '<ul class="ar-src"><li>Contorno: ' + esc(area.source) + '. Área medida no contorno por projeção local.</li>' +
      '<li>Imagens: Copernicus Sentinel-2 L2A (ESA), via Microsoft Planetary Computer; gravidade pelo índice dNBR = NBR(antes) − NBR(depois), NBR = (B8 − B12)/(B8 + B12); nuvens pela classificação de cena (SCL).</li>' +
      '<li>Focos de calor e eventos de fogo: INPE, Programa Queimadas. Recorrência: focos do satélite de referência ' + (R.rec ? R.rec.from + '–' + R.rec.to : '') + '.</li>' +
      '<li>Desmatamento: INPE PRODES e DETER (TerraBrasilis). Vegetação: MODIS MCD12Q1 (IGBP), NASA, via GIBS.</li>' +
      '<li>Imóveis rurais: SICAR (CAR), dados públicos. Autorizações de supressão: IBAMA/SINAFLOR. Embargos: IBAMA, dados abertos (nomes e documentos removidos).</li>' +
      '<li>Florestas públicas: Serviço Florestal Brasileiro, CNFP 2025. Unidades de Conservação: MMA, CNUC 08/2025. Terras Indígenas: FUNAI.</li>' +
      '<li>Solos e geologia: IBGE, BDiA 1:250.000. População: IBGE, Grade Estatística do Censo 2022 (1 km). Saúde: CNES/DATASUS.</li>' +
      '<li>Rios, estradas e vilas: © colaboradores do OpenStreetMap (ODbL). Tempo e qualidade do ar: Open-Meteo (modelos ERA5/CAMS).</li>' +
      '<li>Limitações: satélites não veem fogo pequeno ou sob nuvem; cadastros declaratórios (CAR) podem ter erros de contorno; a escala dos mapas de solo, vegetação e população é bem maior que a área em alguns casos. O relatório não identifica pessoas e não substitui vistoria.</li></ul>';
    h += '<p class="rep-foot">Projeto de extensão · Universidade Estadual de Roraima (UERR) · Fogo em Roraima 3D, relatório técnico v' + VERSION + '. Ferramenta de apoio: não substitui o Corpo de Bombeiros (193), a Defesa Civil (199) nem a fiscalização ambiental. Denúncias: FEMARH, IBAMA (Linha Verde 0800 061 8080).</p>';

    el.innerHTML = '<div class="rep-page ar-page">' + h + '</div>';
    el.scrollTop = 0;
    const summary = ['FOGO EM RORAIMA 3D · RELATÓRIO DA ÁREA ' + code, area.title + (R.mun ? ' · ' + R.mun : ''), 'Data: ' + br(area.date) + ' · Área: ' + haTxt(ha), 'Local: ' + lat.toFixed(5) + ', ' + lon.toFixed(5), '',
      verdict[1] + ': ' + verdict[2]].concat(R.flags.map(f => '• ' + LEVEL[f[0]][1] + ': ' + f[1]), ['', 'Indícios de dados públicos, não prova. Gerado em ' + gen + ' em https://fogororaima.com.br']).join('\n');
    const kml = () => '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + esc(code) + '</name><Placemark><name>' + esc(area.title) + ' ' + br(area.date) + '</name><description>' + esc(area.source) + '</description><Style><LineStyle><color>ff00e1ff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style><MultiGeometry>' +
      area.rings.map(r => '<Polygon><outerBoundaryIs><LinearRing><coordinates>' + Array.from({ length: r.length / 2 }, (_, k) => r[2 * k].toFixed(6) + ',' + r[2 * k + 1].toFixed(6) + ',0').join(' ') + '</coordinates></LinearRing></outerBoundaryIs></Polygon>').join('') + '</MultiGeometry></Placemark></Document></kml>';
    const gj = () => JSON.stringify({ type: 'Feature', properties: { relatorio: code, tipo: area.title, fonte: area.source, data: area.date, area_ha: Math.round(area.haCalc * 100) / 100 },
      geometry: { type: 'MultiPolygon', coordinates: area.rings.map(r => [Array.from({ length: r.length / 2 }, (_, k) => [+r[2 * k].toFixed(6), +r[2 * k + 1].toFixed(6)])]) } });
    const save = (txt, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
    el.onclick = async e => {
      const yb = e.target.closest && e.target.closest('[data-ano]');
      if (yb && R.rec) { openYearReport(area, R.rec, +yb.dataset.ano); return; }
      const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === 'close') el.remove();
      else if (a === 'print') window.print();
      else if (a === 'kml') save(kml(), code + '.kml', 'application/vnd.google-earth.kml+xml');
      else if (a === 'geojson') save(gj(), code + '.geojson', 'application/geo+json');
      else if (a === 'copy') { let ok = false; try { await navigator.clipboard.writeText(summary); ok = true; } catch (err) {} e.target.textContent = ok ? 'Resumo copiado' : 'Não deu para copiar'; }
    };
  }
  const brl = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

  // styles of the report (added once)
  const css = document.createElement('style');
  css.textContent = '.ar-wait ol{font-size:13px;color:#3d3833;padding-left:20px}.ar-wait li{margin:2px 0}.ar-wait li:last-child{font-weight:600}' +
    '.ar-page h2{display:flex;align-items:center;gap:8px}.ar-n{display:inline-grid;place-items:center;min-width:22px;height:22px;border-radius:50%;background:#1b1917;color:#fff;font:700 12px var(--f-data,system-ui)}' +
    '.ar-hero{display:block;width:100%;max-width:560px;margin:8px auto 4px;border-radius:8px}' +
    '.ar-verdict{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:8px;margin:6px 0 8px;border-left:5px solid #475467;background:#f2f4f7}.ar-verdict b{font-size:16px}.ar-verdict span{font-size:13px;color:#3d3833}' +
    '.ar-verdict.ar-alto{border-color:#b42318;background:#fef3f2}.ar-verdict.ar-medio{border-color:#b54708;background:#fffaeb}' +
    '.ar-flags{list-style:none;padding:0!important}.ar-flags li{padding:6px 8px;margin:4px 0;border-radius:6px;background:#f9fafb;border-left:4px solid #98a2b3}.ar-flags li.ar-alto{border-color:#b42318}.ar-flags li.ar-medio{border-color:#dc6803}' +
    '.ar-note{font-size:12px;color:#5a534b;margin:6px 0 0}.ar-links{font-size:13px}' +
    '.ar-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.ar-grid figure,.ar-photos figure{margin:0}.ar-grid img,.ar-photos img{width:100%;display:block;border-radius:6px}' +
    '.ar-photowarn{margin:6px 0 10px;padding:10px 12px;border-radius:8px;background:#fffaeb;border:1px solid #f5d38a;border-left:5px solid #dc6803;font-size:13.5px;line-height:1.45;color:#3d3833}.ar-photowarn b{color:#93370d}.ar-photos figcaption b{color:#93370d}' +
    '.ar-grid figcaption,.ar-photos figcaption{font-size:11.5px;color:#5a534b;margin-top:3px}.ar-photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}' +
    '.ar-sev{margin-top:8px}.ar-sev th{text-align:left;font-size:12px;color:#5a534b;border-bottom:1px solid #d9d3ca;padding:4px 0}.ar-sev td:first-child{text-align:left;font-weight:400;white-space:normal}.ar-sev i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}' +
    '.ar-years{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0}.ar-years span{font:600 11px var(--f-data,monospace);padding:3px 4px;border-radius:3px;background:#eee9e2;color:#8a8279}.ar-years span.on{background:#c2410c;color:#fff}.ar-years button{font:600 11px var(--f-data,monospace);padding:3px 4px;border-radius:3px;border:0;cursor:pointer;background:#c2410c;color:#fff}.ar-ano{margin:8px 0;padding:10px 12px;border-radius:8px;background:#f9f6f2;border-left:4px solid #c2410c}.ar-anofig{margin:8px 0 0}.ar-anofig img{width:100%;max-width:520px;display:block;border-radius:6px}.ar-anofig figcaption{font-size:11.5px;color:#5a534b;margin-top:3px}' +
    '.ar-rain{display:flex;align-items:flex-end;gap:2px;height:44px;margin-top:8px;border-bottom:1px solid #d9d3ca}.ar-rain span{flex:1;background:#3f86c6;border-radius:2px 2px 0 0;min-width:3px}' +
    '.ar-page td:last-child{white-space:normal}.ar-page td{overflow-wrap:anywhere}.ar-law{font-size:13px}' +
    '@media (max-width:560px){#report{padding:8px}.ar-page{padding:16px 14px 20px!important}.ar-page td{display:block;text-align:left!important;padding-left:0!important}.ar-page td:first-child{border-bottom:0;padding-bottom:0;color:#5a534b;font-size:12.5px}.ar-sev td{display:table-cell!important}.ar-page h1{font-size:22px}.ar-verts{font-size:11px}.ar-verts td,.ar-verts th{display:table-cell!important;text-align:right!important;padding:4px 2px!important;white-space:nowrap}.ar-verts th{font-size:11px}.ar-verts td:first-child,.ar-verts th:first-child{text-align:left!important}}' +
    '@media print{.ar-page h2{break-after:avoid}.ar-grid,.ar-sev,.ar-flags,.ar-verdict,table{break-inside:avoid}.ar-hero{max-width:380px}}';
  document.head.appendChild(css);

  // ---------- memorial descritivo do CAR: the declared perimeter of a rural property (SICAR). It does not prove possession.
  const AL_PAULISTA = 2.42, AL_GERAL = 4.84; // alqueire paulista = 2,42 ha; alqueirão (alqueire geral, mineiro, goiano) = 4,84 ha
  // UTM zone 20 N, SIRGAS 2000 (GRS 80), central meridian -63°, scale 0,9996, northern hemisphere (Roraima)
  function llToUtm(lat, lon) {
    const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2), lon0 = -63;
    const phi = lat * Math.PI / 180, lam = (lon - lon0) * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = lam * Math.cos(phi);
    const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi) +
      (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
    const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    const Nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [Math.round(E), Math.round(Nn)];
  }
  const shTxt = sh => 'sobreposição de ' + (sh < 0.01 ? 'menos de 1%' : nf(sh * 100, 0) + '%');
  const dmsTxt = (v, pos, neg) => { const x = Math.abs(v), d = Math.floor(x), mf = (x - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
    return d + '° ' + String(m).padStart(2, '0') + '′ ' + s.toFixed(2).replace('.', ',') + '″ ' + (v >= 0 ? pos : neg); };
  const decTxt = (v, d = 6) => v.toFixed(d).replace('.', ',');
  async function openMemorial(c) {
    if (running) { avisa('Aguarde o relatório atual terminar (ou cancele) e tente de novo.'); return; } running = true;
    const A = window.FRR;
    const el = document.getElementById('report') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'report' }));
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Memorial descritivo do CAR');
    el.innerHTML = '<div class="rep-page ar-wait"><p class="rep-kick">Fogo em Roraima 3D · memorial descritivo do CAR</p><h1>Montando o memorial…</h1><p class="rep-sub">Juntando o contorno declarado, os cruzamentos com bases públicas e o relevo.</p></div>';
    try {
      const rings = c.rings.filter(r => r.length >= 6);
      const area = { rings, box: boxOf(rings), title: 'Imóvel rural (CAR)', date: '2026-01-01', date1: today(), mun: c.mun, source: 'SICAR (CAR, declaração do proprietário)' };
      area.samples = samplesOf(rings, area.box); area.edge = edgeOf(rings);
      const cx = area.samples.reduce((a, p) => a + p[0], 0) / area.samples.length, cy = area.samples.reduce((a, p) => a + p[1], 0) / area.samples.length;
      area.center = inRings(cx, cy, rings) ? [cx, cy] : area.samples[Math.floor(area.samples.length / 2)];
      area.haCalc = rings.reduce((a, r) => a + ringHa(r), 0); area.perim = rings.reduce((a, r) => a + ringPerimKm(r), 0);
      await Promise.all([A.loadCarTodos ? A.loadCarTodos() : null, A.loadProdes ? A.loadProdes() : null].filter(Boolean)).catch(() => {});
      const [FP, UC, EMB, SOL, GEO] = await Promise.all(['florestas_publicas.json', 'ucs.json', 'embargos.json', 'solos.json', 'geologia.json'].map(polyLayer));
      const [ASV, POP, SAU, REC] = await Promise.all(['asv.json', 'populacao.json', 'saude.json', 'recorrencia.json'].map(layer));
      const R = analyse(area, A, { FP, UC, EMB, SOL, GEO, ASV, POP, SAU, REC, img: { figs: {}, sev: { cover: 0, classes: [], mean: null } }, lc: [], wx: {}, ph: [] });
      renderMemorial(el, c, area, R);
    } catch (e) {
      el.querySelector('.rep-page').insertAdjacentHTML('beforeend', '<p style="color:#b42318">Não foi possível montar o memorial: ' + esc(e.message) + '</p>');
      console.error(e);
    } finally { running = false; }
  }
  function memoBody(c, area, R) {
    const A = window.FRR, D = A.D, [lon, lat] = area.center, ha = area.haCalc, decl = c.area;
    const tocados = (D.munis || []).map(m => [m.nome, area.samples.filter(p => (m.r || []).some(r => pip(p[0], p[1], r))).length / area.samples.length])
      .filter(x => x[1] > 0).sort((x, y) => y[1] - x[1]);
    const utm = llToUtm(lat, lon), verts = area.rings.reduce((a, r) => a + r.length / 2 - 1, 0); // the closing point repeats the first one
    const dif = decl ? (ha - decl) / decl : null;
    const linhas = rows => '<table>' + rows.filter(Boolean).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>').join('') + '</table>';
    let h = '';
    h += '<div class="ar-photowarn"><b>Este é o contorno declarado pelo proprietário no CAR.</b> O contorno não comprova posse nem legaliza a ocupação. Os cruzamentos com outras bases são indícios, não prova de infração.</div>';
    h += '<h2>1 Identificação</h2>' + linhas([['Código do CAR', esc(c.cod)], ['Tipo', esc(c.tipoNome)], ['Situação no CAR', esc(c.cond || '–')],
      ['Município', esc(R.mun || c.mun || '–')], ['Outros municípios que a área toca', tocados.length > 1 ? tocados.slice(1).map(x => esc(x[0]) + ' (' + nf(x[1] * 100, 0) + '%)').join(', ') : 'nenhum']]);
    h += '<h2>2 Área</h2>' + linhas([['Área declarada no CAR', nf(decl, 2) + ' ha'], ['Área medida pelo contorno', nf(ha, 2) + ' ha'],
      ['Alqueire paulista (2,42 ha)', nf(ha / AL_PAULISTA, 2) + ' alqueires'], ['Alqueirão (4,84 ha)', nf(ha / AL_GERAL, 2) + ' alqueirões']]);
    if (dif != null && Math.abs(dif) > 0.05) h += '<div class="ar-photowarn"><b>Atenção:</b> a área medida pelo contorno é ' + nf(Math.abs(dif) * 100, 0) + '% ' + (dif > 0 ? 'maior' : 'menor') + ' que a declarada no CAR. Confira o cadastro no SICAR.</div>';
    h += '<h2>3 Localização</h2>' + linhas([['Centro (graus decimais)', decTxt(lat) + ' ; ' + decTxt(lon)], ['Centro (graus, minutos, segundos)', dmsTxt(lat, 'N', 'S') + ' ; ' + dmsTxt(lon, 'L', 'O')],
      ['Centro (UTM 20 N, SIRGAS 2000)', 'E ' + nf(utm[0]) + ' m · N ' + nf(utm[1]) + ' m']]);
    h += '<h2>4 Altitude</h2>' + (R.elev ? linhas([['No centro', nf(A.elevAt(lon, lat), 0) + ' m'], ['Mínima dentro do contorno', nf(R.elev.min, 0) + ' m'], ['Máxima dentro do contorno', nf(R.elev.max, 0) + ' m'], ['Média', nf(R.elev.mean, 0) + ' m']]) : '<p>Altitude indisponível.</p>');
    // passivos: indícios from the public bases, each with its distance (0 = inside the perimeter)
    const itens = [];
    (R.emb || []).forEach(e => itens.push('<b>Embargo do IBAMA</b> ' + esc(e.termo) + ' (' + esc(e.sit || '–') + ', ' + esc(e.data || '–') + '): ' + (e.km === 0 ? 'dentro do perímetro' : 'a ' + nf(e.km, 1) + ' km')));
    (R.ti || []).filter(t => t.sh > 0 || t.km <= 10).forEach(t => itens.push('<b>Terra Indígena</b> ' + esc(t.nome) + ' (' + esc(t.fase || '–') + '): ' + (t.sh > 0 ? shTxt(t.sh) + ' da área' : 'a ' + nf(t.km, 1) + ' km')));
    (R.uc || []).forEach(u => itens.push('<b>Unidade de conservação</b> ' + esc(u.nome) + ' (' + esc(u.grupo || '–') + '): ' + (u.sh > 0 ? shTxt(u.sh) : 'a ' + nf(u.km, 1) + ' km')));
    (R.fp || []).forEach(f => itens.push('<b>Floresta pública</b> ' + esc(f.nome) + ' (' + esc(f.tipo || '–') + '): ' + (f.sh > 0 ? shTxt(f.sh) : 'a ' + nf(f.km, 1) + ' km')));
    (R.deter || []).forEach(d => itens.push('<b>Desmatamento (DETER)</b> ' + esc(br(d.d)) + ', ' + esc(d.cls || '–') + ': ' + nf(d.ha, 1) + ' ha dentro da área'));
    (R.prodes || []).forEach(p => itens.push('<b>Desmatamento medido (PRODES)</b> ano ' + p.y + ': ' + nf(p.sh * 100, 0) + '% da área'));
    if (R.fireStats && R.fireStats.n) itens.push('<b>Fogo em 2026</b>: ' + nf(R.fireStats.n) + ' focos de calor no imóvel desde 01/01 (' + nf(R.fireStats.inside) + ' dentro do perímetro).' + (R.asv && R.asv.length === 0 ? ' Nenhuma autorização de supressão de vegetação encontrada na base para o imóvel; a base pode estar incompleta.' : ''));
    h += '<h2>5 Cruzamentos e passivos (indícios)</h2>' + (itens.length ? '<ul>' + itens.map(x => '<li>' + x + '</li>').join('') + '</ul>' : '<p>Nenhum cruzamento encontrado nas bases consultadas.</p>');
    const dms = d => { d = ((d % 360) + 360) % 360; const g = Math.floor(d), m = Math.floor((d - g) * 60), sx = Math.round(((d - g) * 60 - m) * 60); return g + '°' + String(m).padStart(2, '0') + "'" + String(sx).padStart(2, '0') + '"'; };
    const parts = area.rings.map(ring => { const V = []; for (let j = 0; j < ring.length - 2; j += 2) V.push([ring[j], ring[j + 1]]); return { V, U: V.map(p => llToUtm(p[1], p[0])) }; }).filter(pt => pt.U.length);
    const lbl = k => 'P-' + String(k + 1).padStart(2, '0');
    let rows = '', base = 0;
    parts.forEach(pt => { const { V, U } = pt, m = U.length;
      for (let i = 0; i < m; i++) { const j = (i + 1) % m, dE = U[j][0] - U[i][0], dN = U[j][1] - U[i][1], dist = Math.hypot(dE, dN), az = Math.atan2(dE, dN) * 180 / Math.PI, mc = (V[i][0] + 63) * Math.sin(V[i][1] * Math.PI / 180);
        rows += '<tr><td>' + lbl(base + i) + '</td><td>' + lbl(base + j) + '</td><td>' + nf(dist, 2) + '</td><td>' + dms(az) + '</td><td>' + dms(mc) + '</td><td>' + nf(U[i][0]) + '</td><td>' + nf(U[i][1]) + '</td></tr>'; }
      base += m; });
    h += '<h2>6 Vértices e roteiro perimétrico</h2><p class="ar-note">Padrão do memorial descritivo (modelo do órgão fundiário). Azimutes de quadrícula, convergência do meridiano (MC) e coordenadas UTM zona 20 N, SIRGAS 2000. Confrontantes não constam nos dados públicos do CAR.' + (parts.length > 1 ? ' O imóvel tem ' + parts.length + ' partes: os vértices seguem uma numeração contínua, e cada parte fecha no seu primeiro vértice.' : '') + '</p>';
    h += '<table class="ar-verts"><tr><th>De</th><th>Para</th><th>Dist. (m)</th><th>Azimute</th><th>MC</th><th>Leste (E)</th><th>Norte (N)</th></tr>' + rows + '</table>';
    h += '<details class="more"><summary>Ver detalhes e fontes</summary><div>' + linhas([['Perímetro', nf(area.perim, 2) + ' km (soma das distâncias entre vértices seguidos)'], ['Vértices', nf(verts)], ['Partes do contorno', nf(area.rings.length)]]) +
      '<p><b>Como cada valor foi calculado</b></p><ul>' +
      '<li><b>Área:</b> fórmula da área de polígono (cadarço) sobre uma projeção local plana, usando a latitude média do contorno. Para áreas de algumas dezenas de quilômetros quadrados, o erro é pequeno.</li>' +
      '<li><b>Alqueires:</b> alqueire paulista = 2,42 ha; alqueirão = 4,84 ha (alqueire geral, mineiro e goiano). Os valores usados aqui são os mais comuns, mas o alqueire tem variações regionais: confirme com o cartório ou o técnico.</li>' +
      '<li><b>UTM:</b> projeção Transversa de Mercator, zona 20 Norte, meridiano central -63°, datum SIRGAS 2000 (GRS 80), fator de escala 0,9996.</li>' +
      '<li><b>Altitude:</b> leitura do modelo de relevo usado pelo mapa do site, no centro e em pontos dentro do contorno.</li>' +
      '<li><b>Cruzamentos:</b> sobreposição medida pela parte da área que cai dentro de cada polígono oficial; a distância é a menor distância até o contorno.</li></ul>' +
      '<p><b>Fontes dos dados</b></p><ul>' +
      '<li>Imóvel rural (CAR): SICAR, dados públicos, declarados pelo proprietário. Sem nome do dono, CPF ou CNPJ.</li>' +
      '<li>Municípios: malha municipal do IBGE.</li><li>Embargos: IBAMA (termos de embargo).</li>' +
      '<li>Terras indígenas: FUNAI. Unidades de conservação: MMA (CNUC). Florestas públicas: SFB (CNFP).</li>' +
      '<li>Desmatamento: INPE (DETER e PRODES). Focos de fogo: INPE (satélites de referência e VIIRS, 375 m).</li>' +
      '<li>Relevo: modelo de elevação do mapa do site.</li></ul>' +
      '<p class="ar-note">Limitações: o CAR é declarado e pode ter erros de contorno; as bases têm atualizações diferentes; o satélite não vê fogo pequeno nem sob nuvem. Este memorial não substitui o memorial assinado por técnico habilitado, nem tem valor de cartório.</p></div></details>';
    return { h, itens };
  }
  function renderMemorial(el, c, area, R) {
    const A = window.FRR, [lon, lat] = area.center, ha = area.haCalc, decl = c.area;
    const mb = memoBody(c, area, R), itens = mb.itens, tocados = [];
    let h = '<p class="rep-kick">Fogo em Roraima 3D · memorial descritivo do CAR</p><h1>Memorial do imóvel rural</h1><p class="rep-sub">CAR ' + esc(c.cod) + ' · ' + esc(c.tipoNome) + '</p>' + mb.h;
    h += '<h2>Croqui de situação</h2><figure style="margin:8px 0"><div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><img style="display:block;width:100%;min-width:720px;height:auto" src="' + croquiSituacao(area, c) + '" alt="Croqui de situação do imóvel"></div><figcaption class="ar-note">Croqui de situação no padrão do memorial: roteiro perimétrico, vértices P-01, P-02…, convenções, sistema de coordenadas, escala e norte. Sem nome do proprietário. No celular, deslize o croqui para o lado para ler.</figcaption></figure>';
    h += '<div class="rep-actions"><button class="btn" data-a="print">🖨 Imprimir ou salvar em PDF</button><button class="btn" data-a="kml">Baixar contorno (KML)</button><button class="btn" data-a="geojson">GeoJSON</button><button class="btn" data-a="copy">Copiar resumo</button><button class="btn" data-a="close">Fechar</button></div>';
    el.innerHTML = '<div class="rep-page ar-page">' + h + '</div>';
    el.scrollTop = 0;
    const summary = ['FOGO EM RORAIMA 3D · MEMORIAL DO CAR ' + c.cod, 'Área declarada pelo proprietário no CAR. O contorno não comprova posse nem legaliza a ocupação.',
      'Área declarada: ' + nf(decl, 2) + ' ha · medida pelo contorno: ' + nf(ha, 2) + ' ha · ' + nf(ha / AL_PAULISTA, 2) + ' alqueires paulistas · ' + nf(ha / AL_GERAL, 2) + ' alqueirões',
      'Município: ' + (R.mun || c.mun || '–') + ' · Centro: ' + decTxt(lat) + ', ' + decTxt(lon), 'Altitude no centro: ' + nf(A.elevAt(lon, lat), 0) + ' m', 'Cruzamentos (indícios):'].concat(itens.map(x => '• ' + x.replace(/<[^>]+>/g, '')), ['Fonte: fogororaima.com.br (dados públicos)']).join('\n');
    const kml = () => '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>CAR ' + esc(c.cod) + '</name><Placemark><name>CAR ' + esc(c.cod) + '</name><Polygon><outerBoundaryIs><LinearRing><coordinates>' +
      area.rings.map(r => Array.from({ length: r.length / 2 }, (_, k) => r[2 * k].toFixed(6) + ',' + r[2 * k + 1].toFixed(6) + ',0').join(' ')).join(' ') + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';
    const gj = () => JSON.stringify({ type: 'Feature', properties: { car: c.cod, tipo: c.tipo, area_declarada_ha: decl, area_contorno_ha: Math.round(ha * 100) / 100 },
      geometry: { type: 'MultiPolygon', coordinates: area.rings.map(r => [Array.from({ length: r.length / 2 }, (_, k) => [+r[2 * k].toFixed(6), +r[2 * k + 1].toFixed(6)])]) } });
    const save = (txt, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
    el.onclick = async e => {
      const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === 'close') el.remove();
      else if (a === 'print') window.print();
      else if (a === 'kml') save(kml(), 'CAR-' + c.cod + '.kml', 'application/vnd.google-earth.kml+xml');
      else if (a === 'geojson') save(gj(), 'CAR-' + c.cod + '.geojson', 'application/geo+json');
      else if (a === 'copy') { let ok = false; try { await navigator.clipboard.writeText(summary); ok = true; } catch (err) {} e.target.textContent = ok ? 'Resumo copiado' : 'Não deu para copiar'; }
    };
  }
  // ---------- passivo ambiental no imóvel do CAR: the car's memorial, a sketch (croqui) and satellite images with both outlines
  async function carPrep(c) {
    const A = window.FRR;
    const rings = c.rings.filter(r => r.length >= 6);
    const area = { rings, box: boxOf(rings), title: 'Imóvel rural (CAR)', date: '2026-01-01', date1: today(), mun: c.mun, source: 'SICAR (CAR, declaração do proprietário)' };
    area.samples = samplesOf(rings, area.box); area.edge = edgeOf(rings);
    const cx = area.samples.reduce((a, p) => a + p[0], 0) / area.samples.length, cy = area.samples.reduce((a, p) => a + p[1], 0) / area.samples.length;
    area.center = inRings(cx, cy, rings) ? [cx, cy] : area.samples[Math.floor(area.samples.length / 2)];
    area.haCalc = rings.reduce((a, r) => a + ringHa(r), 0); area.perim = rings.reduce((a, r) => a + ringPerimKm(r), 0);
    await Promise.all([A.loadCarTodos ? A.loadCarTodos() : null, A.loadProdes ? A.loadProdes() : null].filter(Boolean)).catch(() => {});
    const [FP, UC, EMB, SOL, GEO] = await Promise.all(['florestas_publicas.json', 'ucs.json', 'embargos.json', 'solos.json', 'geologia.json'].map(polyLayer));
    const [ASV, POP, SAU, REC] = await Promise.all(['asv.json', 'populacao.json', 'saude.json', 'recorrencia.json'].map(layer));
    const R = analyse(area, A, { FP, UC, EMB, SOL, GEO, ASV, POP, SAU, REC, img: { figs: {}, sev: { cover: 0, classes: [], mean: null } }, lc: [], wx: {}, ph: [] });
    return { area, R };
  }
  // ---------- rotulos dos croquis: nunca em cima de uma linha do contorno nem de outro rotulo
  const cruza = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
  // a retangulo [x0, y0, x1, y1] (com folga de 3 px) toca o segmento a-b?
  const retaToca = (r, a, b) => {
    const x0 = r[0] - 3, y0 = r[1] - 3, x1 = r[2] + 3, y1 = r[3] + 3, dentro = p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    if (dentro(a) || dentro(b)) return true;
    return [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]].some(([p, q]) => cruza(a, b, p, q));
  };
  // coloca o texto em volta do ponto (ax, ay): primeiro do lado de fora (out) e depois em volta. So desenha onde nao toca linha nem rotulo.
  function colocaRotulo(x, txt, ax, ay, out, raios, segs, usados, lim, cor) {
    const w = x.measureText(txt).width, base = out ? Math.atan2(ay - out[1], ax - out[0]) : 0;
    const dist = a => Math.abs(Math.atan2(Math.sin(a - base), Math.cos(a - base)));
    const angs = Array.from({ length: 16 }, (_, k) => k * Math.PI / 8).sort((p, q) => dist(p) - dist(q));
    for (const raio of raios) for (const a of angs) {
      const c = Math.cos(a), sn = Math.sin(a), px = ax + raio * c - w * (1 - c) / 2, py = ay + raio * sn + 4;
      const r = [px - 3, py - 14, px + w + 3, py + 5];
      if (r[0] < lim[0] || r[1] < lim[1] || r[2] > lim[2] || r[3] > lim[3]) continue;
      if (usados.some(b => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1])) continue;
      if (segs.some(([p, q]) => retaToca(r, p, q))) continue;
      usados.push(r);
      x.fillStyle = '#fff'; x.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
      x.fillStyle = cor; x.fillText(txt, px, py);
      return true;
    }
    return false;
  }
  // sketch (croqui): the property outlines (each in a blue-grey tint, so an overlap is darker), the passive area (orange), coordinates, scale, north arrow
  function croqui(carsRings, fireRings, box, carLabels, fireLbl) {
    const W = 900, H = 900, pad = 60; const [x0, y0, x1, y1] = box; const kx = kmx((y0 + y1) / 2);
    const s = Math.min((W - 2 * pad) / (((x1 - x0) * kx)), (H - 2 * pad) / ((y1 - y0) * 110.57)); // pixels per km
    const P = (lo, la) => [pad + (lo - x0) * kx * s, H - pad - (la - y0) * 110.57 * s];
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    x.fillStyle = '#f5f3ef'; x.fillRect(0, 0, W, H);
    x.strokeStyle = '#e0dad1'; x.lineWidth = 1; x.fillStyle = '#7a7168'; x.font = '18px system-ui, sans-serif';
    for (let lo = Math.ceil(x0 / 0.02) * 0.02; lo <= x1; lo += 0.02) { const [px] = P(lo, y0); x.beginPath(); x.moveTo(px, pad); x.lineTo(px, H - pad); x.stroke(); x.fillText(decTxt(lo, 2), px - 22, H - pad + 22); }
    for (let la = Math.ceil(y0 / 0.02) * 0.02; la <= y1; la += 0.02) { const [, py] = P(x0, la); x.beginPath(); x.moveTo(pad, py); x.lineTo(W - pad, py); x.stroke(); x.fillText(decTxt(la, 2), 4, py + 6); }
    const draw = (rings, fill, stroke, lw) => { x.beginPath(); rings.forEach(r => { for (let j = 0; j < r.length; j += 2) { const [px, py] = P(r[j], r[j + 1]); j ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); }); if (fill) { x.fillStyle = fill; x.fill('evenodd'); } x.lineWidth = lw; x.strokeStyle = stroke; x.stroke(); };
    const CARCOL = ['rgba(30,64,175,.22)', 'rgba(16,122,96,.22)', 'rgba(122,60,160,.22)', 'rgba(160,110,20,.22)'];
    carsRings.forEach((rings, i) => draw(rings, CARCOL[i % CARCOL.length], i === 0 ? '#1b1917' : ['#1e40af', '#107a60', '#7a3ca0', '#a06e14'][i % 4], 4));
    draw(fireRings, 'rgba(234,88,12,.55)', '#b42318', 3);
    const cen = rr => { let a = 0, b = 0, n = 0; rr.forEach(r => { for (let j = 0; j < r.length; j += 2) { a += r[j]; b += r[j + 1]; n++; } }); return [a / n, b / n]; };
    x.font = '600 20px system-ui, sans-serif';
    const segsOf = rr => rr.flatMap(ring => { const o = []; for (let j = 2; j < ring.length; j += 2) o.push([P(ring[j - 2], ring[j - 1]), P(ring[j], ring[j + 1])]); return o; });
    const SEGS = carsRings.flatMap(rr => segsOf(rr)).concat(segsOf(fireRings)), USADOS = [], RAIOS = [0, 18, 36, 54, 72, 96, 120, 150, 180, 220];
    const lab = (txt, px, py, col) => colocaRotulo(x, txt, px, py, null, RAIOS, SEGS, USADOS, [0, 0, W, H], col);
    carsRings.forEach((rings, i) => { const [cx, cy] = P(...cen(rings)); lab(carLabels[i], cx, cy, i === 0 ? '#1b1917' : ['#1e40af', '#107a60', '#7a3ca0', '#a06e14'][i % 4]); });
    const [cfx, cfy] = P(...cen(fireRings)); lab(fireLbl, cfx, cfy, '#b42318');
    const nice = [0.5, 1, 2, 5, 10, 20].find(v => v * s > 160) || 20, L = nice * s;
    x.fillStyle = '#1b1917'; x.fillRect(pad, 36, L, 8); x.font = '600 18px system-ui, sans-serif'; x.fillText(nice + ' km', pad, 28);
    x.beginPath(); x.moveTo(W - 40, 40); x.lineTo(W - 52, 74); x.lineTo(W - 28, 74); x.closePath(); x.fillStyle = '#1b1917'; x.fill(); x.fillText('N', W - 46, 96);
    return c.toDataURL('image/png');
  }
  // area shared by two outlines, in hectares: counts points of a fine grid inside both
  function overlapHa(ringsA, ringsB) {
    const bA = boxOf(ringsA), bB = boxOf(ringsB);
    const x0 = Math.max(bA[0], bB[0]), y0 = Math.max(bA[1], bB[1]), x1 = Math.min(bA[2], bB[2]), y1 = Math.min(bA[3], bB[3]);
    if (x1 <= x0 || y1 <= y0) return 0;
    const N = 160, dx = (x1 - x0) / N, dy = (y1 - y0) / N, kx = kmx((y0 + y1) / 2); let n = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const lo = x0 + (i + 0.5) * dx, la = y0 + (j + 0.5) * dy; if (inRings(lo, la, ringsA) && inRings(lo, la, ringsB)) n++; }
    return n * (dx * kx) * (dy * 110.57) * 100; // km² → ha
  }
  // Croqui de situação in the layout used by the land agency (ITERAIMA / SIGEF examples): roteiro perimétrico table on top,
  // the parcel with its vertices (P-01, P-02…) and sides measured, conventions, coordinate system, north, scale bar and the title block.
  // No owner name, no CPF and no property name: the title block shows the CAR code.
  function croquiSituacao(area, car) {
    const W = 1000, H = 1440, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.strokeStyle = '#000'; x.fillStyle = '#000'; x.lineWidth = 2; x.strokeRect(20, 20, W - 40, H - 40);
    const parts = area.rings.map(ring => { const V = []; for (let j = 0; j < ring.length - 2; j += 2) V.push([ring[j], ring[j + 1]]); return { V, U: V.map(p => llToUtm(p[1], p[0])) }; }).filter(pt => pt.U.length);
    const allU = parts.flatMap(pt => pt.U), n = allU.length, lbl = k => 'P-' + String(k + 1).padStart(2, '0');
    const minE = Math.min(...allU.map(u => u[0])), maxE = Math.max(...allU.map(u => u[0])), minN = Math.min(...allU.map(u => u[1])), maxN = Math.max(...allU.map(u => u[1]));
    // roteiro perimétrico (top): De, Para, distância, azimute de quadrícula, convergência, E, N
    const fmtAz = d => { d = ((d % 360) + 360) % 360; const g = Math.floor(d), m = Math.floor((d - g) * 60), s = Math.round(((d - g) * 60 - m) * 60); return g + '°' + String(m).padStart(2, '0') + "'" + String(s).padStart(2, '0') + '"'; };
    const mcOf = p => (p[0] - -63) * Math.sin(p[1] * Math.PI / 180); // convergence of the meridian at the vertex, degrees
    x.font = 'bold 16px sans-serif'; x.textAlign = 'center';
    const cols = ['De', 'Para', 'Dist. (m)', 'Azimute', 'MC', 'Leste (E)', 'Norte (N)'], cx = [70, 150, 240, 360, 470, 580, 760];
    let ty = 60; x.fillText('ROTEIRO PERIMÉTRICO', W / 2, ty); ty += 14; x.font = 'bold 14px sans-serif';
    x.strokeRect(50, ty, 900, 18 * (n + 2) + 26); cols.forEach((t, i) => x.fillText(t, cx[i], ty + 16)); ty += 22;
    x.font = '14px sans-serif';
    let base = 0;
    parts.forEach(pt => { const { V, U } = pt, m = U.length;
      for (let i = 0; i < m; i++) {
        const a = U[i], b = U[(i + 1) % m], dE = b[0] - a[0], dN = b[1] - a[1], dist = Math.hypot(dE, dN), az = Math.atan2(dE, dN) * 180 / Math.PI;
        const row = [lbl(base + i), lbl(base + ((i + 1) % m)), dist.toFixed(2).replace('.', ','), fmtAz(az), fmtAz(mcOf(V[i])), nf(a[0]), nf(a[1])];
        row.forEach((t, k) => x.fillText(t, cx[k], ty + 14)); ty += 18;
      }
      base += m; });
    const area_ha = area.haCalc, perim = area.perim * 1000;
    x.font = 'bold 14px sans-serif'; x.fillText('Área (SGL): ' + nf(area_ha, 4) + ' ha     Perímetro: ' + nf(perim, 2) + ' m', W / 2, ty + 18);
    // parcel drawing
    // the drawing starts below the roteiro table, whatever the number of vertices
    const top = 74 + 18 * (n + 2) + 26 + 50, bot = 1000, left = 90, right = 910, dw = right - left, dh = bot - top;
    const sc = Math.min(dw / Math.max(1, maxE - minE), dh / Math.max(1, maxN - minN));
    const ox = left + (dw - (maxE - minE) * sc) / 2, oy = top + (dh - (maxN - minN) * sc) / 2;
    const P = u => [ox + (u[0] - minE) * sc, oy + (maxN - u[1]) * sc];
    x.lineWidth = 3; parts.forEach(pt => { x.beginPath(); pt.U.forEach((u, i) => { const [px, py] = P(u); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.closePath(); x.stroke(); });
    // rotulos: sempre fora das linhas e sem bater em outro rotulo
    const SEGS = parts.flatMap(pt => pt.U.map((u, i) => [P(u), P(pt.U[(i + 1) % pt.U.length])]));
    const CENTRO = [allU.reduce((acc, u) => acc + P(u)[0], 0) / n, allU.reduce((acc, u) => acc + P(u)[1], 0) / n];
    const USADOS = [], LIM = [30, top - 6, W - 30, bot - 6];
    x.textAlign = 'left';
    x.font = 'bold 15px sans-serif';
    let base2 = 0;
    parts.forEach(pt => { const U = pt.U, m = U.length;
      U.forEach((u, i) => { const [px, py] = P(u); x.beginPath(); x.arc(px, py, 5, 0, 7); x.fill(); colocaRotulo(x, lbl(base2 + i), px, py, CENTRO, [9, 16, 26, 38, 52, 70, 90], SEGS, USADOS, LIM, '#000'); });
      base2 += m; });
    x.font = '13px sans-serif';
    parts.forEach(pt => { const U = pt.U, m = U.length;
      for (let i = 0; i < m; i++) {
        const a = P(U[i]), b = P(U[(i + 1) % m]), d = Math.hypot(U[(i + 1) % m][0] - U[i][0], U[(i + 1) % m][1] - U[i][1]);
        colocaRotulo(x, d.toFixed(2).replace('.', ',') + ' m', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, CENTRO, [12, 20, 30, 42, 60, 80], SEGS, USADOS, LIM, '#000');
      } });
    x.textAlign = 'center';
    // conventions, coordinate system and north
    const by = 1020, bh = 150;
    x.strokeRect(40, by, 290, bh); x.strokeRect(340, by, 330, bh); x.strokeRect(680, by, 280, bh);
    x.font = 'bold 14px sans-serif'; x.fillText('CONVENÇÕES', 185, by + 20); x.font = '13px sans-serif';
    x.fillText('● Vértice do perímetro (P-nn)', 175, by + 50); x.fillText('— Contorno do imóvel', 175, by + 75); x.fillText('▨ Área do passivo (incêndio)', 175, by + 100);
    x.font = 'bold 14px sans-serif'; x.fillText('SISTEMA DE COORDENADAS', 505, by + 20); x.font = '13px sans-serif';
    x.fillText('SIRGAS 2000 · UTM zona 20 Norte', 505, by + 50); x.fillText('Meridiano central -63°, fator 0,9996', 505, by + 72); x.fillText('Azimutes: de quadrícula (com MC)', 505, by + 94); x.fillText('Coordenadas planas (E, N) em metros', 505, by + 116);
    x.font = 'bold 14px sans-serif'; x.fillText('ORIENTAÇÃO', 820, by + 20);
    x.beginPath(); x.moveTo(820, by + 50); x.lineTo(810, by + 92); x.lineTo(830, by + 92); x.closePath(); x.fill(); x.font = 'bold 14px sans-serif'; x.fillText('N', 820, by + 110);
    // graphic scale
    const dens = Math.round((1 / sc) / 0.00026458);
    x.font = 'bold 14px sans-serif'; x.fillText('ESCALA GRÁFICA', W / 2, 1192);
    x.font = '12px sans-serif';
    const pxPerM = sc, stepM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].reverse().find(v => v * pxPerM <= 480) || 1, bar = stepM * pxPerM;
    x.fillRect(120, 1200, bar, 8); x.fillText('0', 120, 1222); x.fillText(nf(stepM) + ' m', 120 + bar - 30, 1222);
    // title block
    x.strokeRect(40, 1260, 920, 150); x.font = 'bold 15px sans-serif'; x.textAlign = 'left';
    x.fillText('PROJETO: CROQUI DE SITUAÇÃO', 55, 1282);
    x.font = '14px sans-serif';
    x.fillText('IMÓVEL (código CAR): ' + (car ? car.cod : '–'), 55, 1306);
    x.fillText('MUNICÍPIO: ' + (car ? car.mun : '–') + ' · UF: RR', 55, 1328); x.fillText('PERÍMETRO (m): ' + nf(perim, 2), 560, 1328);
    x.fillText('ÁREA (ha): ' + nf(area_ha, 4), 55, 1350); x.fillText('DATA: ' + br(today()), 560, 1350);
    x.fillText('ESCALA: 1 / ' + nf(dens), 55, 1372);
    x.fillText('Proprietário: ____________________________', 55, 1394); x.fillText('Responsável técnico: ____________________', 560, 1394);
    x.textAlign = 'left';
    return c.toDataURL('image/png');
  }
  async function carBlock(el, car, area, R, n, total) {
    const A = window.FRR, root = el.querySelector('.rep-page');
    const cp = await carPrep(car);
    // satellite images with both outlines (the property and the fire); same method as the report
    const bx = [Math.min(cp.area.box[0], area.box[0]), Math.min(cp.area.box[1], area.box[1]), Math.max(cp.area.box[2], area.box[2]), Math.max(cp.area.box[3], area.box[3])];
    const combo = { rings: cp.area.rings.concat(area.rings), box: bx, date: area.date, date1: area.date1, center: cp.area.center, samples: cp.area.samples.concat(area.samples), edge: cp.area.edge.concat(area.edge) };
    const imgC = await imagery(combo, A, () => {}).catch(e => ({ err: e.message, figs: {} }));
    const mg = 0.01, cb = [bx[0] - mg, bx[1] - mg, bx[2] + mg, bx[3] + mg];
    const fireLbl = (area.title || 'Passivo') + (area.date ? ' · ' + br(area.date) : '');
    const cro = croqui([cp.area.rings], area.rings, cb, ['Imóvel ' + n + ' do CAR'], fireLbl);
    const head = total > 1 ? '<h3>7.' + n + ' Imóvel do CAR ' + n + ' de ' + total + '</h3>' : '<h2><span class="ar-n">7</span>Passivo ambiental no imóvel do CAR</h2>';
    let h = head;
    h += '<div class="ar-photowarn"><b>O contorno do CAR é o declarado pelo proprietário.</b> Estar dentro dele não prova quem causou o fogo. Os cruzamentos são indícios de bases públicas, não prova de infração.</div>';
    const sit = croquiSituacao(cp.area, car);
    h += '<figure style="margin:8px 0"><div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><img style="display:block;width:100%;min-width:720px;height:auto" src="' + sit + '" alt="Croqui de situação do imóvel"></div><figcaption class="ar-note">Croqui de situação no padrão do memorial: roteiro perimétrico, vértices P-01, P-02…, convenções, sistema de coordenadas, escala e norte. Sem nome do proprietário. No celular, deslize o croqui para o lado para ler.</figcaption></figure>';
    h += '<figure style="margin:8px 0"><img style="max-width:100%;height:auto" src="' + cro + '" alt="Croqui da área"><figcaption class="ar-note">Croqui: contorno do imóvel em preto e área do passivo em laranja. Escala e norte no desenho. Coordenadas em graus decimais (SIRGAS 2000).</figcaption></figure>';
    const figs = imgC.figs || {};
    if (Object.keys(figs).length) {
      h += '<div class="ar-grid">' + ['pre', 'post', 'now', 'sev'].filter(k => figs[k]).map(k => '<figure><img style="max-width:100%;height:auto" src="' + figs[k] + '" alt="Imagem de satélite com o contorno do CAR e do passivo"></figure>').join('') + '</div>';
      h += '<p class="ar-note">Imagens de satélite com os dois contornos: amarelo para o imóvel do CAR e para a área do passivo. Sentinel-2 (10 m), Copernicus/ESA, via Microsoft Planetary Computer.</p>';
    } else h += '<p>Não foi possível obter imagens de satélite agora. Tente gerar o relatório de novo mais tarde.</p>';
    h += memoBody(car, cp.area, cp.R).h;
    const sec = document.createElement('div'); sec.className = 'ar-carblock'; sec.innerHTML = h; root.appendChild(sec);
    return cp;
  }
  // when the passive touches more than one CAR property: one sketch with all of them, and the shared area between each pair
  async function overlapBlock(el, cars, preps, area) {
    const root = el.querySelector('.rep-page');
    const rings = preps.map(p => p.area.rings);
    const bx = preps.reduce((b, p) => [Math.min(b[0], p.area.box[0]), Math.min(b[1], p.area.box[1]), Math.max(b[2], p.area.box[2]), Math.max(b[3], p.area.box[3])], area.box);
    const mg = 0.01, cb = [bx[0] - mg, bx[1] - mg, bx[2] + mg, bx[3] + mg];
    const cro = croqui(rings, area.rings, cb, preps.map((p, i) => 'Imóvel ' + (i + 1) + ' do CAR'), (area.title || 'Passivo') + (area.date ? ' · ' + br(area.date) : ''));
    const pares = [];
    for (let i = 0; i < preps.length; i++) for (let j = i + 1; j < preps.length; j++) {
      const ha = overlapHa(rings[i], rings[j]);
      if (ha > 0.01) pares.push({ i: i + 1, j: j + 1, ha, pa: ha / preps[i].area.haCalc, pb: ha / preps[j].area.haCalc });
    }
    let h = '<h2><span class="ar-n">8</span>Sobreposição entre cadastros do CAR</h2>';
    h += '<div class="ar-photowarn"><b>Sobreposição de cadastro é um indício, não prova de irregularidade.</b> Pode ser erro de digitalização ou de contorno. Confira os imóveis no SICAR e com o órgão ambiental.</div>';
    h += '<figure style="margin:8px 0"><img style="max-width:100%;height:auto" src="' + cro + '" alt="Croqui com os imóveis do CAR"><figcaption class="ar-note">Croqui com todos os imóveis do CAR que tocam o passivo. Onde os contornos se cruzam, a cor fica mais escura.</figcaption></figure>';
    if (pares.length) {
      h += '<table class="ar-sev"><tr><th>Par</th><th>Área em comum</th><th>% do imóvel 1</th><th>% do imóvel 2</th></tr>' + pares.map(p =>
        '<tr><td>Imóvel ' + p.i + ' × Imóvel ' + p.j + '</td><td>' + haTxt(p.ha) + '</td><td>' + nf(p.pa * 100, 1) + '%</td><td>' + nf(p.pb * 100, 1) + '%</td></tr>').join('') + '</table>';
    } else h += '<p>Não há sobreposição medida entre os imóveis do CAR que tocam o passivo.</p>';
    h += '<p class="ar-note">Área medida pela sobreposição dos contornos declarados (grade de pontos). Os imóveis estão identificados por número; os códigos estão na seção de cada imóvel.</p>';
    const sec = document.createElement('div'); sec.className = 'ar-carblock'; sec.innerHTML = h; root.appendChild(sec);
  }
  // ---------- documento de prejuizo: quanto a lei preve, quanto custa cada dano por hectare, o gasto do combate, os imoveis do CAR
  // com o memorial e um texto formal para o orgao. Ordem de grandeza, com as fontes. Rascunho: a revisao da FEMARH esta pendente.
  const PJ_MULTA = { pasto: 3000, nativa: 10000 };     // Decreto 6.514/2008, arts. 58 (pasto e roça) e 58-A (vegetação nativa)
  const PJ_PASTO = [630, 800], PJ_REFORMA = [1500, 4700]; // R$/ha: recuperação de pasto; reforma (faixa de consultoria até valor de boletim)
  const PJ_CO2_T = 18, PJ_USD_T = 190;                 // t de CO2 por ha de floresta queimada; US$ por t (social do carbono)
  const PJ_MSG = 'Aguarde o relatório atual terminar (ou cancele) e tente de novo.';
  async function openPrejuizo(area0, cars) {
    if (running) { avisa(PJ_MSG); return; }
    const A = window.FRR, el = document.getElementById('report') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'report' }));
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Documento de prejuízo estimado');
    if (!document.getElementById('pjCss')) { const st = document.createElement('style'); st.id = 'pjCss';
      st.textContent = '.pj-form{display:grid;gap:8px;margin:8px 0}.pj-form label{font-size:14px;display:grid;gap:3px}.pj-form input{font:inherit;padding:6px 8px;border:1px solid #d9d3ca;border-radius:6px;max-width:340px}.pj-ck{display:flex!important;align-items:center;gap:6px}.ar-page table td.v{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}.pj-texto{width:100%;min-height:320px;font:13.5px/1.5 system-ui,sans-serif;padding:10px;border:1px solid #d9d3ca;border-radius:6px;box-sizing:border-box}';
      document.head.appendChild(st); }
    const rings = area0.rings.filter(r => r.length >= 6), box = boxOf(rings), samples = samplesOf(rings, box), n = samples.length || 1;
    const ha0 = area0.ha || rings.reduce((a, r) => a + ringHa(r), 0);
    const cnt = new Array(8).fill(0); samples.forEach(p => cnt[A.lcAt(p[0], p[1])]++);
    const sh = cnt.map(c => c / n), shPasto = sh[2] + sh[3], shFlor = sh[0], shLav = sh[1], shOut = Math.max(0, 1 - shPasto - shFlor - shLav);
    const ti = (A.D.tis || []).some(t => { const b = t.box || boxOf(t.r); return boxHit(b, box) && samples.some(p => t.r.some(r => pip(p[0], p[1], r))); });
    // SINAFLOR: o mesmo cruzamento do relatorio da area, so com as autorizacoes do proprio CAR
    const ASVJ = await layer('asv.json').catch(() => null);
    const cxLL = samples.reduce((a, p) => a + p[0], 0) / n, cyLL = samples.reduce((a, p) => a + p[1], 0) / n;
    const normC = t => (t || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
    const codesCar = new Set((cars || []).map(c => normC(c.cod)));
    const asvL = ASVJ && ASVJ.itens ? ASVJ.itens.map(a => { const k = normC(a[4]), km = a[9] ? distKm(cxLL, cyLL, a[9][0], a[9][1]) : null;
      return { num: a[0], em: a[1], val: a[2], car: a[4], fin: a[5], ha: a[6], sit: a[7], org: a[8], km, k, sameCar: !!(k && codesCar.has(k)) }; })
      .filter(x => x.sameCar) : [];
    const asvValid = asvL.filter(x => x.sameCar && x.em && x.val && x.em <= (area0.date1 || area0.date) && x.val >= area0.date);
    const asvGerado = ASVJ && ASVJ.gerado ? br(ASVJ.gerado) : null;
    const carsL = (cars || []).map(c => { const cc = normC(c.cod); return { c, shIn: samples.filter(p => c.rings.some(r => pip(p[0], p[1], r))).length / n, auts: asvL.filter(x => x.sameCar && x.k === cc) }; });
    const data = (area0.date1 && area0.date1 !== area0.date) ? br(area0.date) + ' a ' + br(area0.date1) : br(area0.date);
    const cell = (k, v) => '<tr><td>' + k + '</td><td class="v">' + v + '</td></tr>';
    const h = [];
    h.push('<div class="rep-page ar-page">');
    h.push('<div class="rep-actions"><button class="btn" data-a="print">🖨 Imprimir ou salvar em PDF</button><button class="btn" data-a="close">Fechar</button></div>');
    h.push('<p class="rep-kick">Fogo em Roraima 3D · documento de prejuízo estimado · rascunho</p>');
    h.push('<h1>Quanto a lei prevê e quanto custa o fogo nesta área</h1>');
    h.push('<p class="rep-sub">' + esc(area0.title || '') + ' · ' + esc(area0.source || '') + ' · data ' + esc(data) + (area0.mun ? ' · ' + esc(area0.mun) : '') + '</p>');
    h.push('<div class="ar-photowarn"><b>Simulação de ordem de grandeza, não é multa nem laudo.</b> O documento não diz quem causou o fogo: a multa depende de identificar o responsável, da falta de autorização e de um processo com direito de defesa. <b>Antes de enviar a qualquer órgão</b>, o enquadramento do lavrado e os valores precisam da revisão técnica da FEMARH (ainda pendente).</div>');
    h.push('<h2>1 Dados que você pode ajustar</h2><div class="pj-form">');
    h.push('<label>Área queimada (ha)<input id="pjHa" type="number" min="0" step="1" value="' + Math.round(ha0) + '"></label>');
    h.push('<label class="pj-ck"><input type="checkbox" id="pjTi"' + (ti ? ' checked' : '') + '> Área em Terra Indígena (multa em dobro, art. 60)</label></div>');
    h.push('<p class="ar-note">A composição vem do mapa de vegetação (MODIS, 2023). Os valores mudam quando você altera os dados.</p>');
    h.push('<h2>2 Composição da área</h2><table><tr><th>Tipo de terreno</th><th class="v">Área</th><th class="v">Parte</th></tr>');
    h.push('<tr><td>Pasto, roça e agricultura</td><td class="v" id="pjPastoHa"></td><td class="v" id="pjPastoPct"></td></tr>');
    h.push('<tr><td>Floresta</td><td class="v" id="pjFlorHa"></td><td class="v" id="pjFlorPct"></td></tr>');
    h.push('<tr><td>Lavrado / savana</td><td class="v" id="pjLavHa"></td><td class="v" id="pjLavPct"></td></tr>');
    h.push('<tr><td>Outros (área alagável, água, urbana)</td><td class="v" id="pjOutHa"></td><td class="v" id="pjOutPct"></td></tr></table>');
    h.push('<h2>3 Multa prevista na lei (simulação)</h2>');
    h.push('<p>O lavrado é vegetação nativa, mas o enquadramento dele para a queima é uma questão em aberto. Por isso a multa aparece nas duas possibilidades:</p>');
    h.push('<table><tr><th>Tipo de terreno (arredondado para cima)</th><th class="v">Lavrado como campo (art. 58, R$ 3.000/ha)</th><th class="v">Lavrado como vegetação nativa (art. 58-A, R$ 10.000/ha)</th></tr>');
    h.push('<tr><td>Pasto, roça e agricultura · R$ 3.000/ha</td><td class="v" id="pjMPasto"></td><td class="v" id="pjMPasto2"></td></tr>');
    h.push('<tr><td>Lavrado / savana</td><td class="v" id="pjMLavA"></td><td class="v" id="pjMLavB"></td></tr>');
    h.push('<tr><td>Floresta · R$ 10.000/ha (art. 58-A)</td><td class="v" id="pjMFlorA"></td><td class="v" id="pjMFlorB"></td></tr>');
    h.push('<tr><td>Terra Indígena (multa em dobro, art. 60)</td><td class="v" id="pjMultTi" colspan="2"></td></tr>');
    h.push('<tr class="tot"><td>Multa prevista</td><td class="v" id="pjMultaA"></td><td class="v" id="pjMultaB"></td></tr></table>');
    h.push('<h2>4 Quanto custa cada dano, por hectare, com a fonte</h2>');
    h.push('<table><tr><th>Dano</th><th>Valor por hectare</th><th>Fonte</th><th class="v">Nesta área</th></tr>');
    h.push('<tr><td>Recuperar o pasto e a roça queimados</td><td>R$ 630 a R$ 800</td><td>Scot Consultoria (2021), publicado pela Corteva</td><td class="v" id="pjRec"></td></tr>');
    h.push('<tr><td>Reforma completa do pasto (referência)</td><td>de R$ 1.500 (consultoria) a R$ 4.700 (boletim IFAG)</td><td>Agrolink (2026), citando boletim do IFAG e consultor</td><td class="v" id="pjReforma"></td></tr>');
    h.push('<tr><td>Carbono da floresta queimada</td><td>18 t de CO₂ × US$ 190 = cerca de US$ 3.420</td><td>IPAM, via IHU On-Line (2024); EPA (2023)</td><td class="v" id="pjCo2"></td></tr>');
    h.push('<tr><td>Lavrado e área alagável</td><td>sem valor confiável por hectare</td><td>não há dado para Roraima</td><td class="v">não calculado</td></tr></table>');
    h.push('<p class="ar-note">O carbono é o custo para o clima, em dólares, e não entra na soma em reais. A reforma completa aparece só como referência.</p>');
    h.push('<h2>5 Total em reais</h2><table><tr><th>Cenário</th><th class="v">Multa</th><th class="v">Recuperação do pasto</th><th class="v">Total</th></tr>');
    h.push('<tr><td>Lavrado como campo (art. 58)</td><td class="v" id="pjTA_m"></td><td class="v" id="pjTA_r"></td><td class="v" id="pjTA_t"></td></tr>');
    h.push('<tr><td>Lavrado como vegetação nativa (art. 58-A)</td><td class="v" id="pjTB_m"></td><td class="v" id="pjTB_r"></td><td class="v" id="pjTB_t"></td></tr></table>');
    h.push('<p class="ar-note">A soma só mostra a ordem de grandeza. A multa é uma sanção prevista na lei, e não um custo que o fogo causa diretamente.</p>');
    h.push('<h2>6 Imóveis do CAR que tocam a área</h2>');
    if (carsL.length) {
      h.push('<p>Dados públicos do SICAR, declarados pelos proprietários. Não é prova de que o imóvel tem relação com o fogo.</p>');
      h.push('<table><tr><th>Código do CAR</th><th>Tipo e situação</th><th class="v">Área declarada</th><th class="v">Parte da área queimada no imóvel</th><th class="v">Autorizações SINAFLOR</th></tr>');
      h.push(carsL.map(x => '<tr><td>' + esc(x.c.cod) + '</td><td>' + esc(x.c.tipoNome || '') + ' · ' + esc(x.c.cond || 'situação não informada') + '</td><td class="v">' + nf(x.c.area, 0) + ' ha</td><td class="v">' + nf(x.shIn * 100, 0) + '%</td><td class="v">' + (x.auts.length ? x.auts.length + (x.auts.length === 1 ? ' autorização' : ' autorizações') : 'nenhuma') + '</td></tr>').join(''));
      h.push('</table><p class="ar-note">Os memoriais de cada imóvel estão logo abaixo.</p><div id="pjCars"></div>');
    } else h.push('<p>Nenhum imóvel do CAR toca a área, ou o CAR não foi consultado.</p>');
    h.push('<h3>Autorizações de supressão de vegetação (SINAFLOR)</h3>');
    const sitF = x => x.val < area0.date ? 'vencida antes do fogo' : x.em > (area0.date1 || area0.date) ? 'emitida depois do fogo' : 'vigente na data do fogo';
    h.push(asvL.length ? '<table><tr><th>Nº</th><th>Emitida</th><th>Válida até</th><th>Situação no fogo</th><th class="v">Área (ha)</th></tr>' + asvL.slice(0, 8).map(x => '<tr><td>' + esc(String(x.num)) + '</td><td>' + br(x.em) + '</td><td>' + br(x.val) + '</td><td>' + sitF(x) + '</td><td class="v">' + nf(x.ha, 1) + '</td></tr>').join('') + '</table>' : '<p>Nenhuma autorização do imóvel do CAR na base SINAFLOR.</p>');
    h.push('<p class="ar-note">Base SINAFLOR (dados abertos do IBAMA)' + (asvGerado ? ', atualizada em ' + asvGerado : '') + '. A base não traz, em todos os casos, autorizações emitidas pelo sistema estadual (FEMARH); por isso a falta de registro não prova que não houve autorização.</p>');
    h.push('<h2>7 O que fica de fora</h2>');
    h.push('<p>Gado morto, cercas, casas e galpões, gastos com saúde e remédios, dias de trabalho e de aula perdidos, voos e estradas afetados pela fumaça, perda de turismo, de frutos e de caça para as comunidades, e o custo do combate ao fogo. Sem dado confiável para Roraima; por isso o prejuízo real tende a ser maior.</p>');
    h.push('<h2>8 Texto para enviar ao órgão</h2>');
    h.push('<div class="ar-photowarn"><b>Rascunho.</b> Preencha os campos entre colchetes e confira os números. Não envie antes da revisão técnica da FEMARH. O texto não identifica responsáveis pelo fogo.</div>');
    h.push('<textarea class="pj-texto" id="pjTexto" aria-label="Texto para o órgão"></textarea>');
    h.push('<div class="rep-actions"><button class="btn" data-a="copy-texto">Copiar texto</button></div>');
    h.push('<h2>9 Fontes</h2><ul class="ar-src">');
    h.push('<li>INPE, Programa Queimadas: focos de calor e eventos de fogo. https://terrabrasilis.dpi.inpe.br/queimadas/portal/</li>');
    h.push('<li>SICAR: Cadastro Ambiental Rural, dados públicos declarados pelos proprietários.</li>');
    h.push('<li>MODIS MCD12Q1 (classes IGBP), 2023, via NASA GIBS: composição da vegetação.</li>');
    h.push('<li>Brasil. Decreto nº 6.514, de 22 de julho de 2008, arts. 58, 58-A e 60 (redação de 2024).</li>');
    h.push('<li>SCOT CONSULTORIA. Custos de reforma e recuperação de pastagem. Bebedouro: Scot Consultoria, 2021. Publicado em: https://www.corteva.com/br/coeficiente-agro/artigos/planejamento-custos-de-reforma-e-recuperacao-de-pastagens.html</li>');
    h.push('<li>AGROLINK. Valorização do boi favorece reforma de pastagens (2026), citando boletim do IFAG. https://www.agrolink.com.br/noticias/valorizacao-do-boi-favorece-reforma-de-pastagens_518959.html</li>');
    h.push('<li>AGROLINK. Recuperar pastagens pode custar até R$ 4,5 mil por hectare (2026). https://www.agrolink.com.br/noticias/recuperar-pastagens-pode-custar-ate-r--4-5-mil-por-hectare--diz-ubirajara-fontoura_520859.html</li>');
    h.push('<li>IHU On-Line. Emissão de CO2 por queimadas na Amazônia cresce 60% (2024), com dados do IPAM. https://www.ihu.unisinos.br/643716-emissao-de-co2-por-queimadas-na-amazonia-cresce-60</li>');
    h.push('<li>UNITED STATES. Environmental Protection Agency. Report on the social cost of greenhouse gases. Washington, DC: EPA, 2023 (US$ 190 por tonelada de CO₂).</li>');
    h.push('<h2>10 Limites</h2><p class="ar-note">Ordem de grandeza. Satélites não veem fogo pequeno nem o que está sob nuvem; a composição é aproximada; os preços variam por região e por ano. Não é parecer técnico nem jurídico.</p>');
    h.push('</div>');
    el.innerHTML = h.join('');
    const q = id => el.querySelector('#' + id);
    const put = (id, txt) => { const x = q(id); if (x) x.textContent = txt; };
    const haIn = q('pjHa'), tiIn = q('pjTi'), texto = q('pjTexto');
    let dirty = false, V = {};
    texto.addEventListener('input', () => { dirty = true; });
    const brlR = v => brl(Math.round(v));
    const asvTexto = () => asvValid.length
      ? 'Na base SINAFLOR (IBAMA, dados abertos), há autorização de supressão válida na data do fogo para o imóvel do CAR (nº ' + asvValid.map(x => x.num).join(', ') + '). Pedimos conferir se a área autorizada corresponde à área queimada, e as providências cabíveis.'
      : asvL.length
        ? 'Na base SINAFLOR (IBAMA, dados abertos) há autorização vinculada ao imóvel do CAR (nº ' + asvL.map(x => x.num).join(', ') + '), mas nenhuma válida na data do fogo. Pedimos verificar a situação dessa autorização e as providências cabíveis.'
        : 'Na base SINAFLOR (IBAMA, dados abertos) não encontramos autorização de supressão vinculada aos imóveis citados. A base pode não trazer autorizações emitidas pelo sistema estadual (FEMARH); pedimos verificar com o órgão e as providências cabíveis.';
    const textoOrgao = () => [
      'À [ÓRGÃO: FEMARH ou Ministério Público]', '',
      'Assunto: fogo em área de cerca de ' + nf(V.ha) + ' hectares em ' + (area0.mun || 'Roraima') + ' e pedido de verificação', '',
      'Senhor(a),', '',
      'Com base em dados públicos do INPE (Programa Queimadas) e do Cadastro Ambiental Rural (SICAR), identificamos fogo em área de cerca de ' + nf(V.ha) + ' hectares em ' + (area0.mun || 'Roraima') + ', registrado entre ' + br(area0.date) + ' e ' + br(area0.date1 || area0.date) + ' (' + (area0.source || '') + '). Segundo o mapa de vegetação (MODIS, 2023), cerca de ' + nf(V.hP) + ' ha são de pasto e roça, ' + nf(V.hL) + ' ha de lavrado e ' + nf(V.hF) + ' ha de floresta. Imóveis do CAR que tocam a área: ' + (carsL.length ? carsL.map(x => x.c.cod).join(', ') : 'nenhum identificado') + '.', '',
      asvTexto(), '',
      'Estimativa de ordem de grandeza, sem apuração: multa prevista na legislação (Decreto 6.514/2008) entre ' + brlR(V.mA) + ' e ' + brlR(V.mB) + ', conforme o enquadramento do lavrado; custo de recuperação do pasto entre ' + brlR(V.rLo) + ' e ' + brlR(V.rHi) + '; e emissão de carbono estimada em cerca de ' + nf(V.tCo2) + ' t de CO₂. As contas e as fontes estão no documento anexo.', '',
      'Este texto não identifica responsáveis pelo fogo.', '',
      'Atenciosamente,', '[NOME DE QUEM ENVIA]', '[CONTATO E INSTITUIÇÃO]', '[DATA]', '',
      'Anexo: documento "Quanto a lei prevê e quanto custa o fogo nesta área" (Fogo em Roraima 3D).'
    ].join('\n');
    const upd = () => {
      const ha = Math.max(0, +haIn.value || 0), mult = tiIn.checked ? 2 : 1;
      const hP = Math.ceil(ha * shPasto), hL = Math.ceil(ha * shLav), hF = Math.ceil(ha * shFlor);
      const mP = hP * PJ_MULTA.pasto, mLA = hL * PJ_MULTA.pasto, mLB = hL * PJ_MULTA.nativa, mF = hF * PJ_MULTA.nativa;
      const mA = (mP + mLA + mF) * mult, mB = (mP + mLB + mF) * mult;
      const rLo = ha * shPasto * PJ_PASTO[0], rHi = ha * shPasto * PJ_PASTO[1], refLo = ha * shPasto * PJ_REFORMA[0], refHi = ha * shPasto * PJ_REFORMA[1];
      const tCo2 = ha * shFlor * PJ_CO2_T, usd = tCo2 * PJ_USD_T;
      put('pjPastoHa', nf(ha * shPasto, 1) + ' ha'); put('pjPastoPct', nf(shPasto * 100, 0) + '%');
      put('pjFlorHa', nf(ha * shFlor, 1) + ' ha'); put('pjFlorPct', nf(shFlor * 100, 0) + '%');
      put('pjLavHa', nf(ha * shLav, 1) + ' ha'); put('pjLavPct', nf(shLav * 100, 0) + '%');
      put('pjOutHa', nf(ha * shOut, 1) + ' ha'); put('pjOutPct', nf(shOut * 100, 0) + '%');
      put('pjMPasto', brlR(mP)); put('pjMPasto2', brlR(mP));
      put('pjMLavA', brlR(mLA)); put('pjMLavB', brlR(mLB));
      put('pjMFlorA', brlR(mF)); put('pjMFlorB', brlR(mF));
      put('pjMultTi', mult > 1 ? 'multa dobrada (× 2)' : 'não se aplica');
      put('pjMultaA', brlR(mA)); put('pjMultaB', brlR(mB));
      put('pjRec', brlR(rLo) + ' a ' + brlR(rHi));
      put('pjReforma', brlR(refLo) + ' a ' + brlR(refHi) + ' (referência)');
      put('pjCo2', 'cerca de US$ ' + nf(usd) + ' (' + nf(tCo2) + ' t de CO₂)');
      put('pjTA_m', brlR(mA)); put('pjTA_r', brlR(rLo) + ' a ' + brlR(rHi)); put('pjTA_t', brlR(mA + rLo) + ' a ' + brlR(mA + rHi));
      put('pjTB_m', brlR(mB)); put('pjTB_r', brlR(rLo) + ' a ' + brlR(rHi)); put('pjTB_t', brlR(mB + rLo) + ' a ' + brlR(mB + rHi));
      V = { ha, hP, hL, hF, mA, mB, rLo, rHi, tCo2 };
      if (!dirty) texto.value = textoOrgao();
    };
    haIn.addEventListener('input', upd); tiIn.addEventListener('change', upd); upd();
    el.scrollTop = 0;
    el.onclick = async e => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'close') el.remove();
      else if (a === 'print') window.print();
      else if (a === 'copy-texto') { let ok = false; try { await navigator.clipboard.writeText(texto.value); ok = true; } catch (err) {} e.target.textContent = ok ? 'Texto copiado' : 'Não deu para copiar: selecione o texto e copie'; }
    };
    // memorial de cada imovel do CAR (monta em seguida, como no relatorio da area)
    const caixaCars = q('pjCars');
    for (let k = 0; caixaCars && k < carsL.length; k++) {
      const c = carsL[k].c;
      try {
        const cp = await carPrep(c);
        caixaCars.insertAdjacentHTML('beforeend', '<div class="ar-carblock"><h3>6.' + (k + 1) + ' Imóvel ' + (k + 1) + ' do CAR · ' + esc(c.cod) + '</h3>' + memoBody(c, cp.area, cp.R).h + '</div>');
      } catch (err) { caixaCars.insertAdjacentHTML('beforeend', '<p style="color:#b42318">Não foi possível montar o memorial de ' + esc(c.cod) + ': ' + esc(err.message) + '</p>'); }
    }
  }
  window.FRR_AREA = { open, memorial: openMemorial, prejuizo: openPrejuizo, version: VERSION };
})();
