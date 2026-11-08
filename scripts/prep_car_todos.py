"""All rural properties of Roraima in the CAR, in a light file, so the map can find the property where a person is.
usage: python prep_car_todos.py <raw_dir> <out_dir>
Reads rr_car.json cached by prep_rr.py (public SICAR data: code, type, area, status; no owner names).
Output car_todos.json: outlines simplified (~40 m) and stored as integers of 0.0001 degree, delta-encoded."""
import json, os, sys
from shapely.geometry import shape, Polygon

RAW, OUT = sys.argv[1], sys.argv[2]
W, S, Q = -64.85, -1.6, 1e4
cars = json.load(open(os.path.join(RAW, 'rr_car.json'), encoding='utf-8'))
muns, mun_ix, out = [], {}, []
for c in cars:
    g = shape(c['geom']).simplify(0.0004, preserve_topology=True)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]
    rings = []
    for p in polys:
        cs = [(round((x - W) * Q), round((y - S) * Q)) for x, y in p.exterior.coords]
        cs = [v for k, v in enumerate(cs) if k == 0 or v != cs[k - 1]]
        if len(cs) < 4: continue
        flat = [cs[0][0], cs[0][1]]
        for (x0, y0), (x1, y1) in zip(cs, cs[1:]): flat += [x1 - x0, y1 - y0]
        rings.append(flat)
    if not rings: continue
    m = c.get('mun') or ''
    if m not in mun_ix: mun_ix[m] = len(muns); muns.append(m)
    out.append([c['cod'], c['tipo'], c['area'], mun_ix[m], c.get('cond') or '', rings])
path = os.path.join(OUT, 'car_todos.json')
json.dump({'q': Q, 'origin': [W, S], 'muns': muns, 'cars': out, 'source': 'SICAR (dados públicos)'},
          open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
print('CAR properties', len(out), '| file', os.path.getsize(path))
