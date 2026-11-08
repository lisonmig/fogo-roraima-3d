"""Roads and named places of Roraima for the 3D map (OpenStreetMap, via the Overpass API).
usage: python prep_estradas.py <raw_dir> <out_dir> [--completo]
Inside cities only the main roads are kept (the dense street grid is dropped); outside them every
road, vicinal and track is kept, so people in the countryside can find their own road.
The OSM download is cached in <raw_dir> for 30 days. Needs rr.geojson and rr_municipios*.json
already cached by prep_rr.py. Map data (c) OpenStreetMap contributors, ODbL."""
import json, math, os, sys, time, collections, urllib.request, urllib.parse
from shapely.geometry import shape, LineString, Point, MultiLineString
from shapely.ops import unary_union, linemerge
from shapely.strtree import STRtree

RAW, OUT = sys.argv[1], sys.argv[2]
W, E, S, N = -64.85, -58.85, -1.6, 5.3
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}
Q = 1e4  # coordinates stored as integers of 0.0001 degree (~11 m)

def load_json(path):
    b = open(path, 'rb').read()
    if b[:2] == b'\x1f\x8b':
        import gzip; b = gzip.decompress(b)
    return json.loads(b.decode('utf-8'))

# ---------------- download (cached 30 days)
cache = os.path.join(RAW, 'rr_osm_estradas.json')
if '--completo' in sys.argv or not os.path.exists(cache) or time.time() - os.path.getmtime(cache) > 30 * 86400:
    q = ('[out:json][timeout:900];area["ISO3166-2"="BR-RR"]["admin_level"="4"]->.a;'
         'way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|'
         'unclassified|track|residential|living_street|service)$"](area.a);out tags geom qt;'
         'node["place"~"^(city|town|village|hamlet|locality|farm|isolated_dwelling)$"]["name"](area.a);out body qt;')
    data = None
    for ep in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']:
        try:
            req = urllib.request.Request(ep, data=urllib.parse.urlencode({'data': q}).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=1200) as r:
                data = r.read()
            json.loads(data)  # must parse
            break
        except Exception as e:
            print('overpass', ep, 'failed:', e); data = None
    if data is None:
        if not os.path.exists(cache): sys.exit('roads: download failed and no cache')
        print('roads: download failed, using the old cache')
    else:
        open(cache, 'wb').write(data)
osm = load_json(cache)
ways = [e for e in osm['elements'] if e['type'] == 'way' and e.get('geometry')]
nodes = [e for e in osm['elements'] if e['type'] == 'node']
print('OSM ways', len(ways), '| places', len(nodes), collections.Counter(n['tags']['place'] for n in nodes).most_common())

# ---------------- state and municipalities
rr = unary_union([shape(f['geometry']) for f in load_json(os.path.join(RAW, 'rr.geojson'))['features']])
clip = rr.buffer(0.02)
mun_geo = load_json(os.path.join(RAW, 'rr_municipios.geojson'))
mun_names = {str(m['id']): m['nome'] for m in load_json(os.path.join(RAW, 'rr_municipios_nomes.json'))}
MUNS, mun_geoms = [], []
for f in mun_geo['features']:
    MUNS.append(mun_names.get(str(f['properties'].get('codarea')), '?')); mun_geoms.append(shape(f['geometry']))
mun_tree = STRtree(mun_geoms)
def mun_of(x, y):
    p = Point(x, y)
    for k in mun_tree.query(p):
        if mun_geoms[int(k)].contains(p): return int(k)
    return -1

# ---------------- cities: dense street grid near a city or town
def km(x0, y0, x1, y1):
    return math.hypot((x1 - x0) * 111.32 * math.cos(math.radians((y0 + y1) / 2)), (y1 - y0) * 110.57)
CELL = 0.005
def cell(x, y): return (int(math.floor(x / CELL)), int(math.floor(y / CELL)))
STREETS = {'residential', 'living_street', 'service', 'unclassified'}
dens = collections.Counter()
for w in ways:
    if w['tags'].get('highway') not in STREETS: continue
    g = w['geometry']
    for a, b in zip(g, g[1:]):
        dens[cell((a['lon'] + b['lon']) / 2, (a['lat'] + b['lat']) / 2)] += km(a['lon'], a['lat'], b['lon'], b['lat'])
seeds = [(n['lon'], n['lat'], 15 if n['tags']['place'] == 'city' else 5) for n in nodes if n['tags']['place'] in ('city', 'town')]
def near_seed(c):
    x, y = (c[0] + .5) * CELL, (c[1] + .5) * CELL
    return any(km(x, y, sx, sy) <= r for sx, sy, r in seeds)
urban = {c for c, v in dens.items() if v >= 1.5 and near_seed(c)}
urban |= {(c[0] + i, c[1] + j) for c in urban for i in (-1, 0, 1) for j in (-1, 0, 1) if near_seed((c[0] + i, c[1] + j))}
print('city cells', len(urban), f'(~{len(urban) * 0.3:.0f} km2)')

# ---------------- classify, drop city streets, simplify
CLS = ['Rodovia federal', 'Rodovia estadual ou avenida', 'Vicinal, estrada municipal ou rua', 'Estrada de terra ou ramal']
MAJOR = {'trunk', 'primary', 'secondary', 'tertiary'}
names, name_ix = [], {}
def nid(s):
    if not s: return -1
    if s not in name_ix: name_ix[s] = len(names); names.append(s)
    return name_ix[s]
def ref_of(t):
    r = (t.get('ref') or '').replace(' ', '').upper()
    parts = [p for p in r.replace(',', ';').split(';') if p.startswith(('BR-', 'RR-'))]
    return ' / '.join(parts)
out_ways, dropped_km, kept_km = [], 0.0, collections.Counter()
for w in ways:
    t = w['tags']; hw = t['highway'].replace('_link', '')
    pts = [(p['lon'], p['lat']) for p in w['geometry']]
    if len(pts) < 2: continue
    L = sum(km(*a, *b) for a, b in zip(pts, pts[1:]))
    if hw not in MAJOR:
        in_city = sum(km(*a, *b) for a, b in zip(pts, pts[1:]) if cell((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) in urban)
        if in_city > 0.5 * L or (hw == 'service' and L < 0.3):
            dropped_km += L; continue
    ref = ref_of(t)
    if 'BR-' in ref or hw == 'trunk': c = 0
    elif 'RR-' in ref or hw in ('primary', 'secondary'): c = 1
    elif hw == 'track': c = 3
    else: c = 2
    g = LineString(pts)
    if not g.intersects(clip): continue
    g = g.intersection(clip)
    parts = [g] if isinstance(g, LineString) else [p for p in getattr(g, 'geoms', []) if isinstance(p, LineString)]
    label = ref or (t.get('name') or '').strip()
    for p in parts:
        p = p.simplify(0.00012 if c >= 2 else 0.0002)
        cs = [(round((x - W) * Q), round((y - S) * Q)) for x, y in p.coords]
        cs = [v for k, v in enumerate(cs) if k == 0 or v != cs[k - 1]]
        if len(cs) < 2: continue
        mid = p.interpolate(0.5, normalized=True)
        flat = [cs[0][0], cs[0][1]]
        for (x0, y0), (x1, y1) in zip(cs, cs[1:]): flat += [x1 - x0, y1 - y0]
        out_ways.append({'c': c, 'n': nid(label), 'm': mun_of(mid.x, mid.y), 'p': flat, 'geom': p, 'alt': (t.get('name') or '').strip() if ref else ''})
        kept_km[c] += L * p.length / max(g.length, 1e-12)
print('roads kept', len(out_ways), {CLS[k]: round(v) for k, v in sorted(kept_km.items())}, '| city streets dropped', round(dropped_km), 'km')

# ---------------- label anchors along named roads (every ~20 km, deduplicated)
groups = collections.defaultdict(list)
for w in out_ways:
    if w['n'] >= 0: groups[(w['n'], w['m'] if w['c'] >= 2 else -1)].append(w['geom'])
anchors, by_name = [], collections.defaultdict(list)
for (n, m), gs in groups.items():
    merged = linemerge(MultiLineString(gs)) if len(gs) > 1 else gs[0]
    lines = [merged] if isinstance(merged, LineString) else list(merged.geoms)
    cls = min(w['c'] for w in out_ways if w['n'] == n)
    for ln in sorted(lines, key=lambda l: -l.length):
        Lk = ln.length * 111
        if Lk < 0.8: continue
        steps = [0.5] if Lk < 30 else [(k + 0.5) / round(Lk / 20) for k in range(round(Lk / 20))]
        for s in steps:
            p = ln.interpolate(s, normalized=True)
            if any(km(p.x, p.y, q[0], q[1]) < 12 for q in by_name[n]): continue
            by_name[n].append((p.x, p.y))
            anchors.append([n, m, cls, round((p.x - W) * Q), round((p.y - S) * Q)])
print('road labels', len(anchors))

# alternative names (a BR/RR road that also has a local name) help the search
alts = {}
for w in out_ways:
    if w['alt'] and w['n'] >= 0: alts.setdefault(names[w['n']], set()).add(w['alt'])

# ---------------- named places: towns, villages, hamlets, farms
KIND = {'city': 0, 'town': 1, 'village': 2, 'hamlet': 3, 'locality': 4, 'farm': 5, 'isolated_dwelling': 5}
places = []
for nd in nodes:
    if not clip.contains(Point(nd['lon'], nd['lat'])): continue
    nm = nd['tags']['name'].strip()
    places.append([nm, KIND[nd['tags']['place']], round((nd['lon'] - W) * Q), round((nd['lat'] - S) * Q), mun_of(nd['lon'], nd['lat'])])
places.sort(key=lambda p: (p[1], p[0]))
print('places', collections.Counter(p[1] for p in places))

res = {'q': Q, 'origin': [W, S], 'cls': CLS, 'muns': MUNS, 'names': names,
       'alt': {k: sorted(v) for k, v in alts.items()},
       'ways': [[w['c'], w['n'], w['m']] + w['p'] for w in out_ways], 'labels': anchors, 'places': places,
       'source': 'OpenStreetMap contributors (ODbL)', 'osmDate': osm.get('osm3s', {}).get('timestamp_osm_base', '')}
path = os.path.join(OUT, 'estradas.json')
json.dump(res, open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
print('estradas.json', os.path.getsize(path), 'bytes | vertices', sum((len(w['p']) // 2) for w in out_ways))
