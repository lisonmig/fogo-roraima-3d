"""Rivers of Roraima for the 3D map (OpenStreetMap via Overpass): river lines and the water areas of wide rivers.
usage: python prep_rios.py <raw_dir> <out_dir> [--completo]
Wide rivers (drawn as water areas in OSM) and long named rivers are marked as barriers: a ground fire rarely crosses them.
The download is cached in <raw_dir> for 60 days. Map data (c) OpenStreetMap contributors, ODbL."""
import json, os, sys, time, collections, urllib.request, urllib.parse
from shapely.geometry import LineString, Polygon, MultiPolygon, shape
from shapely.ops import unary_union, linemerge, polygonize

RAW, OUT = sys.argv[1], sys.argv[2]
W, S, Q = -64.85, -1.6, 1e4
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}
cache = os.path.join(RAW, 'rr_osm_rios.json')
if '--completo' in sys.argv or not os.path.exists(cache) or time.time() - os.path.getmtime(cache) > 60 * 86400:
    q = ('[out:json][timeout:900];area["ISO3166-2"="BR-RR"]["admin_level"="4"]->.a;'
         '(way["natural"="water"]["water"="river"](area.a);relation["natural"="water"]["water"="river"](area.a););out tags geom qt;'
         'way["waterway"="river"](area.a);out tags geom qt;')
    data = None
    for ep in ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
               'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']:
        try:
            data = urllib.request.urlopen(urllib.request.Request(ep, data=urllib.parse.urlencode({'data': q}).encode(), headers=UA), timeout=1200).read()
            json.loads(data); break
        except Exception as e:
            print('overpass', ep, 'failed:', e); data = None
    if data: open(cache, 'wb').write(data)
    elif not os.path.exists(cache): sys.exit('rivers: download failed and no cache')
osm = json.load(open(cache, encoding='utf-8'))
els = osm['elements']

def load_json(path):
    b = open(path, 'rb').read()
    if b[:2] == b'\x1f\x8b':
        import gzip; b = gzip.decompress(b)
    return json.loads(b.decode('utf-8'))
rr = unary_union([shape(f['geometry']) for f in load_json(os.path.join(RAW, 'rr.geojson'))['features']])
clip = rr.buffer(0.05)

# wide rivers: water areas (closed ways and multipolygon relations)
polys = []
for e in els:
    t = e.get('tags', {})
    if t.get('natural') != 'water': continue
    if e['type'] == 'way' and e.get('geometry') and len(e['geometry']) >= 4:
        p = Polygon([(g['lon'], g['lat']) for g in e['geometry']])
        if p.is_valid or (p := p.buffer(0)).area > 0: polys.append(p)
    elif e['type'] == 'relation':
        outer = [LineString([(g['lon'], g['lat']) for g in m['geometry']]) for m in e.get('members', []) if m.get('role') in ('outer', '') and m.get('geometry') and len(m['geometry']) >= 2]
        for p in polygonize(linemerge(outer) if outer else []): polys.append(p)
water = unary_union([p.buffer(0) for p in polys]).intersection(clip).simplify(0.0003)
wgeoms = [water] if isinstance(water, Polygon) else [g for g in getattr(water, 'geoms', []) if isinstance(g, Polygon)]
wgeoms = [g for g in wgeoms if g.area > 2e-6]

# river lines; long named rivers are barriers too (where OSM has no water area for them)
lines, length_by = [], collections.Counter()
for e in els:
    t = e.get('tags', {})
    if t.get('waterway') != 'river' or not e.get('geometry'): continue
    g = LineString([(p['lon'], p['lat']) for p in e['geometry']])
    if not g.intersects(clip): continue
    nm = (t.get('name') or '').strip()
    lines.append((nm, g)); length_by[nm] += g.length * 111
MAJOR_KM = 150
names, nix = [], {}
def nid(s):
    if not s: return -1
    if s not in nix: nix[s] = len(names); names.append(s)
    return nix[s]
def enc(coords):
    cs = [(round((x - W) * Q), round((y - S) * Q)) for x, y in coords]
    cs = [v for k, v in enumerate(cs) if k == 0 or v != cs[k - 1]]
    if len(cs) < 2: return None
    flat = [cs[0][0], cs[0][1]]
    for (x0, y0), (x1, y1) in zip(cs, cs[1:]): flat += [x1 - x0, y1 - y0]
    return flat
out_lines = []
for nm, g in lines:
    g = g.intersection(clip)
    for part in ([g] if isinstance(g, LineString) else [p for p in getattr(g, 'geoms', []) if isinstance(p, LineString)]):
        f = enc(part.simplify(0.0004).coords)
        if f: out_lines.append([1 if nm and length_by[nm] >= MAJOR_KM else 0, nid(nm)] + f)
# name of each water area: the river line that crosses it most
out_areas = []
for g in wgeoms:
    best, bl = '', 0
    for nm, ln in lines:
        if nm and ln.intersects(g):
            l = ln.intersection(g).length
            if l > bl: best, bl = nm, l
    f = enc(g.exterior.coords)
    if f: out_areas.append([nid(best)] + f)
res = {'q': Q, 'origin': [W, S], 'names': names, 'lines': out_lines, 'areas': out_areas, 'source': 'OpenStreetMap contributors (ODbL)'}
path = os.path.join(OUT, 'rios.json')
json.dump(res, open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
print('river lines', len(out_lines), '| major', sum(1 for l in out_lines if l[0]), '| wide-river areas', len(out_areas),
      '| major names', sorted(n for n, km in length_by.items() if n and km >= MAJOR_KM), '| file', os.path.getsize(path))
