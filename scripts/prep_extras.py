"""Extra data for the summary tab: air quality, INPE yearly history, INPE fire risk forecast and official notices.

Usage: python -I scripts/prep_extras.py <cache_dir> <out_dir>
Writes <out_dir>/ar.json, historico.json, risco.json, avisos.json, impacto.json and medido.json. Each part fails on its own:
if a source is down, the previous file is kept and the site hides that block.
"""
import array
import json
import shutil
import struct
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

UA = {'User-Agent': 'fogo-roraima-3d (projeto de extensao UERR)'}

# municipal seats (approximate town centre); air quality is a ~40 km model, so this is enough
SEDES = [
    ('Boa Vista', 2.8235, -60.6758), ('Alto Alegre', 2.9886, -61.3075), ('Amajari', 3.6467, -61.3653),
    ('Bonfim', 3.3617, -59.8333), ('Cantá', 2.6097, -60.5983), ('Caracaraí', 1.8158, -61.1278),
    ('Caroebe', 0.8842, -59.6958), ('Iracema', 2.1833, -61.0417), ('Mucajaí', 2.4397, -60.9097),
    ('Normandia', 3.8853, -59.6228), ('Pacaraima', 4.4800, -61.1478), ('Rorainópolis', 0.9467, -60.4381),
    ('São João da Baliza', 0.9519, -59.9117), ('São Luiz', 1.0108, -60.0419), ('Uiramutã', 4.6031, -60.1814),
]


def get_json(url, tries=3, timeout=60):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:  # network hiccup: wait and try again
            err = e
            time.sleep(3 * (k + 1))
    raise err


def write(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)


def air(out_dir):
    # grid at the model's own spacing (0.4 degree, about 44 km), covering Roraima; the site picks the cell of the
    # marked point on the device, so no location is sent anywhere
    lats = [round(-1.6 + 0.4 * k, 1) for k in range(18)]   # -1.6 .. 5.2
    lons = [round(-64.8 + 0.4 * k, 1) for k in range(16)]  # -64.8 .. -58.8
    pts = [(la, lo) for la in lats for lo in lons]
    loc_now = datetime.now(timezone.utc).timestamp() - 4 * 3600  # Boa Vista local time, same as the API
    grid = []
    for k in range(0, len(pts), 60):
        part = pts[k:k + 60]
        url = ('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + ','.join(str(p[0]) for p in part) +
               '&longitude=' + ','.join(str(p[1]) for p in part) +
               '&hourly=pm2_5&past_days=1&forecast_days=2&timezone=America%2FBoa_Vista')
        data = get_json(url)
        if isinstance(data, dict):
            data = [data]
        for (la, lo), d in zip(part, data):
            t, v = d['hourly']['time'], d['hourly']['pm2_5']
            cur = max(i for i, x in enumerate(t) if datetime.fromisoformat(x).replace(tzinfo=timezone.utc).timestamp() <= loc_now)
            past = [x for x in v[max(0, cur - 23):cur + 1] if x is not None]
            nxt = [x for x in v[cur + 1:cur + 25] if x is not None]
            if not past:
                continue
            # lat, lon, mean of the last 24 h, mean of the next 24 h, worst hour of the last 24 h
            grid.append([la, lo, round(sum(past) / len(past), 1), round(sum(nxt) / len(nxt), 1) if nxt else None, round(max(past), 1)])
        time.sleep(1)
    write(os.path.join(out_dir, 'ar.json'), {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'fonte': 'Open-Meteo Air Quality (modelo Copernicus CAMS)', 'passo': 0.4,
        'seats': [[n, la, lo] for n, la, lo in SEDES], 'grid': grid})
    print('ar.json:', len(grid), 'pontos da grade')


def history(out_dir):
    d = get_json('https://data.inpe.br/queimadas/estatisticas/media/estatistica/paises/brasil.json', timeout=120)
    years = {}
    for r in d['historico_mensal']:
        if r['estado']['nome_estado'] != 'RORAIMA':
            continue
        m = years.setdefault(r['ano'], [0] * 12)
        for k, v in r['meses'].items():
            if v:
                m[int(k) - 1] += v
    meta = d['meta']
    write(os.path.join(out_dir, 'historico.json'), {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'ate': meta['data_limite'], 'ano': meta['ano_corrente'],
        'fonte': 'INPE, Programa Queimadas (satélite de referência)',
        'anos': {str(a): years[a] for a in sorted(years)}})
    print('historico.json:', len(years), 'anos, até', meta['data_limite'])


# ---------- INPE fire risk forecast (today and the next 3 days), GeoTIFF of South America at 0.01 degree
# small reader: tiled, LZW, one float band; only the tiles over Roraima are decoded


def lzw_decode(data):
    # TIFF LZW (MSB first, early change)
    out = bytearray()
    table = [bytes([i]) for i in range(256)] + [b'', b'']
    bits, pos, nbits, prev = 0, 0, 9, None
    buf, blen = 0, 0
    n = len(data)
    while True:
        while blen < nbits and pos < n:
            buf = (buf << 8) | data[pos]; pos += 1; blen += 8
        if blen < nbits:
            break
        code = (buf >> (blen - nbits)) & ((1 << nbits) - 1); blen -= nbits
        if code == 256:
            table = table[:258]; nbits = 9; prev = None; continue
        if code == 257:
            break
        if prev is None:
            entry = table[code]; out += entry; prev = entry; continue
        if code < len(table):
            entry = table[code]; table.append(prev + entry[:1])
        else:
            entry = prev + prev[:1]; table.append(entry)
        out += entry; prev = entry
        if len(table) + 1 >= (1 << nbits) and nbits < 12:
            nbits += 1
    return bytes(out)


class Tiff:
    def __init__(self, path):
        self.f = open(path, 'rb')
        h = self.f.read(8)
        self.bo = '<' if h[:2] == b'II' else '>'
        off = struct.unpack(self.bo + 'I', h[4:8])[0]
        self.f.seek(off)
        n = struct.unpack(self.bo + 'H', self.f.read(2))[0]
        ent = self.f.read(12 * n)
        sizes = {1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8}
        fmt = {1: 'B', 2: 's', 3: 'H', 4: 'I', 11: 'f', 12: 'd', 16: 'Q'}
        self.tags = {}
        for i in range(n):
            tag, typ, cnt = struct.unpack(self.bo + 'HHI', ent[12 * i:12 * i + 8])
            raw = ent[12 * i + 8:12 * i + 12]
            size = sizes[typ] * cnt
            if size > 4:
                self.f.seek(struct.unpack(self.bo + 'I', raw)[0]); raw = self.f.read(size)
            if typ == 2:
                self.tags[tag] = raw[:cnt].decode('latin-1')
            else:
                self.tags[tag] = struct.unpack(self.bo + fmt[typ] * cnt, raw[:size])
        t = self.tags
        self.W, self.H = t[256][0], t[257][0]
        self.tw, self.th = t[322][0], t[323][0]
        self.bps, self.comp = t[258][0], t[259][0]
        self.pred = t.get(317, (1,))[0]
        self.offs, self.cnts = t[324], t[325]
        sx, sy = t[33550][:2]
        self.sx, self.sy, self.x0, self.y0 = sx, sy, t[33922][3], t[33922][4]
        self.nodata = float(t[42113].strip('\x00')) if 42113 in t else None
        self.tpr = (self.W + self.tw - 1) // self.tw
        self.cache = {}

    def tile(self, tr, tc):
        k = tr * self.tpr + tc
        if k in self.cache:
            return self.cache[k]
        self.f.seek(self.offs[k]); raw = self.f.read(self.cnts[k])
        if self.comp == 5:
            raw = lzw_decode(raw)
        elif self.comp == 8 or self.comp == 32946:
            import zlib; raw = zlib.decompress(raw)
        typ = 'd' if self.bps == 64 else 'f'
        a = array.array(typ); a.frombytes(raw[:self.tw * self.th * a.itemsize])
        if (self.bo == '>') != (array.array('H', [1]).tobytes()[0] == 0):
            a.byteswap()
        if self.pred == 3:
            raise ValueError('floating point predictor not supported')
        self.cache[k] = a
        return a

    def at(self, lon, lat):
        c = int((lon - self.x0) / self.sx); r = int((self.y0 - lat) / self.sy)
        if not (0 <= c < self.W and 0 <= r < self.H):
            return None
        a = self.tile(r // self.th, c // self.tw)
        v = a[(r % self.th) * self.tw + (c % self.tw)]
        if v != v or (self.nodata is not None and v == self.nodata) or v < 0:
            return None
        return v


RF_URL = 'https://dataserver-coids.inpe.br/queimadas/queimadas/riscofogo_meteorologia/previsto/risco_fogo/RF.PREV.T{}.tif'
RF_BOX = (-64.85, -1.6, -58.85, 5.3)   # W, S, E, N (Roraima)
RF_STEP = 0.05                          # output cell, about 5.5 km
RF_CUTS = (0.15, 0.4, 0.7, 0.95)        # INPE classes: minimo, baixo, medio, alto, critico


def risco(cache_dir, out_dir):
    os.makedirs(cache_dir, exist_ok=True)
    meta_p = os.path.join(cache_dir, 'rf_meta.json')
    old = json.load(open(meta_p, encoding='utf-8')) if os.path.exists(meta_p) else {}
    mods = []
    for k in range(4):
        req = urllib.request.Request(RF_URL.format(k), headers=UA, method='HEAD')
        with urllib.request.urlopen(req, timeout=60) as r:
            mods.append(r.headers.get('Last-Modified', ''))
    out_p = os.path.join(out_dir, 'risco.json')
    if old.get('mods') == mods and os.path.exists(os.path.join(cache_dir, 'risco.json')):
        shutil.copyfile(os.path.join(cache_dir, 'risco.json'), out_p)   # same files as last time: nothing to do
        print('risco.json: sem mudança no INPE')
        return
    W, S, E, N = RF_BOX
    nx, ny = round((E - W) / RF_STEP), round((N - S) / RF_STEP)
    days = []
    for k in range(4):
        path = os.path.join(cache_dir, 'rf_T{}.tif'.format(k))
        for t in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(RF_URL.format(k), headers=UA), timeout=300) as r, open(path, 'wb') as fo:
                    shutil.copyfileobj(r, fo)
                break
            except Exception:
                if t == 2:
                    raise
                time.sleep(5)
        tif = Tiff(path)
        sub = int(round(RF_STEP / tif.sx))
        row = []
        for j in range(ny):
            lat0 = N - j * RF_STEP
            for i in range(nx):
                lon0 = W + i * RF_STEP
                vals = []
                for a in range(sub):
                    for b in range(sub):
                        v = tif.at(lon0 + (b + 0.5) * tif.sx, lat0 - (a + 0.5) * tif.sy)
                        if v is not None:
                            vals.append(v)
                if len(vals) < sub * sub // 3:   # mostly city, water or no data
                    row.append('.')
                else:
                    m = sum(vals) / len(vals)
                    row.append(str(sum(m > c for c in RF_CUTS)))
        days.append(''.join(row))
        tif.f.close()
        os.remove(path)   # 20 MB each: not worth keeping in the Actions cache
    # T0 is the day the files were made (Roraima time)
    from email.utils import parsedate_to_datetime
    d0 = (parsedate_to_datetime(mods[0]).timestamp() - 4 * 3600)
    data = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
            'fonte': 'INPE, Programa Queimadas (risco de fogo previsto)',
            'd0': datetime.fromtimestamp(d0, timezone.utc).strftime('%Y-%m-%d'),
            'box': [W, S, E, N], 'passo': RF_STEP, 'nx': nx, 'ny': ny, 'dias': days}
    write(out_p, data)
    shutil.copyfile(out_p, os.path.join(cache_dir, 'risco.json'))
    json.dump({'mods': mods}, open(meta_p, 'w', encoding='utf-8'))
    print('risco.json:', nx, 'x', ny, 'células, 4 dias, a partir de', data['d0'])


# ---------- official notices: typed by the team in avisos.json at the top of the repository (FEMARH, Defesa Civil...),
# always with the source link; an expired notice ("fim" before today) disappears by itself
def avisos(src_file, out_dir):
    out = []
    if os.path.exists(src_file):
        today = datetime.now(timezone.utc).timestamp() - 4 * 3600
        today = datetime.fromtimestamp(today, timezone.utc).strftime('%Y-%m-%d')
        for a in json.load(open(src_file, encoding='utf-8')).get('avisos', []):
            if a.get('fim') and a['fim'] < today:
                continue        # expired
            if not a.get('titulo') or not a.get('link'):
                continue        # a notice without its official source is not shown
            out.append(a)
    write(os.path.join(out_dir, 'avisos.json'), {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'avisos': out})
    print('avisos.json:', len(out), 'avisos')



# ---------- area with fire this year by type of land (VIIRS 375 m squares, each counted once), for the impact page
def impacto(out_dir):
    d = json.load(open(os.path.join(out_dir, 'roraima3d.json'), encoding='utf-8'))
    F = d['fires']
    t0 = datetime.fromisoformat(d['meta']['t0'].replace('Z', '+00:00'))
    year = datetime.now(timezone.utc).year
    y0 = (datetime(year, 1, 1, 4, tzinfo=timezone.utc) - t0).total_seconds() / 60   # 1 Jan, Roraima time
    seen, ti = {}, set()
    for i, t in enumerate(F['t']):
        if t < y0 or not F['v'][i]:
            continue
        k = (round(F['lat'][i] / 0.003375), round(F['lon'][i] / 0.003375))
        if k in seen:
            continue
        seen[k] = F['c'][i]
        if F['ti'][i] >= 0:
            ti.add(k)
    by = {}
    for c in seen.values():
        by[d['lc'][c]] = by.get(d['lc'][c], 0) + 1
    cell_ha = 14.06
    write(os.path.join(out_dir, 'impacto.json'), {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'ano': year,
        'ultimoFogo': d['meta'].get('lastFire'), 'haCelula': cell_ha,
        'totalHa': round(len(seen) * cell_ha), 'tiHa': round(len(ti) * cell_ha),
        'porTipo': {k: round(v * cell_ha) for k, v in sorted(by.items(), key=lambda x: -x[1])}})
    print('impacto.json:', round(len(seen) * cell_ha), 'ha com fogo em', year)


# ---------- measured weather, better than the model wherever it exists
# 1) Boa Vista airport (SBBV): METAR every hour (temperature, dew point, wind, gusts, visibility, smoke/haze)
# 2) ANA telemetry stations: rain measured every 15 minutes (the same stations used for the rivers)
# 3) CPTEC/INPE: official forecast for the 15 municipal seats, 4 days
CPTEC_IDS = {}   # filled once per run from the CPTEC city list


def get_text(url, timeout=60, enc='utf-8'):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read().decode(enc, errors='replace')


def _metar():
    data = get_json('https://aviationweather.gov/api/data/metar?ids=SBBV&format=json&hours=26')
    obs = []
    for m in data:
        if m.get('temp') is None:
            continue
        t, dp = m['temp'], m.get('dewp')
        rh = None
        if dp is not None:   # relative humidity from temperature and dew point (Magnus)
            import math
            rh = round(100 * math.exp(17.625 * dp / (243.04 + dp)) / math.exp(17.625 * t / (243.04 + t)))
        kt = 1.852
        vis = m.get('visib')
        obs.append({'t': m.get('reportTime'), 'tc': t, 'rh': rh,
                    'wd': m.get('wdir') if isinstance(m.get('wdir'), (int, float)) else None,
                    'ws': round((m.get('wspd') or 0) * kt), 'wg': round(m['wgst'] * kt) if m.get('wgst') else None,
                    'vis': vis, 'wx': m.get('wxString'), 'raw': m.get('rawOb')})
    obs.sort(key=lambda o: o['t'] or '')
    if not obs:
        return None
    last = obs[-1]
    temps = [o['tc'] for o in obs[-24:]]
    return {'nome': 'Aeroporto de Boa Vista', 'lat': 2.846, 'lon': -60.69, 'ultimo': last,
            'max24': max(temps), 'min24': min(temps)}


def _ana_rain(out_dir):
    st = json.load(open(os.path.join(out_dir, 'seca.json'), encoding='utf-8')).get('stations', [])
    end = datetime.now(timezone.utc)
    ini = datetime.fromtimestamp(end.timestamp() - 10 * 86400, timezone.utc)
    res = []
    import re
    for s_ in st:
        try:
            x = get_text('https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?codEstacao=' + s_['code'] +
                         '&dataInicio=' + ini.strftime('%d/%m/%Y') + '&dataFim=' + end.strftime('%d/%m/%Y'), 120)
        except Exception as e:
            print('ANA chuva', s_['code'], 'falhou:', e)
            continue
        rows = []
        for t, c in re.findall(r'<DataHora>([^<]+)</DataHora>.*?<Chuva>([^<]*)</Chuva>', x, re.S):
            if c.strip():
                rows.append((t.strip(), float(c)))
        if not rows:
            continue
        rows.sort()
        last_t = rows[-1][0]
        # station clock is Brasília time (UTC-3)
        lt = datetime.strptime(last_t[:19], '%Y-%m-%d %H:%M:%S').timestamp() + 3 * 3600
        def total(hours):
            lim = lt - hours * 3600
            return round(sum(v for t, v in rows if datetime.strptime(t[:19], '%Y-%m-%d %H:%M:%S').timestamp() + 3 * 3600 > lim), 1)
        by_day = {}
        for t, v in rows:
            by_day[t[:10]] = by_day.get(t[:10], 0) + v
        days = sorted(by_day)
        dry = 0
        for d in reversed(days):
            if by_day[d] >= 1:
                break
            dry += 1
        res.append({'code': s_['code'], 'n': s_.get('name'), 'rio': s_.get('river'), 'lat': s_['lat'], 'lon': s_['lon'],
                    'ultimo': last_t, 'c24': total(24), 'c72': total(72), 'c10d': round(sum(by_day.values()), 1),
                    'semChuva': dry, 'dias': len(days)})
        time.sleep(0.5)
    return res


def _cptec():
    import unicodedata
    plain = lambda x: unicodedata.normalize('NFKD', x).encode('ascii', 'ignore').decode().lower()
    out = []
    for nome, la, lo in SEDES:
        try:
            if nome not in CPTEC_IDS:
                xml = get_text('https://servicos.cptec.inpe.br/XML/listaCidades?city=' + urllib.request.quote(plain(nome)), 60, 'iso-8859-1')
                import re
                for n_, uf, i_ in re.findall(r'<nome>([^<]+)</nome><uf>([^<]+)</uf><id>(\d+)</id>', xml):
                    if uf == 'RR' and plain(n_) == plain(nome):
                        CPTEC_IDS[nome] = i_
                        break
            i_ = CPTEC_IDS.get(nome)
            if not i_:
                continue
            xml = get_text('https://servicos.cptec.inpe.br/XML/cidade/' + i_ + '/previsao.xml', 60, 'iso-8859-1')
            import re
            dias = [{'d': d, 't': t, 'max': int(mx), 'min': int(mn)} for d, t, mx, mn in
                    re.findall(r'<dia>([^<]+)</dia><tempo>([^<]+)</tempo><maxima>(-?\d+)</maxima><minima>(-?\d+)</minima>', xml)]
            if dias:
                out.append({'n': nome, 'lat': la, 'lon': lo, 'dias': dias})
        except Exception as e:
            print('CPTEC', nome, 'falhou:', e)
        time.sleep(0.3)
    return out


def medido(out_dir):
    res = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}
    for key, fn in (('metar', _metar), ('ana', lambda: _ana_rain(out_dir)), ('cptec', _cptec)):
        try:
            res[key] = fn()
        except Exception as e:
            print('medido', key, 'falhou:', e)
    write(os.path.join(out_dir, 'medido.json'), res)
    print('medido.json: aeroporto', 'ok' if res.get('metar') else 'sem dados', '· ANA', len(res.get('ana') or []), 'estações · CPTEC', len(res.get('cptec') or []), 'cidades')



# ---------- news: official notices (gov.br, rr.gov.br) go automatically to 'Avisos'; press goes to 'Na imprensa'.
# Only title, source, date and link are stored (the text belongs to the newspaper). Old items disappear by themselves.
NEWS_KEYS = r'queimad|inc[eê]ndi|fogo|focos? de calor|estiagem|\bseca\b|fuma[cç]a|emerg[eê]ncia|defesa civil|el ni[nñ]o|brigad|n[ií]vel do rio|rio branco|qualidade do ar|chuva'
NEWS_PLACES = r'roraima|\bRR\b|boa vista|bonfim|cant[aá]|normandia|uiramut[aã]|pacaraima|amajari|alto alegre|mucaja[ií]|iracema|caracara[ií]|rorain[oó]polis|caroebe|s[aã]o jo[aã]o da baliza|s[aã]o luiz|yanomami|raposa serra do sol'
RR_PRESS = ('folhabv.com.br', 'roraima1.com.br', 'g1.globo.com/rr', 'roraimaemfoco', 'jornalroraimahoje', 'agenciagov', 'diariorr', 'seligaroraima', 'ncnews.com.br')


def _rss_items(url):
    import re
    from email.utils import parsedate_to_datetime
    import html as H
    x = get_text(url, 60)
    out = []
    for it in re.findall(r'<item>(.*?)</item>', x, re.S):
        g = lambda tag: (re.search(r'<' + tag + r'[^>]*>(.*?)</' + tag + '>', it, re.S) or [None, ''])[1]
        title = H.unescape(re.sub(r'<!\[CDATA\[|\]\]>', '', g('title'))).strip()
        link = H.unescape(re.sub(r'<!\[CDATA\[|\]\]>', '', g('link'))).strip()
        src = re.search(r'<source url="([^"]+)">(.*?)</source>', it, re.S)
        src_url, src_name = (src.group(1), H.unescape(src.group(2)).strip()) if src else ('', '')
        try:
            when = parsedate_to_datetime(g('pubDate').strip()).astimezone(timezone.utc)
        except Exception:
            continue
        if src_name and title.endswith(' - ' + src_name):
            title = title[: -len(' - ' + src_name)]
        out.append({'t': title, 'link': link, 'fonte': src_name, 'fonteUrl': src_url, 'quando': when})
    return out


def noticias(out_dir):
    import re
    from urllib.parse import quote
    now = datetime.now(timezone.utc)
    items = []
    q1 = 'Roraima (queimada OR incêndio OR "focos de calor" OR estiagem OR fumaça OR "Defesa Civil" OR "situação de emergência")'
    q2 = '(site:rr.gov.br OR site:gov.br) Roraima (queimada OR incêndio OR estiagem OR emergência OR fumaça)'
    for q in (q1, q2):
        try:
            items += _rss_items('https://news.google.com/rss/search?q=' + quote(q) + '&hl=pt-BR&gl=BR&ceid=BR:pt-419')
        except Exception as e:
            print('noticias google', e)
    try:   # Defesa Civil Nacional / Ministério da Integração: recognitions of emergency
        for it in _rss_items('https://www.gov.br/mdr/pt-br/noticias/RSS'):
            it['fonte'] = it['fonte'] or 'Ministério da Integração e do Desenvolvimento Regional'
            it['fonteUrl'] = it['fonteUrl'] or 'https://www.gov.br/mdr'
            items.append(it)
    except Exception as e:
        print('noticias mdr', e)
    seen, of, im = set(), [], []
    for it in sorted(items, key=lambda x: x['quando'], reverse=True):
        age_d = (now - it['quando']).total_seconds() / 86400
        t = it['t']
        if not t or age_d > 10 or age_d < -1:
            continue
        if not re.search(NEWS_KEYS, t, re.I):
            continue
        u = (it['fonteUrl'] or '').lower()
        official = '.gov.br' in u or u.endswith('gov.br') or 'rr.gov.br' in u
        local = any(p in u for p in RR_PRESS)
        if not re.search(NEWS_PLACES, t, re.I) and not (local or 'rr.gov.br' in u):
            continue   # nothing to do with Roraima
        key = re.sub(r'\W+', ' ', t.lower()).strip()[:80]
        if key in seen:
            continue
        seen.add(key)
        row = {'t': t, 'fonte': it['fonte'], 'link': it['link'], 'data': it['quando'].strftime('%Y-%m-%dT%H:%MZ')}
        if official and age_d <= 7 and len(of) < 4:
            of.append(row)
        elif not official and age_d <= 5 and len(im) < 6:
            im.append(row)
    write(os.path.join(out_dir, 'noticias.json'), {'generated': now.strftime('%Y-%m-%dT%H:%MZ'), 'oficiais': of, 'imprensa': im})
    print('noticias.json:', len(of), 'oficiais,', len(im), 'na imprensa')



# ---------- Diário Oficial do Estado de Roraima: official acts (portarias, decretos) about fire, burning, drought, emergency.
# Each new edition is read once (cache); the newest act of each subject stays until its end date; an extension replaces the older act.
DOE_BASE = 'https://www.imprensaoficial.rr.gov.br'
DOE_KEYS = r'uso do fogo|fogo controlado|queima controlada|queimadas?\b|inc[eê]ndios? florest|situa[cç][aã]o de emerg[eê]ncia|estiagem|calend[aá]rio de queima'
DOE_ACT = r'(?m)^\s*((?:PORTARIA|DECRETO|RESOLU[CÇ][AÃ]O)\s+N[ºo°.]*\s*[\d.]+[^\n]{0,60}?,?\s*DE\s+\d{1,2}\s+DE\s+[A-ZÇ]+\s+DE\s+\d{4})'
MESES_PT = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO']


def _doe_opener():
    import http.cookiejar
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def _doe_editions(op, ano, mes):
    import re
    page = DOE_BASE + '/_visualizar-mes/?ano=%d&mes=%02d' % (ano, mes)
    x = op.open(urllib.request.Request(page, headers=UA), timeout=60).read().decode('utf-8', 'replace')
    out = []
    for form in re.findall(r'<form role="form" action="../_visualizar-doe/".*?</form>', x, re.S):
        kv = dict(re.findall(r'name="([^"]+)" value="([^"]*)"', form))
        if kv.get('doe'):
            out.append((kv, page))
    return out


def _doe_pdf(op, kv, page):
    from urllib.parse import urlencode
    req = urllib.request.Request(DOE_BASE + '/_visualizar-doe/', data=urlencode(kv).encode(), headers=dict(UA, Referer=page))
    b = op.open(req, timeout=240).read()
    return b if b[:4] == b'%PDF' else None


def _doe_acts(pdf_bytes, name, page_url):
    import io, re
    from datetime import date, timedelta
    from pypdf import PdfReader
    pages = [(p.extract_text() or '') for p in PdfReader(io.BytesIO(pdf_bytes)).pages]
    full, starts = '', []
    for t in pages:
        starts.append(len(full)); full += t + '\n'
    ed = re.search(r'Edição N°:\s*(\d+)', full)
    y, m, d_ = int(name[-12:-8]), int(name[-8:-6]), int(name[-6:-4])
    pub = date(y, m, d_)
    marks = list(re.finditer(DOE_ACT, full))
    acts = []
    for i, mk in enumerate(marks):
        block = full[mk.start(): marks[i + 1].start() if i + 1 < len(marks) else mk.start() + 4000][:4000]
        if not re.search(DOE_KEYS, block, re.I):
            continue
        art = re.search(r'Art\.?\s*1[ºo°]?\s*[-–.]?\s*(.{20,500}?\.)\s', block, re.S)
        art_txt = re.sub(r'\s+', ' ', art.group(1)).strip() if art else ''
        if not art_txt or not re.search(DOE_KEYS, art_txt + ' ' + block[:600], re.I):
            continue
        head = re.sub(r'\s+', ' ', mk.group(1)).strip()
        hd = re.search(r'DE\s+(\d{1,2})\s+DE\s+([A-ZÇ]+)\s+DE\s+(\d{4})', head)
        act_date = date(int(hd.group(3)), MESES_PT.index(hd.group(2)) + 1, int(hd.group(1))) if hd and hd.group(2) in MESES_PT else pub
        low = block.lower()
        tipo = 'queima' if re.search(r'uso do fogo|fogo controlado|queima', low) else 'emergencia' if re.search(r'emerg[eê]ncia|estiagem', low) else 'fogo'
        fim = None
        mm = re.search(r'por\s+(\d+)\s*(?:\([^)]*\))?\s*dias\s*,?\s*a\s+(?:contar|partir)\s+d[oa]?\s*(?:dia\s+)?(\d{1,2})[./](\d{1,2})[./](\d{4})', art_txt, re.I)
        if mm:
            fim = date(int(mm.group(4)), int(mm.group(3)), int(mm.group(2))) + timedelta(days=int(mm.group(1)) - 1)
        else:
            mm = re.search(r'(\d+)\s*\([^)]*\)\s*dias|por\s+(\d+)\s+dias|(cento e oitenta)\s+dias', block, re.I)
            n = int(mm.group(1) or mm.group(2)) if mm and (mm.group(1) or mm.group(2)) else 180 if mm else None
            if n is None and tipo == 'emergencia':
                n = 180
            if n:
                fim = act_date + timedelta(days=n)
        orgao = 'FEMARH' if 'FEMARH' in head.upper() else 'Governo de Roraima' if head.upper().startswith('DECRETO') else 'Diário Oficial de RR'
        page_no = max(k for k, st in enumerate(starts) if st <= mk.start()) + 1
        acts.append({'ato': head, 'orgao': orgao, 'tipo': tipo, 'prorroga': 'PRORROG' in block.upper(),
                     'resumo': art_txt[:420], 'dataAto': act_date.isoformat(), 'pub': pub.isoformat(),
                     'edicao': ed.group(1) if ed else '', 'pagina': page_no, 'fim': fim.isoformat() if fim else None, 'link': page_url})
    return acts


def doe_rr(cache_dir, out_dir):
    from datetime import date
    cpath = os.path.join(cache_dir, 'doe_cache.json')
    cache = json.load(open(cpath, encoding='utf-8')) if os.path.exists(cpath) else {'lidas': [], 'atos': []}
    op = _doe_opener()
    today = datetime.now(timezone.utc).date()
    months = [(today.year, today.month), (today.year if today.month > 1 else today.year - 1, today.month - 1 if today.month > 1 else 12)]
    new = 0
    for ano, mes in months:
        try:
            eds = _doe_editions(op, ano, mes)
        except Exception as e:
            print('DOE lista', ano, mes, 'falhou:', e)
            continue
        for kv, page in eds:
            name = kv['doe']
            if name in cache['lidas'] or new >= 8:
                continue
            try:
                pdf = _doe_pdf(op, kv, page)
                if pdf:
                    cache['atos'] += _doe_acts(pdf, name, page)
                cache['lidas'].append(name)
                new += 1
            except Exception as e:
                print('DOE', name, 'falhou:', e)
                new += 1   # a failure also counts, so a broken run never downloads every edition
            time.sleep(1)
    cache['lidas'] = cache['lidas'][-120:]
    # newest act per subject (an extension replaces the older act); drop expired ones
    best = {}
    for a in sorted(cache['atos'], key=lambda a: (a['pub'], a['dataAto'])):
        best[a['tipo']] = a
    vivos = [a for a in best.values() if not a['fim'] or a['fim'] >= today.isoformat()]
    cache['atos'] = [a for a in cache['atos'] if (a['fim'] or a['pub']) >= (today.replace(day=1)).isoformat() or a in vivos][-200:]
    json.dump(cache, open(cpath, 'w', encoding='utf-8'), ensure_ascii=False)
    write(os.path.join(out_dir, 'doe.json'), {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'atos': vivos})
    print('doe.json:', len(vivos), 'atos em vigor;', new, 'edições novas lidas')



def main():
    cache_dir = sys.argv[1] if len(sys.argv) > 1 else 'dados-3d'
    out_dir = sys.argv[2] if len(sys.argv) > 2 else 'docs'
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'avisos.json')
    ok = True
    for part in (lambda: air(out_dir), lambda: history(out_dir), lambda: risco(cache_dir, out_dir), lambda: avisos(src, out_dir), lambda: impacto(out_dir), lambda: medido(out_dir), lambda: noticias(out_dir), lambda: doe_rr(cache_dir, out_dir)):
        try:
            part()
        except Exception as e:
            ok = False
            print('falhou', e)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
