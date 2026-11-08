"""Prepares data for the 'Fogo em Roraima 3D' page: whole state of Roraima, Dec 2025 until now.
usage: python prep_rr.py <raw_dir> <out_dir> [--completo]
Only Roraima rows are kept in <raw_dir> (rr_*.csv). Yesterday, today and the weather are downloaded
again on every run. Terrain and imagery are rebuilt only when missing or with --completo.
Sources: INPE monthly fire CSVs, Terrarium elevation tiles, Sentinel-2 cloudless 2025 (EOX),
Open-Meteo historical forecast (wind/humidity/temperature), IBGE state boundary."""
import csv, io, json, math, os, sys, collections, datetime as dt, urllib.request, urllib.parse
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import box, shape, Polygon, MultiPolygon
from shapely.ops import unary_union

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
W, E, S, N = -64.85, -58.85, -1.6, 5.3
T0 = dt.datetime(2025, 12, 1)
TEND = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
# whole months from the monthly archive; the current month comes from the daily files (updated through the day)
MONTHS = ['202512'] + [f'2026{m:02d}' for m in range(1, TEND.month)]
DAILY_FROM = dt.date(TEND.year, TEND.month, 1)
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}

def get(url, path=None, timeout=300):
    if path and os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, 'rb').read()
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        data = r.read()
    if path: open(path, 'wb').write(data)
    return data

def cached_rr(url, full_path, rr_path, force=False):
    """Roraima-only rows of an INPE CSV, cached in rr_path; the Brazil-wide file is deleted after filtering."""
    if os.path.exists(rr_path) and not force:
        return list(csv.DictReader(open(rr_path, encoding='utf-8')))
    if force or not os.path.exists(full_path):
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
            open(full_path, 'wb').write(r.read())
    with open(full_path, encoding='utf-8') as fh:
        rd = csv.DictReader(fh)
        out = [r for r in rd if r['estado_id'] == '14']
        fields = rd.fieldnames
    with open(rr_path, 'w', encoding='utf-8', newline='') as fo:
        w = csv.DictWriter(fo, fieldnames=fields); w.writeheader(); w.writerows(out)
    os.remove(full_path)
    return out

def load_json(b):
    if b[:2] == b'\x1f\x8b':
        import gzip; b = gzip.decompress(b)
    return json.loads(b.decode('utf-8'))

# ---------------- state boundary
rr = load_json(get('https://servicodados.ibge.gov.br/api/v3/malhas/estados/14?formato=application/vnd.geo%2Bjson&qualidade=intermediaria',
                   os.path.join(RAW, 'rr.geojson')))
rr_geom = unary_union([shape(f['geometry']) for f in rr['features']])
rr_main = max(rr_geom.geoms, key=lambda g: g.area) if isinstance(rr_geom, MultiPolygon) else rr_geom
rr_ring = [[round(x, 4), round(y, 4)] for x, y in rr_main.simplify(0.01).exterior.coords]
print('RR boundary pts', len(rr_ring), 'bounds', rr_geom.bounds)

# ---------------- fires (Roraima only)
mdir = os.path.join(RAW, 'mensal'); os.makedirs(mdir, exist_ok=True)
rows, seen = [], set()
for m in MONTHS:
    n0 = len(rows)
    for r in cached_rr(f'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/mensal/Brasil/focos_mensal_br_{m}.csv',
                       os.path.join(mdir, f'focos_mensal_br_{m}.csv'), os.path.join(mdir, f'rr_{m}.csv')):
        if r['id'] in seen: continue
        t = dt.datetime.strptime(r['data_hora_gmt'], '%Y-%m-%d %H:%M:%S')
        if t < T0 or t > TEND: continue
        seen.add(r['id']); rows.append(r)
    print(m, len(rows) - n0)
d = DAILY_FROM
while d <= TEND.date():
    tag = d.strftime('%Y%m%d')
    n0 = len(rows)
    fresh = d >= TEND.date() - dt.timedelta(days=1)  # yesterday and today keep growing at INPE
    for r in cached_rr(f'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_{tag}.csv',
                       os.path.join(RAW, f'focos_{tag}.csv'), os.path.join(RAW, f'rr_{tag}.csv'), force=fresh):
        if r['id'] in seen: continue
        seen.add(r['id']); rows.append(r)
    print('daily', tag, len(rows) - n0)
    d += dt.timedelta(days=1)
rows.sort(key=lambda r: r['data_hora_gmt'])
print('fires RR', len(rows), '| last fire (UTC)', rows[-1]['data_hora_gmt'] if rows else '-')

VIIRS = {'NOAA-20', 'NOAA-21', 'NPP-375', 'NPP-375D'}
SMALL = {'de', 'da', 'do', 'das', 'dos', 'e'}
def title(s):
    ps = s.strip().lower().split(' ')
    return ' '.join(w if (i and w in SMALL) else w[:1].upper() + w[1:] for i, w in enumerate(ps))
sats, muns, si, mi = [], [], {}, {}
def ix(v, lst, d):
    if v not in d: d[v] = len(lst); lst.append(v)
    return d[v]
F = {k: [] for k in 'lat lon t s m f d r v'.split()}
for r in rows:
    t = dt.datetime.strptime(r['data_hora_gmt'], '%Y-%m-%d %H:%M:%S')
    F['lat'].append(round(float(r['lat']), 4)); F['lon'].append(round(float(r['lon']), 4))
    F['t'].append(int((t - T0).total_seconds() // 60))
    F['s'].append(ix(r['satelite'], sats, si))
    F['m'].append(ix(title(r['municipio']), muns, mi))
    fr = r['frp'].strip(); F['f'].append(round(float(fr), 1) if fr and float(fr) >= 0 else -1)
    dd = r['numero_dias_sem_chuva'].strip(); F['d'].append(int(float(dd)) if dd and float(dd) >= 0 else -1)
    rk = r['risco_fogo'].strip(); F['r'].append(round(float(rk), 2) if rk and 0 <= float(rk) <= 1 else -1)
    F['v'].append(1 if r['satelite'] in VIIRS else 0)

# ---------------- fire events (VIIRS within 1.2 km and 48 h) + perimeters
vi = [i for i in range(len(rows)) if F['v'][i]]
parent = {i: i for i in vi}
def find(a):
    while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
    return a
cell = 0.011
buckets = collections.defaultdict(list)
for i in vi: buckets[(int(F['lat'][i] / cell), int(F['lon'][i] / cell))].append(i)
for (a, b), lst in buckets.items():
    neigh = [j for da in (-1, 0, 1) for db in (-1, 0, 1) for j in buckets.get((a + da, b + db), [])]
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

H = 0.0017  # half of a 375 m pixel in degrees
def footprint(idxs):
    sq = [box(F['lon'][i] - H, F['lat'][i] - H, F['lon'][i] + H, F['lat'][i] + H) for i in idxs]
    g = unary_union(sq).buffer(0.0025, 4).buffer(-0.0018, 4).simplify(0.0006)
    polys = [g] if isinstance(g, Polygon) else list(getattr(g, 'geoms', []))
    out = []
    for p in polys:
        if p.is_empty or p.area < 1e-7: continue
        out.append([v for x, y in p.exterior.coords for v in (round(x, 4), round(y, 4))])
    return out

events = []
for g in groups.values():
    g.sort(key=lambda i: F['t'][i])
    cells = {(round(F['lat'][i] / 0.003375), round(F['lon'][i] / 0.003375)) for i in g}
    area = len(cells) * 0.1406
    if area < 0.5: continue
    mun = collections.Counter(F['m'][i] for i in g).most_common(1)[0][0]
    frps = [F['f'][i] for i in g if F['f'][i] >= 0]
    # perimeter snapshots: one per UTC day with new detections
    snaps, upto = [], []
    by_day = collections.OrderedDict()
    for i in g: by_day.setdefault(F['t'][i] // 1440, []).append(i)
    for day, idxs in by_day.items():
        upto += idxs
        snaps.append({'t': max(F['t'][i] for i in idxs), 'rings': footprint(upto)})
    events.append({'n': len(g), 'area': round(area, 2), 'start': F['t'][g[0]], 'end': F['t'][g[-1]],
                   'lat': round(sum(F['lat'][i] for i in g) / len(g), 4), 'lon': round(sum(F['lon'][i] for i in g) / len(g), 4),
                   'm': mun, 'frpMax': max(frps) if frps else -1, 'snaps': snaps, '_idx': g})
events.sort(key=lambda e: e['start'])
print('events >=0.5 km2:', len(events), 'snapshots:', sum(len(e['snaps']) for e in events))

GW, GH = 820, 943
FULL = '--completo' in sys.argv or not (os.path.exists(os.path.join(OUT, 'relevo.png')) and os.path.exists(os.path.join(OUT, 'imagem.jpg')))
if not FULL:
    a = np.asarray(Image.open(os.path.join(OUT, 'relevo.png')).convert('RGB'), dtype=np.float32)
    elev = a[..., 0] * 256 + a[..., 1]
    print('terrain and imagery kept (use --completo to rebuild)')

if FULL:
    # ---------------- terrain (Terrarium z9) -> lon/lat grid
    Z = 9
    def txy(lon, lat):
        n = 2 ** Z
        return ((lon + 180) / 360 * n,
                (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    x0, y0 = txy(W, N); x1, y1 = txy(E, S)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    tdir = os.path.join(RAW, 'terrarium9'); os.makedirs(tdir, exist_ok=True)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            data = get(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png', os.path.join(tdir, f'{tx}_{ty}.png'))
            a = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'), dtype=np.float32)
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    lons = np.linspace(W, E, GW); lats = np.linspace(N, S, GH)
    PX, PY = np.meshgrid((np.array([txy(l, 0)[0] for l in lons]) - tx0) * 256, (np.array([txy(0, l)[1] for l in lats]) - ty0) * 256)
    ix0 = np.clip(PX.astype(int), 0, mosaic.shape[1] - 2); iy0 = np.clip(PY.astype(int), 0, mosaic.shape[0] - 2)
    fx, fy = PX - ix0, PY - iy0
    elev = (mosaic[iy0, ix0] * (1 - fx) * (1 - fy) + mosaic[iy0, ix0 + 1] * fx * (1 - fy) +
            mosaic[iy0 + 1, ix0] * (1 - fx) * fy + mosaic[iy0 + 1, ix0 + 1] * fx * fy)
    elev = np.clip(elev, 0, 3000)
    enc = np.round(elev).astype(np.uint16)
    img = np.zeros((GH, GW, 3), dtype=np.uint8); img[..., 0] = enc >> 8; img[..., 1] = enc & 255
    Image.fromarray(img, 'RGB').save(os.path.join(OUT, 'relevo.png'), optimize=True)
    print('elev', float(elev.min()), float(elev.max()))

    # ---------------- imagery: Sentinel-2 cloudless 2025, outside Roraima dimmed
    IW = 3072; IH = round(IW * (N - S) / (E - W))
    parts = []
    for k in range(2):  # two halves to stay under WMS size limits
        s_, n_ = (S + (N - S) * k / 2, S + (N - S) * (k + 1) / 2)
        q = urllib.parse.urlencode({'service': 'WMS', 'request': 'GetMap', 'version': '1.1.1', 'layers': 's2cloudless-2025',
            'styles': '', 'srs': 'EPSG:4326', 'bbox': f'{W},{s_},{E},{n_}', 'width': IW, 'height': IH // 2, 'format': 'image/jpeg'})
        parts.append(Image.open(io.BytesIO(get('https://tiles.maps.eox.at/wms?' + q, os.path.join(RAW, f's2_rr_{k}.jpg')))).convert('RGB'))
    im = Image.new('RGB', (IW, (IH // 2) * 2)); im.paste(parts[1], (0, 0)); im.paste(parts[0], (0, IH // 2))
    def topx(x, y): return ((x - W) / (E - W) * im.width, (N - y) / (N - S) * im.height)
    mask = Image.new('L', im.size, 0); md = ImageDraw.Draw(mask)
    for poly in (rr_geom.geoms if isinstance(rr_geom, MultiPolygon) else [rr_geom]):
        md.polygon([topx(x, y) for x, y in poly.exterior.coords], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    dim = Image.blend(im, Image.new('RGB', im.size, (18, 22, 20)), 0.62)
    out = Image.composite(im, dim, mask)
    ImageDraw.Draw(out).line([topx(x, y) for x, y in rr_main.exterior.coords], fill=(250, 214, 120), width=3)
    out.save(os.path.join(OUT, 'imagem.jpg'), quality=84, optimize=True, progressive=True)
    print('imagery', out.size)

# ---------------- territory layers (cached in RAW) and per-fire context
from shapely.strtree import STRtree
from shapely.geometry import Point
def wfs_json(url, name):
    return load_json(get(url, os.path.join(RAW, name), timeout=600))
def rings_of(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]
    return [[v for x, y in p.exterior.coords for v in (round(x, 4), round(y, 4))] for p in polys if p.area > 1e-6]

# municipalities (IBGE)
mun_geo = wfs_json('https://servicodados.ibge.gov.br/api/v3/malhas/estados/14?formato=application/vnd.geo%2Bjson&qualidade=intermediaria&intrarregiao=municipio', 'rr_municipios.geojson')
mun_names = {str(m['id']): m['nome'] for m in load_json(get('https://servicodados.ibge.gov.br/api/v1/localidades/estados/14/municipios', os.path.join(RAW, 'rr_municipios_nomes.json')))}
MUNIS = []
for f in mun_geo['features']:
    g = shape(f['geometry']); c = g.representative_point()
    MUNIS.append({'nome': mun_names.get(str(f['properties'].get('codarea')), '?'), 'c': [round(c.x, 4), round(c.y, 4)], 'r': rings_of(g, 0.004)})
MUNIS.sort(key=lambda m: m['nome'])

# indigenous lands (FUNAI)
ti_geo = wfs_json('https://geoserver.funai.gov.br/geoserver/Funai/ows?' + urllib.parse.urlencode({'service': 'WFS', 'version': '1.0.0',
    'request': 'GetFeature', 'typeName': 'Funai:tis_poligonais', 'outputFormat': 'application/json', 'bbox': f'{W},{S},{E},{N}'}), 'rr_tis.geojson')
TIS, ti_geoms = [], []
for f in ti_geo['features']:
    p = f['properties']; g = shape(f['geometry'])
    if not g.is_valid: g = g.buffer(0)
    if 'RR' not in (p.get('uf_sigla') or '') or not g.intersects(rr_geom): continue
    c = g.representative_point()
    TIS.append({'nome': p.get('terrai_nome'), 'etnia': p.get('etnia_nome'), 'fase': p.get('fase_ti'), 'c': [round(c.x, 4), round(c.y, 4)], 'r': rings_of(g, 0.004)})
    ti_geoms.append(g)

# rural properties declared in the CAR (SICAR public WFS). Only public fields: code, type, area, status.
# The server needs legacy TLS settings. Cached for 30 days in RAW.
import ssl, time
from shapely.geometry import mapping
LEGACY = ssl.create_default_context(); LEGACY.set_ciphers('DEFAULT@SECLEVEL=1')
def get_legacy(url, timeout=900):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout, context=LEGACY) as r:
        return r.read()
car_cache = os.path.join(RAW, 'rr_car.json')
if '--completo' in sys.argv or not os.path.exists(car_cache) or time.time() - os.path.getmtime(car_cache) > 30 * 86400:
    try:  # the SICAR server is often slow or blocks foreign servers: keep the old cache (or none) when it fails
        car_new, start = [], 0
        while True:
            page = json.loads(get_legacy('https://geoserver.car.gov.br/geoserver/sicar/wfs?' + urllib.parse.urlencode({'service': 'WFS', 'version': '2.0.0',
                'request': 'GetFeature', 'typeNames': 'sicar:sicar_imoveis_rr', 'outputFormat': 'application/json', 'count': 5000, 'startIndex': start})))['features']
            for f in page:
                if not f.get('geometry'): continue
                p = f['properties']; g = shape(f['geometry'])
                if not g.is_valid: g = g.buffer(0)
                car_new.append({'cod': p.get('cod_imovel'), 'tipo': p.get('tipo_imovel'), 'cond': p.get('condicao'), 'status': p.get('status_imovel'),
                                'area': round(p.get('area') or 0, 1), 'mun': p.get('municipio'), 'geom': mapping(g.simplify(0.0004, preserve_topology=True))})
            print('CAR page', start, len(page))
            if len(page) < 5000: break
            start += 5000
        if car_new: json.dump(car_new, open(car_cache, 'w', encoding='utf-8'), ensure_ascii=False)
    except Exception as e:
        print('CAR download failed, using the old cache if any:', e)
car_raw = json.load(open(car_cache, encoding='utf-8')) if os.path.exists(car_cache) else []
car_geoms = [shape(c['geom']) for c in car_raw]
car_tree = STRtree(car_geoms)
car_of = []
for la, lo in zip(F['lat'], F['lon']):
    pt = Point(lo, la); best, best_a = -1, 1e18
    for k in car_tree.query(pt):
        k = int(k)
        if car_raw[k]['area'] < best_a and car_geoms[k].contains(pt): best, best_a = k, car_raw[k]['area']
    car_of.append(best)
keep = sorted({car_of[i] for i in range(len(F['t'])) if F['v'][i] and car_of[i] >= 0})  # properties with VIIRS fire
new_id = {k: j for j, k in enumerate(keep)}
F['car'] = [new_id.get(k, -1) for k in car_of]
CARS = []
for k in keep:
    c = car_raw[k]; g = car_geoms[k]; pc = g.representative_point()
    CARS.append({'cod': c['cod'], 'tipo': c['tipo'], 'cond': c['cond'], 'status': c['status'], 'area': c['area'], 'mun': c['mun'],
                 'c': [round(pc.x, 4), round(pc.y, 4)], 'r': rings_of(g, 0.0004)})
print('CAR: properties in RR', len(car_raw), '| with VIIRS fire', len(CARS), '| fires inside a property', sum(1 for x in F['car'] if x >= 0))

# DETER deforestation / selective logging alerts (INPE). A fire on land deforested shortly before is a strong sign of illegal burning.
try:
    det_geo = load_json(get('https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz/ows?' + urllib.parse.urlencode({'service': 'WFS', 'version': '1.0.0',
        'request': 'GetFeature', 'typeName': 'deter-amz:deter_amz', 'outputFormat': 'application/json',
        'CQL_FILTER': f"uf='RR' AND view_date >= '{(T0 - dt.timedelta(days=365)).strftime('%Y-%m-%d')}' AND (classname LIKE 'DESMATAMENTO%' OR classname LIKE 'CS_%')"}),
        os.path.join(RAW, f'rr_deter_{TEND.strftime("%Y%m%d")}.geojson'), timeout=600))
except Exception as e:  # use the latest day already downloaded, or no alerts
    old = sorted(n for n in os.listdir(RAW) if n.startswith('rr_deter_') and n.endswith('.geojson'))
    print('DETER download failed, using', old[-1] if old else 'nothing', ':', e)
    det_geo = load_json(open(os.path.join(RAW, old[-1]), 'rb').read()) if old else {'features': []}
DETER, det_geoms, det_days = [], [], []
for f in det_geo['features']:
    p = f['properties']; g = shape(f['geometry'])
    if not g.is_valid: g = g.buffer(0)
    d = dt.datetime.strptime(p['view_date'][:10], '%Y-%m-%d')
    DETER.append({'cls': p.get('classname'), 'd': p['view_date'][:10], 'km2': round(p.get('areamunkm') or 0, 3), 'r': rings_of(g, 0.0003)})
    det_geoms.append(g); det_days.append((d - T0).days)
det_tree = STRtree(det_geoms) if det_geoms else None
F['dt'] = []
for la, lo, t in zip(F['lat'], F['lon'], F['t']):
    hit = -1
    if det_tree is not None:
        pt = Point(lo, la); fd = t // 1440
        for k in det_tree.query(pt):
            k = int(k)
            if -365 <= fd - det_days[k] <= 30 and det_geoms[k].contains(pt): hit = k; break
    F['dt'].append(hit)
print('DETER alerts', len(DETER), '| fires on recently deforested land', sum(1 for x in F['dt'] if x >= 0))

# conservation units: left out on purpose. In Nov 2026 the MMA/CNUC WFS layer (geoservicos.inde.gov.br)
# returned names that do not match their shapes (e.g. "Monte Roraima" drawn in Amazonas). Add them back
# from the official CNUC shapefile once it can be checked.
UCS, uc_geoms = [], []
print('layers: municipios', len(MUNIS), '| TIs', len(TIS), '| UCs', len(UCS))

def which(geoms):
    tree = STRtree(geoms); out = []
    for la, lo in zip(F['lat'], F['lon']):
        pt = Point(lo, la); hit = -1
        for k in tree.query(pt):
            if geoms[int(k)].contains(pt): hit = int(k); break
        out.append(hit)
    return out
F['ti'] = which(ti_geoms) if ti_geoms else [-1] * len(F['t'])
F['uc'] = which(uc_geoms) if uc_geoms else [-1] * len(F['t'])

# land cover: MODIS IGBP 2023 (NASA GIBS), grouped into a few classes people recognise
LC_GROUPS = ['Floresta', 'Lavrado / savana', 'Campo ou pasto', 'Agricultura', 'Área alagável', 'Área urbana', 'Água', 'Outros']
LC_COLORS = [(38, 110, 52), (214, 182, 74), (232, 160, 96), (200, 110, 200), (64, 160, 170), (220, 40, 40), (70, 120, 200), (150, 150, 150)]
IGBP_RGB = {(33,138,33): 0, (49,204,49): 0, (152,204,49): 0, (150,250,150): 0, (141,186,141): 0,
            (186,141,141): 1, (245,222,179): 1, (218,235,157): 1, (255,213,0): 1, (240,185,103): 2,
            (71,131,181): 4, (250,239,115): 3, (255,0,0): 5, (153,147,86): 3, (134,202,227): 6}
LW, LH = 1200, 1380
lc_png = get('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?' + urllib.parse.urlencode({'SERVICE': 'WMS', 'REQUEST': 'GetMap',
    'VERSION': '1.1.1', 'LAYERS': 'MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual', 'STYLES': '', 'SRS': 'EPSG:4326',
    'BBOX': f'{W},{S},{E},{N}', 'WIDTH': LW, 'HEIGHT': LH, 'FORMAT': 'image/png', 'TIME': '2023-01-01'}), os.path.join(RAW, 'igbp_2023.png'))
lc_rgb = np.asarray(Image.open(io.BytesIO(lc_png)).convert('RGB'))
lc_cls = np.full((LH, LW), 7, dtype=np.uint8)
for rgb, k in IGBP_RGB.items():
    lc_cls[np.all(lc_rgb == np.array(rgb, dtype=np.uint8), axis=-1)] = k
lc_img = np.zeros((LH, LW, 3), dtype=np.uint8)
for k, col in enumerate(LC_COLORS): lc_img[lc_cls == k] = col
if FULL or not os.path.exists(os.path.join(OUT, 'cobertura.png')):
    Image.fromarray(lc_img, 'RGB').save(os.path.join(OUT, 'cobertura.png'), optimize=True)
F['c'] = [int(lc_cls[min(LH - 1, max(0, int((N - la) / (N - S) * LH))), min(LW - 1, max(0, int((lo - W) / (E - W) * LW)))])
          for la, lo in zip(F['lat'], F['lon'])]
print('land cover of fires:', collections.Counter(LC_GROUPS[c] for c in F['c']).most_common())

# per fire event: main vegetation and whether it reached an indigenous land (used by the fine simulator)
for ev in events:
    idx = ev.pop('_idx')
    ev['lc'] = collections.Counter(F['c'][i] for i in idx).most_common(1)[0][0]
    tis_hit = collections.Counter(F['ti'][i] for i in idx if F['ti'][i] >= 0)
    ev['ti'] = tis_hit.most_common(1)[0][0] if tis_hit else -1
    cars_hit = collections.Counter(F['car'][i] for i in idx if F['car'][i] >= 0)
    ev['car'] = cars_hit.most_common(1)[0][0] if cars_hit else -1
    ev['dt'] = 1 if any(F['dt'][i] >= 0 for i in idx) else 0

# ---------------- weather: 5 x 6 grid, every 3 h
WC, WR = 5, 6
wl = [round(W + (E - W) * (i + .5) / WC, 3) for i in range(WC)]
wt = [round(N - (N - S) * (j + .5) / WR, 3) for j in range(WR)]
pts = [(la, lo) for la in wt for lo in wl]
url = 'https://historical-forecast-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode({
    'latitude': ','.join(str(p[0]) for p in pts), 'longitude': ','.join(str(p[1]) for p in pts),
    'hourly': 'wind_speed_10m,wind_direction_10m,relative_humidity_2m,temperature_2m,precipitation',
    'start_date': T0.strftime('%Y-%m-%d'), 'end_date': TEND.strftime('%Y-%m-%d'), 'timezone': 'GMT'})
wx = json.loads(get(url, timeout=600))  # always fresh
nh = len(wx[0]['hourly']['time'])
steps = list(range(0, nh, 3))
def series(key, scale):
    return [[round((p['hourly'][key][h] if p['hourly'][key][h] is not None else 0) * scale) for p in wx] for h in steps]
weather = {'cols': WC, 'rows': WR, 'lats': wt, 'lons': wl, 'stepMin': 180, 'n': len(steps),
           'ws': series('wind_speed_10m', 10), 'wd': series('wind_direction_10m', 1),
           'rh': series('relative_humidity_2m', 1), 'tc': series('temperature_2m', 10),
           # rain: total of the 3 hours of each step, in tenths of mm
           'pr': [[round(sum((p['hourly']['precipitation'][h + k] or 0) for k in range(3) if h + k < nh) * 10) for p in wx] for h in steps]}

meta = {'bbox': [W, S, E, N], 't0': T0.strftime('%Y-%m-%dT%H:%MZ'), 'grid': [GW, GH], 'elevMax': float(elev.max()),
        'lastFire': F['t'][-1], 'count': len(rows)}
json.dump({'meta': meta, 'sats': sats, 'muns': muns, 'fires': F, 'events': events, 'weather': weather, 'rr': rr_ring,
           'munis': MUNIS, 'tis': TIS, 'ucs': UCS, 'car': CARS, 'deter': DETER, 'lc': LC_GROUPS, 'lcColors': ['#%02x%02x%02x' % c for c in LC_COLORS]},
          open(os.path.join(OUT, 'roraima3d.json'), 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
for n in sorted(os.listdir(OUT)):
    print(n, os.path.getsize(os.path.join(OUT, n)))
