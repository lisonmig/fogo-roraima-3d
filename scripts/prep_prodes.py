"""Measured deforestation in Roraima (INPE PRODES, yearly), in a light file for an optional map layer.
usage: python prep_prodes.py <raw_dir> <out_dir>
Downloads the PRODES polygons of Roraima for the last 3 published years from TerraBrasilis (WFS), one
request per year, and keeps them in <raw_dir>/rr_prodes.json for 30 days (PRODES changes once a year).
If the server is down, the old download is used; with no old download, the script fails and the site
just shows the layer as unavailable.
Output prodes.json: outlines simplified (~30 m), stored as integers of 0.0001 degree, delta-encoded.
Never crossed with the CAR (rural properties) on purpose."""
import json, os, sys, time, datetime as dt, urllib.request, urllib.parse
from shapely.geometry import shape, Polygon

RAW, OUT = sys.argv[1], sys.argv[2]
W, S, Q = -64.85, -1.6, 1e4
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}
URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/prodes-legal-amz/yearly_deforestation/ows?'
cache = os.path.join(RAW, 'rr_prodes.json')

def wfs(params, timeout):
    q = {'service': 'WFS', 'version': '1.0.0', 'request': 'GetFeature', 'typeName': 'prodes-legal-amz:yearly_deforestation'}
    q.update(params)
    for k in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(URL + urllib.parse.urlencode(q), headers=UA), timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:
            print('PRODES try', k + 1, 'failed:', e)
            time.sleep(10)
    raise RuntimeError('PRODES server did not answer')

if not os.path.exists(cache) or time.time() - os.path.getmtime(cache) > 30 * 86400:
    try:
        y0 = dt.date.today().year - 3
        js = wfs({'outputFormat': 'application/json', 'propertyName': 'year', 'CQL_FILTER': f"state='RR' AND year>={y0}"}, 120)
        years = sorted({int(f['properties']['year']) for f in js['features']})[-3:]
        feats = []
        for y in years:
            js = wfs({'outputFormat': 'application/json', 'propertyName': 'year,area_km,image_date,geom', 'CQL_FILTER': f"state='RR' AND year={y}"}, 180)
            feats += js['features']; print('PRODES', y, len(js['features']))
        if not feats: raise RuntimeError('no PRODES polygons for Roraima')
        json.dump({'years': years, 'got': dt.date.today().isoformat(), 'features': feats}, open(cache, 'w', encoding='utf-8'), separators=(',', ':'))
    except Exception as e:
        print('PRODES download failed:', e)
        if not os.path.exists(cache): sys.exit(1)
        print('using the old download from', dt.date.fromtimestamp(os.path.getmtime(cache)))

C = json.load(open(cache, encoding='utf-8'))
out = []
for f in C['features']:
    if not f.get('geometry'): continue
    p = f['properties']; g = shape(f['geometry'])
    if not g.is_valid: g = g.buffer(0)
    g = g.simplify(0.0003, preserve_topology=True)
    polys = [g] if isinstance(g, Polygon) else [x for x in getattr(g, 'geoms', []) if isinstance(x, Polygon)]
    rings = []
    for pl in polys:
        cs = [(round((x - W) * Q), round((y - S) * Q)) for x, y in pl.exterior.coords]
        cs = [v for k, v in enumerate(cs) if k == 0 or v != cs[k - 1]]
        if len(cs) < 4: continue
        flat = [cs[0][0], cs[0][1]]
        for (x0, y0), (x1, y1) in zip(cs, cs[1:]): flat += [x1 - x0, y1 - y0]
        rings.append(flat)
    if rings: out.append([int(p['year']), round(p.get('area_km') or 0, 3), (p.get('image_date') or '')[:10], rings])
path = os.path.join(OUT, 'prodes.json')
json.dump({'q': Q, 'origin': [W, S], 'years': C['years'], 'got': C['got'], 'p': out,
           'source': 'INPE PRODES (TerraBrasilis)'}, open(path, 'w', encoding='utf-8'), separators=(',', ':'))
print('PRODES polygons', len(out), '| years', C['years'], '| file', os.path.getsize(path))
