"""Prepares data for the Roraima 3D fire map.
usage: python prep3d.py <raw_dir> <out_dir>
Downloads INPE daily fire CSVs, Terrarium elevation tiles, Sentinel-2 cloudless imagery
(EOX) and hourly weather (Open-Meteo), then writes compact files for the page."""
import csv, io, json, math, os, sys, datetime as dt, urllib.request, urllib.parse, collections
import numpy as np
from PIL import Image

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
W, E, S, N = -61.8, -59.2, 1.8, 5.3
D0, D1 = dt.date(2026, 10, 9), dt.date(2026, 11, 8)
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}

def get(url, path=None, timeout=180):
    if path and os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, 'rb').read()
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        data = r.read()
    if path:
        open(path, 'wb').write(data)
    return data

# ---------------- fires
VIIRS = {'NOAA-20', 'NOAA-21', 'NPP-375', 'NPP-375D'}
rows, seen = [], set()
d = D0
while d <= D1:
    tag = d.strftime('%Y%m%d')
    p = os.path.join(RAW, f'focos_{tag}.csv')
    try:
        get(f'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_{tag}.csv', p)
    except Exception as e:
        print('missing', tag, e)
    if os.path.exists(p):
        for r in csv.DictReader(open(p, encoding='utf-8')):
            lat, lon = float(r['lat']), float(r['lon'])
            if not (S <= lat <= N and W <= lon <= E) or r['id'] in seen:
                continue
            seen.add(r['id'])
            rows.append(r)
    d += dt.timedelta(days=1)
print('fires in bbox', len(rows))

t0 = dt.datetime(D0.year, D0.month, D0.day)
sats, muns = [], []
si, mi = {}, {}
def ix(v, lst, dd):
    if v not in dd: dd[v] = len(lst); lst.append(v)
    return dd[v]
SMALL = {'de', 'da', 'do', 'das', 'dos', 'e'}
def title(s):
    ps = s.strip().lower().split(' ')
    return ' '.join(w if (i and w in SMALL) else w[:1].upper() + w[1:] for i, w in enumerate(ps))

rows.sort(key=lambda r: r['data_hora_gmt'])
F = {k: [] for k in 'lat lon t s m f d r v'.split()}
for r in rows:
    t = dt.datetime.strptime(r['data_hora_gmt'], '%Y-%m-%d %H:%M:%S')
    F['lat'].append(round(float(r['lat']), 4)); F['lon'].append(round(float(r['lon']), 4))
    F['t'].append(int((t - t0).total_seconds() // 60))
    F['s'].append(ix(r['satelite'], sats, si))
    F['m'].append(ix(title(r['municipio']) + ' – ' + ('RR' if r['estado_id'] == '14' else r['estado']), muns, mi))
    fr = r['frp'].strip(); F['f'].append(round(float(fr), 1) if fr else -1)
    dd = r['numero_dias_sem_chuva'].strip(); F['d'].append(int(float(dd)) if dd and float(dd) >= 0 else -1)
    rr = r['risco_fogo'].strip(); F['r'].append(round(float(rr), 2) if rr and float(rr) >= 0 else -1)
    F['v'].append(1 if r['satelite'] in VIIRS else 0)

# ---- fire events: VIIRS detections linked within 1.2 km and 48 h (union-find)
vi = [i for i in range(len(rows)) if F['v'][i]]
parent = {i: i for i in vi}
def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]; a = parent[a]
    return a
cell = 0.011  # ~1.2 km grid buckets
buckets = collections.defaultdict(list)
for i in vi:
    buckets[(int(F['lat'][i] / cell), int(F['lon'][i] / cell))].append(i)
for (a, b), lst in buckets.items():
    neigh = []
    for da in (-1, 0, 1):
        for db in (-1, 0, 1):
            neigh += buckets.get((a + da, b + db), [])
    for i in lst:
        for j in neigh:
            if j <= i: continue
            dy = (F['lat'][i] - F['lat'][j]) * 111.2
            dx = (F['lon'][i] - F['lon'][j]) * 111.2 * math.cos(math.radians(F['lat'][i]))
            if dx * dx + dy * dy <= 1.44 and abs(F['t'][i] - F['t'][j]) <= 2880:
                ra, rb = find(i), find(j)
                if ra != rb: parent[ra] = rb
groups = collections.defaultdict(list)
for i in vi: groups[find(i)].append(i)
events = []
for g in groups.values():
    cells = {(round(F['lat'][i] / 0.003375), round(F['lon'][i] / 0.003375)) for i in g}
    area = len(cells) * 0.1406  # 375 m pixels, km2
    mun = collections.Counter(F['m'][i] for i in g).most_common(1)[0][0]
    frps = [F['f'][i] for i in g if F['f'][i] >= 0]
    events.append({'n': len(g), 'area': round(area, 2), 'start': min(F['t'][i] for i in g),
                   'end': max(F['t'][i] for i in g), 'lat': round(sum(F['lat'][i] for i in g) / len(g), 4),
                   'lon': round(sum(F['lon'][i] for i in g) / len(g), 4), 'm': mun,
                   'frpMax': max(frps) if frps else -1})
events.sort(key=lambda e: -e['area'])
print('events', len(events), events[:3])

# ---------------- terrain (Terrarium, z10) resampled to a lon/lat grid
Z = 10
def tile_xy(lon, lat):
    n = 2 ** Z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y
x0, y0 = tile_xy(W, N); x1, y1 = tile_xy(E, S)
tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
tdir = os.path.join(RAW, 'terrarium'); os.makedirs(tdir, exist_ok=True)
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        data = get(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png',
                   os.path.join(tdir, f'{Z}_{tx}_{ty}.png'))
        a = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'), dtype=np.float32)
        h = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = h
GW, GH = 640, 862  # grid ~450 m
lons = np.linspace(W, E, GW); lats = np.linspace(N, S, GH)
px = np.array([tile_xy(l, 0)[0] for l in lons]) - tx0
py = np.array([tile_xy(0, l)[1] for l in lats]) - ty0
PX, PY = np.meshgrid(px * 256, py * 256)
ix0 = np.clip(PX.astype(int), 0, mosaic.shape[1] - 2); iy0 = np.clip(PY.astype(int), 0, mosaic.shape[0] - 2)
fx, fy = PX - ix0, PY - iy0
elev = (mosaic[iy0, ix0] * (1 - fx) * (1 - fy) + mosaic[iy0, ix0 + 1] * fx * (1 - fy) +
        mosaic[iy0 + 1, ix0] * (1 - fx) * fy + mosaic[iy0 + 1, ix0 + 1] * fx * fy)
elev = np.clip(elev, 0, 3000)
print('elev range', elev.min(), elev.max())
enc = np.round(elev).astype(np.uint16)
img = np.zeros((GH, GW, 3), dtype=np.uint8)
img[..., 0] = enc >> 8; img[..., 1] = enc & 255
Image.fromarray(img, 'RGB').save(os.path.join(OUT, 'relevo.png'), optimize=True)

# ---------------- imagery: Sentinel-2 cloudless 2025 (EOX), EPSG:4326
IW, IH = 2048, round(2048 * (N - S) / (E - W))
q = urllib.parse.urlencode({'service': 'WMS', 'request': 'GetMap', 'version': '1.1.1',
    'layers': 's2cloudless-2025', 'styles': '', 'srs': 'EPSG:4326',
    'bbox': f'{W},{S},{E},{N}', 'width': IW, 'height': IH, 'format': 'image/jpeg'})
data = get('https://tiles.maps.eox.at/wms?' + q, os.path.join(RAW, 's2_2025.jpg'), timeout=300)
im = Image.open(io.BytesIO(data)).convert('RGB')
print('imagery', im.size)
im.save(os.path.join(OUT, 'imagem.jpg'), quality=86, optimize=True, progressive=True)

# ---------------- weather grid (Open-Meteo), hourly
WC, WR = 4, 5
wl = [round(W + (E - W) * (i + .5) / WC, 3) for i in range(WC)]
wt = [round(N - (N - S) * (j + .5) / WR, 3) for j in range(WR)]
pts = [(la, lo) for la in wt for lo in wl]
url = 'https://api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode({
    'latitude': ','.join(str(p[0]) for p in pts), 'longitude': ','.join(str(p[1]) for p in pts),
    'hourly': 'wind_speed_10m,wind_direction_10m,relative_humidity_2m,temperature_2m',
    'past_days': 31, 'forecast_days': 1, 'timezone': 'GMT'})
wx = json.loads(get(url, os.path.join(RAW, 'weather.json')))
hours = int((dt.datetime(D1.year, D1.month, D1.day, 23) - t0).total_seconds() // 3600) + 1
times = wx[0]['hourly']['time']
start_idx = times.index(t0.strftime('%Y-%m-%dT%H:%M'))
def series(key, scale):
    return [[round((p['hourly'][key][start_idx + h] or 0) * scale) for p in wx] for h in range(hours)]
weather = {'cols': WC, 'rows': WR, 'lats': wt, 'lons': wl, 'hours': hours,
           'ws': series('wind_speed_10m', 10), 'wd': series('wind_direction_10m', 1),
           'rh': series('relative_humidity_2m', 1), 'tc': series('temperature_2m', 10)}

meta = {'bbox': [W, S, E, N], 't0': t0.strftime('%Y-%m-%dT%H:%MZ'), 'days': (D1 - D0).days + 1,
        'grid': [GW, GH], 'elevMax': float(elev.max()),
        'imagery': 'Sentinel-2 cloudless 2025 (EOX)', 'generated': dt.datetime.utcnow().strftime('%Y-%m-%dT%H:%MZ'),
        'lastFire': rows[-1]['data_hora_gmt'] if rows else None}
json.dump({'meta': meta, 'sats': sats, 'muns': muns, 'fires': F, 'events': events[:60], 'weather': weather},
          open(os.path.join(OUT, 'roraima3d.json'), 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
for n in os.listdir(OUT):
    print(n, os.path.getsize(os.path.join(OUT, n)))
