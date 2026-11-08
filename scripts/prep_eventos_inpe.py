"""Official INPE fire events ("Evento de Fogo", Programa Queimadas) for Roraima, for the 3D map.
usage: python prep_eventos_inpe.py <raw_dir> <out_dir>
The INPE API only lists the events that are active or under observation now, so every run is merged
into an archive in <raw_dir> (rr_eventos_inpe_arquivo.json): over time it keeps the whole season.
Events that left the list are marked as ended. If the API is down, the archive is used as it is.
Source: https://data.inpe.br/queimadas/evento-fogo/ (method: Bernini et al. 2026, Remote Sens. 18, 606)."""
import json, os, sys, datetime as dt, urllib.request
from shapely.geometry import shape, Polygon

RAW, OUT = sys.argv[1], sys.argv[2]
API = 'https://data.inpe.br/queimadas/portal/api/sala-ciman/'
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}
T0 = '2025-12-01'
NOW = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')

def get_json(url, timeout=300):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))

def rings_of(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]
    return [[v for x, y in p.exterior.coords for v in (round(x, 5), round(y, 5))] for p in polys if p.area > 0]

arq_path = os.path.join(RAW, 'rr_eventos_inpe_arquivo.json')
arq = json.load(open(arq_path, encoding='utf-8')) if os.path.exists(arq_path) else {'events': {}}
ok = True
try:
    feats = get_json(API + 'mapa/eventos')['features']
    try:
        extra = {f['properties']['id_evento']: f['properties'] for f in get_json(API + 'centroides')['features']
                 if f['properties'].get('estado') == 'RORAIMA'}
    except Exception as e:
        print('centroides failed:', e); extra = {}
except Exception as e:
    print('INPE events API failed, using the archive:', e); ok = False

if ok:
    now_ids = set()
    for f in feats:
        p = f['properties']
        if 'RR' not in (p.get('estados') or []) or not f.get('geometry'): continue
        g = shape(f['geometry'])
        if not g.is_valid: g = g.buffer(0)
        c = g.representative_point(); x = extra.get(p['id_evento'], {})
        old = arq['events'].get(str(p['id_evento']), {})
        arq['events'][str(p['id_evento'])] = {
            'id': p['id_evento'], 'tipo': p.get('tipo_nome'), 'status': p.get('status_nome'), 'ha': round(p.get('area_ha') or 0, 1),
            'dias': p.get('duracao_dias'), 'mun': ', '.join(m.title() for m in (p.get('municipios') or [p.get('municipio') or ''])),
            'd0': p.get('data_min'), 'd1': p.get('data_max'),
            'desm': x.get('desmatamento_pct', old.get('desm')), 'veg': x.get('vegetacao_pct', old.get('veg')), 'trans': x.get('transicao_pct', old.get('trans')),
            'c': [round(c.x, 5), round(c.y, 5)], 'r': rings_of(g, 0.0002), 'visto': NOW, 'atual': True}
        now_ids.add(str(p['id_evento']))
    for k, e in arq['events'].items():
        if k not in now_ids: e['atual'] = False  # no longer listed by INPE: ended
    arq['updated'] = NOW
    json.dump(arq, open(arq_path, 'w', encoding='utf-8'), ensure_ascii=False)

evs = sorted((e for e in arq['events'].values() if (e.get('d1') or '') >= T0), key=lambda e: e['d0'] or '')
json.dump({'updated': arq.get('updated'), 'events': evs}, open(os.path.join(OUT, 'eventos_inpe.json'), 'w', encoding='utf-8'),
          separators=(',', ':'), ensure_ascii=False)
from collections import Counter
print('INPE events RR', len(evs), '| listed now', sum(e['atual'] for e in evs), '|', dict(Counter(e['tipo'] for e in evs)),
      '| file', os.path.getsize(os.path.join(OUT, 'eventos_inpe.json')))
