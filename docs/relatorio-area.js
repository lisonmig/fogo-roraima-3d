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
    const frame = frameOf(area), mask = maskOf(area, frame), d = area.date, t = today();
    step('Procurando imagens Sentinel-2 sem nuvem (antes e depois)');
    const [preC, postC, nowC] = await Promise.all([
      s2Search(frame.b, addDays(d, -150), addDays(d, -2)).catch(() => []),
      s2Search(frame.b, addDays(area.date1 || d, 0), addDays(area.date1 || d, 75) > t ? t : addDays(area.date1 || d, 75)).catch(() => []),
      dayDiff(addDays(area.date1 || d, 75), t) > 20 ? s2Search(frame.b, addDays(t, -90), t).catch(() => []) : Promise.resolve([])]);
    step('Conferindo nuvens sobre a área em cada imagem');
    let [pre, post, now] = await Promise.all([bestScene(preC, frame, mask, addDays(d, -10)), bestScene(postC, frame, mask, addDays(area.date1 || d, 10)), bestScene(nowC, frame, mask, t)]);
    // fire ended a few days ago (or still burning): no clear image after it yet, so take the one with the least cloud over the area
    // since the fire started, even if cloudy, and say it is from during the fire
    if (!post) {
      step('Sem imagem limpa depois do fogo: buscando a de menos nuvem desde o início do incêndio');
      const durC = await s2Search(frame.b, d, t).catch(() => []);
      post = await bestScene(durC, frame, mask, t);
      if (post) post.during = post.date <= (area.date1 || d);
    }
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
    const u = OM + '?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) + '&start_date=' + d0 + '&end_date=' + d1 +
      '&daily=precipitation_sum,temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,wind_direction_10m_dominant&timezone=America%2FBoa_Vista';
    const J = await getJSON(u, 30000), D = J.daily;
    const days = D.time.map((t, i) => ({ t, rain: D.precipitation_sum[i], tmax: D.temperature_2m_max[i], rh: D.relative_humidity_2m_min[i], wind: D.wind_speed_10m_max[i], dir: D.wind_direction_10m_dominant[i] }));
    const before = days.filter(x => x.t < area.date), at = days.find(x => x.t === area.date) || days[days.length - 1];
    let dry = 0; for (let i = before.length - 1; i >= 0; i--) { if ((before[i].rain || 0) >= 5) break; dry++; }
    const rain30 = before.reduce((a, x) => a + (x.rain || 0), 0);
    let air = null;
    try {
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
  async function open(area0) {
    if (running) return; running = true;
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
      const R = analyse(area, A, { FP, UC, EMB, SOL, GEO, ASV, POP, SAU, REC, img, lc, wx, ph });
      render(el, area, R);
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
    for (let i = 0; i < F.t.length; i++) {
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
    R.inpe = (A.IN && A.IN.ev || []).filter(e => e.r && e.r.some(rr => { const b = boxOf([rr]); return boxHit(b, area.box) && (area.samples.some(p => pip(p[0], p[1], rr)) || inRings(e.c[0], e.c[1], area.rings)); }))
      .map(e => ({ tipo: e.tipo, d0: e.d0, d1: e.d1, ha: e.ha, id: e.id, desm: e.desm, veg: e.veg }));
    R.inpe.forEach(e => { if (/inc[eê]ndio/i.test(e.tipo)) flag(2, 'O INPE classificou um evento de fogo nesta área como incêndio (' + br(e.d0) + ' a ' + br(e.d1) + ').'); });

    // --- recurrence 2003–2025
    if (L.REC) {
      const G = L.REC.g, [ox, oy] = L.REC.origin, set = new Set(), cells = new Map(L.REC.itens.map(c => [c[0] + ',' + c[1], c[2]]));
      area.samples.forEach(p => set.add(Math.round((p[0] - ox) / G) + ',' + Math.round((p[1] - oy) / G)));
      let bits = 0; set.forEach(k => { bits |= cells.get(k) || 0; });
      const years = L.REC.anos.filter(y => bits & (1 << (y - L.REC.ano0)));
      R.rec = { years, total: L.REC.anos.length, from: L.REC.anos[0], to: L.REC.anos[L.REC.anos.length - 1] };
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
        if ((k && codes.has(k)) || (near != null && near <= 3)) R.asv.push({ num: a[0], em: a[1], val: a[2], car: a[4], fin: a[5], ha: a[6], sit: a[7], org: a[8], km: near, sameCar: k && codes.has(k) }); });
      const ref = area.date1 || area.date;
      R.asvValid = R.asv.filter(a => a.sameCar && a.em && a.val && a.em <= ref && a.val >= addDays(area.date, -365));
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
    h += '<p class="rep-kick">Fogo em Roraima 3D · relatório técnico da área</p><h1>' + esc(area.title) + (R.mun ? ' · ' + esc(R.mun) : '') + '</h1>';
    h += '<p class="rep-sub">Relatório nº <b>' + esc(code) + '</b> · gerado em ' + esc(gen) + ' (horário de Roraima) · fogororaima.com.br<br>Fonte da área: ' + esc(area.source) + ' · data de referência <b>' + br(area.date) + '</b>' + (area.date1 && area.date1 !== area.date ? ' a <b>' + br(area.date1) + '</b>' : '') + '</p>';
    const main = R.img && (R.img.figs.post || R.img.figs.now || R.img.figs.pre);
    if (main) h += '<img class="ar-hero" src="' + main + '" alt="Imagem de satélite da área com o contorno em amarelo">';

    // 1. summary
    h += H2(1, 'Resumo');
    h += '<div class="ar-verdict ar-' + verdict[0] + '"><b>' + esc(verdict[1]) + '</b><span>' + esc(verdict[2]) + '</span></div>';
    const sumTxt = [];
    const clsTxt = area.cls && area.cls.toLowerCase() !== area.title.toLowerCase() ? area.cls : '';
    sumTxt.push('Área de ' + haTxt(ha) + ' (' + esc(area.title.toLowerCase()) + (clsTxt ? ', ' + esc(clsTxt) : '') + ') ' + (R.mun ? 'em ' + esc(R.mun) : 'em Roraima') + ', registrada por ' + esc(area.source) + ' em ' + br(area.date) + '.');
    if (R.burned != null && R.img.sev.cover >= 0.5) sumTxt.push('As imagens Sentinel-2 de ' + br(R.img.pre.date) + ' e ' + br(R.img.post.date) + ' mostram ' + (isDesm(area) ? 'perda de vegetação' : 'sinal de queima') + ' em cerca de ' + haTxt(R.burned) + ' dentro do contorno.');
    if (R.fireStats) sumTxt.push('Satélites detectaram ' + nf(R.fireStats.n) + ' focos de calor na área ou a até 500 m, entre ' + esc(R.fireStats.first) + ' e ' + esc(R.fireStats.last) + '.');
    if (R.rec) sumTxt.push('Historicamente, o local teve fogo em ' + R.rec.years.length + ' dos ' + R.rec.total + ' anos entre ' + R.rec.from + ' e ' + R.rec.to + '.');
    if (R.car.length) sumTxt.push(nf(R.car[0].sh * 100, 0) + '% da área está no imóvel do CAR ' + esc(R.car[0].cod) + (R.car.length > 1 ? ' (e mais ' + (R.car.length - 1) + ')' : '') + '.');
    else if (R.carNone) sumTxt.push('A área não está dentro de nenhum imóvel declarado no CAR.');
    h += '<p>' + sumTxt.join(' ') + '</p>';
    if (R.flags.length) h += '<ul class="ar-flags">' + R.flags.map(([l, t]) => '<li class="ar-' + LEVEL[l][0] + '"><b>' + LEVEL[l][1] + '.</b> ' + esc(t) + '</li>').join('') + '</ul>';
    h += note('Indícios vêm do cruzamento automático de dados públicos de satélite e cadastros. Não são prova nem acusação contra ninguém: só a fiscalização, com vistoria e consulta às autorizações, confirma uma infração.');

    // 2. identification
    h += H2(2, 'Identificação e localização');
    h += T([['Tipo', esc(area.title) + (clsTxt ? ' · ' + esc(clsTxt) : '')], ['Fonte do contorno', esc(area.source)], ['Data de referência', br(area.date) + (area.date1 && area.date1 !== area.date ? ' a ' + br(area.date1) : '')],
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
      const capOf = (sc, lab) => sc ? lab + ': ' + br(sc.date) + ' · ' + nf(sc.clear * 100, 0) + '% da área sem nuvem' : lab;
      h += '<div class="ar-grid">' + fig('pre', capOf(I.pre, 'Antes')) + fig('post', capOf(I.post, I.post && I.post.during ? 'Durante o fogo' : 'Depois')) + fig('now', capOf(I.now, 'Hoje')) + fig('sev', (isDesm(area) ? 'Perda de vegetação' : 'Gravidade da queima') + ' (dNBR) dentro do contorno') + '</div>';
      if (I.sev) {
        const s = I.sev;
        h += '<table class="ar-sev"><tr><th>' + (isDesm(area) ? 'Mudança na vegetação (dNBR)' : 'Gravidade da queima (dNBR)') + '</th><th>Área</th><th>% medido</th></tr>' + s.classes.map(c => '<tr><td><i style="background:' + c.color + '"></i>' + esc(isDesm(area) ? (DESM_NAME[c.name] || c.name) : c.name) + '</td><td>' + haTxt(c.ha) + '</td><td>' + nf(c.pct * 100, 0) + '%</td></tr>').join('') + '</table>';
        h += note((isDesm(area) ? 'Em desmatamento, o dNBR mede a troca da floresta por solo exposto ou palha, com ou sem fogo; a queima se confirma pelos focos de calor e pela cor escura na imagem do depois. ' : '') + 'dNBR médio na área: <b>' + nf(s.mean, 2) + '</b>. Medido em ' + nf(s.cover * 100, 0) + '% dos pixels da área (o resto estava sob nuvem, sombra ou sem dado). Classes de Key e Benson (USGS FIREMON). Em lavrado e pasto a queima rebrota em semanas, então imagens distantes da data mostram gravidade menor que a real.');
      } else if (I.pre && !I.post) h += note('Não há imagem sem nuvem depois da data para medir a gravidade.');
      if (I.post && I.post.during) h += note('<b>Ainda não há imagem limpa depois do fim do fogo.</b> A segunda imagem é a de menos nuvem sobre a área desde o início do incêndio (' + br(I.post.date) + '), mesmo com nuvem ou fumaça. A gravidade medida com ela pode estar <b>subestimada</b>: gere o relatório de novo em alguns dias para ter a imagem do depois.');
      h += note('Sentinel-2 nível 2A (10 m), Copernicus/ESA, via Microsoft Planetary Computer.' + (I.hls ? ' Imagens de reserva: NASA HLS (30 m), via GIBS.' : '') + ' Contorno da área em amarelo; partes listradas em cinza ficaram fora da passagem do satélite (sem dado). Imagens escolhidas pela menor cobertura de nuvem sobre a própria área.');
    }

    // 4. fire history
    h += H2(4, 'Histórico do fogo no local');
    if (R.fireStats) {
      const f = R.fireStats;
      const inPer = R.fires.filter(x => { const d = A.dayOf(x.t); return d >= addDays(area.date, -3) && d <= addDays(area.date1 || area.date, 3); }).length;
      h += T([['Focos de calor desde dez/2025 (na área ou a até 500 m)', nf(f.n) + ' (' + nf(f.inside) + ' dentro do contorno)'], ['No período da área (' + br(addDays(area.date, -3)) + ' a ' + br(addDays(area.date1 || area.date, 3)) + ')', nf(inPer)], ['Primeiro e último', esc(f.first) + ' · ' + esc(f.last)], ['Dias com fogo', nf(f.days)],
        ['Detecções à noite (19h às 6h)', nf(f.night)], ['Maior potência (FRP)', nf(f.frpMax, 1) + ' MW'], ['Satélites', esc(f.sats.join(', '))]]);
    } else h += '<p>Nenhum foco de calor registrado na área desde dezembro de 2025 (início dos dados do mapa).</p>';
    if (R.inpe.length) h += '<p><b>Eventos de fogo do INPE na área:</b></p>' + T(R.inpe.map(e => [e.tipo + ' · nº ' + e.id, br(e.d0) + ' a ' + br(e.d1) + ' · ' + haTxt(e.ha) + (e.desm != null ? ' · ' + nf(e.desm, 0) + '% em área desmatada' : '')]));
    if (R.rec) {
      h += '<p><b>Anos com fogo no local, ' + R.rec.from + '–' + R.rec.to + '</b> (satélite de referência do INPE, quadrados de ~1 km):</p><div class="ar-years">' +
        Array.from({ length: R.rec.to - R.rec.from + 1 }, (_, k) => R.rec.from + k).map(y => '<span class="' + (R.rec.years.includes(y) ? 'on' : '') + '" title="' + y + '">' + String(y).slice(2) + '</span>').join('') + '</div>' +
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
    if (R.asv.length) h += '<p><b>Autorizações de supressão de vegetação (SINAFLOR) no imóvel ou a até 3 km:</b></p>' + T(R.asv.slice(0, 6).map(a => ['Nº ' + esc(a.num) + (a.sameCar ? ' · mesmo imóvel' : ' · a ' + kmTxt(a.km)), 'emitida ' + br(a.em) + ', válida até ' + br(a.val) + ' · ' + esc(a.fin) + (a.ha ? ' · ' + nf(a.ha, 1) + ' ha' : '') + ' · ' + esc(a.sit)]));
    else h += '<p>Nenhuma autorização de supressão de vegetação (SINAFLOR/IBAMA) registrada para o imóvel ou a até 3 km.</p>';
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
    '.ar-years{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0}.ar-years span{font:600 11px var(--f-data,monospace);padding:3px 4px;border-radius:3px;background:#eee9e2;color:#8a8279}.ar-years span.on{background:#c2410c;color:#fff}' +
    '.ar-rain{display:flex;align-items:flex-end;gap:2px;height:44px;margin-top:8px;border-bottom:1px solid #d9d3ca}.ar-rain span{flex:1;background:#3f86c6;border-radius:2px 2px 0 0;min-width:3px}' +
    '.ar-page td:last-child{white-space:normal}.ar-page td{overflow-wrap:anywhere}.ar-law{font-size:13px}' +
    '@media (max-width:560px){#report{padding:8px}.ar-page{padding:16px 14px 20px!important}.ar-page td{display:block;text-align:left!important;padding-left:0!important}.ar-page td:first-child{border-bottom:0;padding-bottom:0;color:#5a534b;font-size:12.5px}.ar-sev td{display:table-cell!important}.ar-page h1{font-size:22px}}' +
    '@media print{.ar-page h2{break-after:avoid}.ar-grid,.ar-sev,.ar-flags,.ar-verdict,table{break-inside:avoid}.ar-hero{max-width:380px}}';
  document.head.appendChild(css);

  window.FRR_AREA = { open, version: VERSION };
})();
