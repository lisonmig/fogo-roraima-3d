"""Extra data for the summary tab: air quality, INPE yearly history, INPE fire risk forecast and official notices.

Usage: python -I scripts/prep_extras.py <cache_dir> <out_dir>
Writes <out_dir>/ar.json, historico.json, risco.json and avisos.json. Each part fails on its own:
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



def main():
    cache_dir = sys.argv[1] if len(sys.argv) > 1 else 'dados-3d'
    out_dir = sys.argv[2] if len(sys.argv) > 2 else 'docs'
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'avisos.json')
    ok = True
    for part in (lambda: air(out_dir), lambda: history(out_dir), lambda: risco(cache_dir, out_dir), lambda: avisos(src, out_dir)):
        try:
            part()
        except Exception as e:
            ok = False
            print('falhou', e)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
