// Anos passados (2003 em diante): focos do satélite de referência do INPE (rel/anos/<ano>.json) e imagem da NASA.
// Carregado só quando alguém escolhe um ano em "Outras datas". A imagem só é baixada quando pedida.
window.FRR_ANOS = (() => {
  const MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const MES_L = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const CAMADAS = ['lyFire', 'lyPer', 'lyInpe', 'lyScar', 'lyWind', 'lyRios']; // o que mostra o presente fica escondido enquanto se vê outro ano
  let A = null, S = null, run = 0;

  const nf = n => n.toLocaleString('pt-BR');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iso = (y, doy) => new Date(Date.UTC(y, 0, doy)).toISOString().slice(0, 10);
  const br = d => d.split('-').reverse().join('/');
  const addD = (d, n) => new Date(Date.parse(d + 'T00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) if ((r[i + 1] > y) !== (r[j + 1] > y) && x < (r[j] - r[i]) * (y - r[i + 1]) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; return c; };
  function boxes(list) {
    return list.map(m => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const r of m.r) for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); c = Math.max(c, r[i]); b = Math.min(b, r[i + 1]); d = Math.max(d, r[i + 1]); } return { m, a, b, c, d }; });
  }
  const hit = (bx, x, y) => { for (let k = 0; k < bx.length; k++) { const q = bx[k]; if (x >= q.a && x <= q.c && y >= q.b && y <= q.d && q.m.r.some(r => inRing(r, x, y))) return k; } return -1; };

  function dot() {
    const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
    const g = x.createRadialGradient(16, 16, 2, 16, 16, 15); g.addColorStop(0, '#fff3c4'); g.addColorStop(0.35, '#ff9a2e'); g.addColorStop(0.8, '#e8380f'); g.addColorStop(1, 'rgba(232,56,15,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 32); return new A.THREE.CanvasTexture(c);
  }

  function reset() {
    run++;
    if (!S) return;
    A.scene.remove(S.pts); S.pts.geometry.dispose(); S.pts.material.map.dispose(); S.pts.material.dispose();
    if (S.tex) S.tex.dispose();
    CAMADAS.forEach(id => { const el = A.$(id); if (S.saved[id] && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change')); } });
    A.applyBase(A.$('base').value);
    S = null;
  }
  function close() {
    if (!S && !document.body.classList.contains('hist-on')) { run++; return; }
    reset();
    document.body.classList.remove('hist-on');
    const b = A.$('histBar'); b.hidden = true; b.innerHTML = '';
  }

  async function open(y, api) {
    A = api; reset();
    const me = run, bar = A.$('histBar');
    document.body.classList.add('hist-on'); bar.hidden = false;
    bar.innerHTML = '<div class="hist-top"><b>Fogo em ' + y + '</b><span>Carregando os focos…</span><button type="button" class="hist-back" data-h="back">Voltar para hoje</button></div>';
    bar.onclick = onClick; bar.onchange = onChange;
    let J = null;
    try { const r = await fetch('rel/anos/' + y + '.json', { cache: 'force-cache' }); if (r.ok) J = await r.json(); } catch (e) {}
    if (me !== run) return;
    if (!J || !J.f) { bar.querySelector('.hist-top span').textContent = 'Os dados de ' + y + ' ainda não estão disponíveis.'; return; }
    build(y, J, me);
  }

  function build(y, J, me) {
    const n = J.f.length / 4, [ox, oy] = J.origin, g = J.g, ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => J.f[a * 4 + 2] - J.f[b * 4 + 2]);
    const pos = new Float32Array(n * 3), porMes = new Array(12).fill(0), porDia = new Map(), mes0 = new Array(13).fill(0);
    const munB = boxes(A.D.munis), tiB = boxes(A.D.tis), cel = new Map(), porMun = new Map(); let nTi = 0;
    ord.forEach((k, i) => {
      const ix = J.f[k * 4], iy = J.f[k * 4 + 1], doy = J.f[k * 4 + 2], lon = ox + ix * g, lat = oy + iy * g;
      pos[i * 3] = A.toX(lon); pos[i * 3 + 1] = A.yAt(lon, lat) + 0.6; pos[i * 3 + 2] = A.toZ(lat);
      const m = new Date(Date.UTC(y, 0, doy)).getUTCMonth(); porMes[m]++; porDia.set(doy, (porDia.get(doy) || 0) + 1);
      const key = ix * 10000 + iy; let c = cel.get(key);
      if (!c) { c = [hit(munB, lon, lat), hit(tiB, lon, lat) >= 0]; cel.set(key, c); }
      if (c[0] >= 0) porMun.set(c[0], (porMun.get(c[0]) || 0) + 1);
      if (c[1]) nTi++;
    });
    for (let m = 0, soma = 0; m < 12; m++) { mes0[m] = soma; soma += porMes[m]; mes0[m + 1] = soma; }
    const geo = new A.THREE.BufferGeometry(); geo.setAttribute('position', new A.THREE.BufferAttribute(pos, 3));
    const mat = new A.THREE.PointsMaterial({ size: A.LIGHT ? 7 : 9, sizeAttenuation: false, map: dot(), transparent: true, depthWrite: false, depthTest: false });
    const pts = new A.THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 7; A.scene.add(pts);
    const saved = {}; CAMADAS.forEach(id => { const el = A.$(id); saved[id] = el.checked; if (el.checked) { el.checked = false; el.dispatchEvent(new Event('change')); } });
    let pior = 1, piorN = 0; porDia.forEach((v, d) => { if (v > piorN) { pior = d; piorN = v; } });
    const top = [...porMun].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => esc(A.D.munis[k].nome) + ' (' + nf(v) + ')');
    S = { y, pts, saved, n, porMes, porDia, mes0, pior, piorN, top, nTi, mes: -1, tex: null };
    const alto = Math.max(...porMes, 1);
    A.$('histBar').innerHTML = '<div class="hist-top"><b>Fogo em ' + y + '</b><span>' + nf(n) + ' focos · satélite de referência do INPE</span><button type="button" class="hist-back" data-h="back">Voltar para hoje</button></div>' +
      '<div class="hist-months" role="group" aria-label="Escolher o mês">' + MES.map((m, k) => '<button type="button" data-m="' + k + '" aria-pressed="false" title="' + MES_L[k] + ': ' + nf(porMes[k]) + ' focos"><i style="height:' + Math.max(2, Math.round(porMes[k] / alto * 46)) + 'px"></i>' + m + '</button>').join('') + '</div>' +
      '<p class="hist-sum" id="histSum" aria-live="polite"></p>' +
      '<div class="hist-img"><label>Imagem de satélite perto de <input type="date" id="histDate" min="' + y + '-01-01" max="' + y + '-12-31" value="' + iso(y, pior) + '"></label><button type="button" data-h="img">Ver imagem</button></div>' +
      '<p class="hist-note" id="histNote">Conta só um satélite por tarde, o mesmo em todos os anos, para comparar. O mapa de hoje soma vários satélites e mostra números maiores.</p>';
    resumo();
  }

  function resumo() {
    const m = S.mes, el = A.$('histSum');
    if (m < 0) {
      el.innerHTML = (S.top.length ? 'Mais em ' + S.top.join(', ') + '. ' : '') + (S.n ? Math.round(S.nTi / S.n * 100) + '% em Terras Indígenas. ' : '') + 'Dia com mais focos: <b>' + br(iso(S.y, S.pior)).slice(0, 5) + '</b> (' + nf(S.piorN) + ').';
      S.pts.geometry.setDrawRange(0, S.n);
    } else {
      let d = 0, v = 0; S.porDia.forEach((q, k) => { if (new Date(Date.UTC(S.y, 0, k)).getUTCMonth() === m && q > v) { d = k; v = q; } });
      el.innerHTML = '<b>' + MES_L[m][0].toUpperCase() + MES_L[m].slice(1) + ' de ' + S.y + ':</b> ' + nf(S.porMes[m]) + ' focos' + (d ? '. Dia com mais focos: <b>' + br(iso(S.y, d)).slice(0, 5) + '</b> (' + nf(v) + ').' : '.');
      S.pts.geometry.setDrawRange(S.mes0[m], S.porMes[m]);
      if (d) A.$('histDate').value = iso(S.y, d);
    }
  }

  function onChange() { /* a data só vale quando a pessoa pede a imagem */ }
  function onClick(e) {
    const b = e.target.closest && e.target.closest('button'); if (!b) return;
    if (b.dataset.h === 'back') { A.back(); return; }
    if (b.dataset.h === 'img') { imagem(A.$('histDate').value, b); return; }
    if (b.dataset.m != null && S) {
      const k = +b.dataset.m; S.mes = S.mes === k ? -1 : k;
      A.$('histBar').querySelectorAll('[data-m]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.m === S.mes));
      resumo();
    }
  }

  // MODIS Terra (NASA GIBS), desde 2000. Um dia só tem faixas pretas e nuvens: junta 7 dias e fica, em cada ponto, com um valor limpo.
  function baixa(day, H, Wd) {
    return new Promise(ok => {
      const img = new Image(); let fim = false; const t = setTimeout(() => { if (!fim) { fim = true; ok(null); } }, 45000);
      img.crossOrigin = 'anonymous';
      img.onload = () => { if (!fim) { fim = true; clearTimeout(t); ok(img); } };
      img.onerror = () => { if (!fim) { fim = true; clearTimeout(t); ok(null); } };
      img.src = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&CRS=EPSG:4326&FORMAT=image/jpeg&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor&BBOX=' +
        [A.S, A.W, A.N, A.E].join(',') + '&WIDTH=' + Wd + '&HEIGHT=' + H + '&TIME=' + day;
    });
  }
  async function imagem(dia, btn) {
    if (!S || !dia) return;
    const me = run, note = A.$('histNote'), H = A.LIGHT ? 700 : 1400, Wd = Math.round(H * (A.E - A.W) / (A.N - A.S));
    btn.disabled = true; note.textContent = 'Baixando 7 dias de imagens da NASA…';
    const dias = [-3, -2, -1, 0, 1, 2, 3].map(k => addD(dia, k));
    const imgs = (await Promise.all(dias.map(d => baixa(d, H, Wd)))).filter(Boolean);
    if (me !== run) return;
    if (!imgs.length) { btn.disabled = false; note.textContent = 'Não foi possível baixar a imagem da NASA agora. Tente de novo.'; return; }
    const cv = document.createElement('canvas'); cv.width = Wd; cv.height = H; const x = cv.getContext('2d', { willReadFrequently: true });
    const dados = imgs.map(i => { x.clearRect(0, 0, Wd, H); x.drawImage(i, 0, 0, Wd, H); return x.getImageData(0, 0, Wd, H).data; });
    const out = x.createImageData(Wd, H), o = out.data, br_ = new Int32Array(dados.length), idx = new Int32Array(dados.length);
    let tk = performance.now();
    for (let r = 0, p = 0; r < H; r++) {
      for (let c = 0; c < Wd; c++, p += 4) {
        let q = 0;
        for (let k = 0; k < dados.length; k++) {
          const s = dados[k][p] + dados[k][p + 1] + dados[k][p + 2]; if (s < 30) continue; // faixa sem imagem
          let j = q++; while (j > 0 && br_[j - 1] > s) { br_[j] = br_[j - 1]; idx[j] = idx[j - 1]; j--; } br_[j] = s; idx[j] = k;
        }
        if (q) { const e = dados[idx[Math.floor((q - 1) * 0.35)]]; o[p] = e[p]; o[p + 1] = e[p + 1]; o[p + 2] = e[p + 2]; } else { o[p] = 24; o[p + 1] = 26; o[p + 2] = 24; }
        o[p + 3] = 255;
      }
      if (performance.now() - tk > 40) { note.textContent = 'Montando a imagem… ' + Math.round(r / H * 100) + '%'; await new Promise(f => setTimeout(f)); if (me !== run) return; tk = performance.now(); }
    }
    x.putImageData(out, 0, 0);
    if (S.tex) S.tex.dispose();
    S.tex = A.mkTex(cv);
    const u = A.terrainMat.uniforms; u.uMapOn.value = 1; u.uMap.value = S.tex; if (u.uDetOn) u.uDetOn.value = 0;
    btn.disabled = false;
    note.innerHTML = 'Imagem ilustrativa: junção de ' + imgs.length + ' dias (' + br(dias[0]) + ' a ' + br(dias[6]) + '), satélite MODIS Terra, cerca de 250 m. Nuvens podem continuar. Fonte: <a href="https://worldview.earthdata.nasa.gov/" target="_blank" rel="noopener">NASA Worldview</a>.';
  }

  return { open, close };
})();
