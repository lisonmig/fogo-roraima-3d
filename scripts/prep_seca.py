"""Drought data: water level of the rivers of Roraima at the ANA gauges, compared with every past year at the same date.
usage: python prep_seca.py <raw_dir> <out_dir>
For each station the daily series (HidroSerieHistorica) is cached in <raw_dir> for 30 days; the recent months come from the
telemetry (15-min readings, averaged per day). Years are hydrological: 1 August to 31 July (high water around June-July,
low water around February-March). Levels are gauge readings in cm, not depth: they can be negative.
The Boa Vista station (Rio Branco) also gets the full yearly band for the chart of the drought tab."""
import json, os, re, sys, time, datetime as dt, urllib.request, urllib.parse

RAW, OUT = sys.argv[1], sys.argv[2]
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}
API = 'https://telemetriaws1.ana.gov.br/ServiceANA.asmx/'
TODAY = dt.date.today()
MAIN = '14620000'
# river gauges in Roraima with telemetry (ANA, Rede Hidrometeorológica Nacional)
STATIONS = [
    ('14620000', 'Boa Vista', 'Rio Branco', 2.8267, -60.6561), ('14710000', 'Caracaraí', 'Rio Branco', 1.8214, -61.1236),
    ('14790000', 'Santa Maria do Boiaçu', 'Rio Branco', -0.5053, -61.7864), ('14488000', 'Uaicás', 'Rio Uraricoera', 3.5497, -63.1692),
    ('14489000', 'Maracá', 'Rio Uraricoera', 3.3528, -61.4222), ('14495000', 'Fazenda Cajupiranga', 'Rio Uraricoera', 3.4381, -61.0367),
    ('14500000', 'Mocidade', 'Rio Uraricoera', 3.4644, -60.9097), ('14515000', 'Fazenda Passarão', 'Rio Uraricoera', 3.2078, -60.5711),
    ('14527000', 'Ponte do Tacutu', 'Rio Tacutu', 3.5675, -59.8883), ('14558000', 'Fazenda Paraíso', 'Rio Tacutu', 3.3178, -60.3447),
    ('14526400', 'Rio Maú', 'Rio Maú', 4.5761, -60.1397), ('14530000', 'Vila Surumu', 'Rio Surumu', 4.1961, -60.7939),
    ('14540000', 'Fazenda Bandeira Branca', 'Rio Cotingo', 4.6306, -60.4706), ('14235200', 'Fazenda Recreio', 'Rio Cauamé', 2.8642, -60.7517),
    ('14680001', 'Fé e Esperança', 'Rio Mucajaí', 2.8708, -61.4406), ('14690000', 'Mucajaí', 'Rio Mucajaí', 2.4714, -60.9178),
    ('14740000', 'Fazenda Anauá', 'Rio Anauá', 1.1292, -60.2236), ('14850000', 'Base Alalaú', 'Rio Alalaú', -0.8586, -60.52)]

def get(path, params, timeout=300):
    with urllib.request.urlopen(urllib.request.Request(API + path + '?' + urllib.parse.urlencode(params), headers=UA), timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')

def history(code):
    path = os.path.join(RAW, 'ana_%s_diario.json' % code)
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 30 * 86400:
        try:
            x = get('HidroSerieHistorica', {'codEstacao': code, 'dataInicio': '01/01/1960', 'dataFim': TODAY.strftime('%d/%m/%Y'), 'tipoDados': '1', 'nivelConsistencia': ''}, 600)
            daily, cons = {}, {}
            for b in re.findall(r'<SerieHistorica [^>]*>(.*?)</SerieHistorica>', x, re.S):
                g = lambda t: (re.search(r'<' + t + r'>([^<]*)</' + t + '>', b) or [None, ''])[1].strip()
                d0, nc = g('DataHora')[:10], g('NivelConsistencia')
                if not d0: continue
                y, m = int(d0[:4]), int(d0[5:7])
                for d in range(1, 32):
                    v = g('Cota%02d' % d)
                    if not v: continue
                    try: k = dt.date(y, m, d).isoformat()
                    except ValueError: continue
                    if k not in daily or nc == '2' or cons.get(k) != '2': daily[k] = float(v); cons[k] = nc  # prefer consisted data
            if daily: json.dump(daily, open(path, 'w'))
        except Exception as e:
            print(code, 'history failed:', e)
    return json.load(open(path)) if os.path.exists(path) else {}

def recent(code, daily):
    """Telemetry after the end of the daily series (or the last 60 days), averaged per day; returns the last reading."""
    start = max(dt.date.fromisoformat(max(daily)) + dt.timedelta(days=1), TODAY - dt.timedelta(days=150)) if daily else TODAY - dt.timedelta(days=60)
    last = None
    while start <= TODAY:
        end = min(TODAY, start + dt.timedelta(days=30))
        try:
            x = get('DadosHidrometeorologicos', {'codEstacao': code, 'dataInicio': start.strftime('%d/%m/%Y'), 'dataFim': end.strftime('%d/%m/%Y')}, 180)
            by = {}
            for t, v in re.findall(r'<DataHora>([^<]+)</DataHora>.*?<Nivel>([^<]*)</Nivel>', x, re.S):
                if v.strip():
                    by.setdefault(t.strip()[:10], []).append(float(v))
                    if last is None or t.strip() > last[0]: last = (t.strip(), float(v))
            for k, vs in by.items(): daily[k] = round(sum(vs) / len(vs), 1)
        except Exception as e:
            print(code, 'telemetry', start, 'failed:', e)
        start = end + dt.timedelta(days=1)
    return last

def hy_start(d): return dt.date(d.year if d.month >= 8 else d.year - 1, 8, 1)
def idx(d): return min(365, (d - hy_start(d)).days)

def summarize(code, name, river, lat, lon, full):
    daily = history(code)
    last = recent(code, daily)
    if not daily: return None
    years = {}
    for k, v in daily.items():
        d = dt.date.fromisoformat(k); years.setdefault(hy_start(d).year, [None] * 366)[idx(d)] = v
    cur_y0 = hy_start(TODAY).year
    past = {y: s for y, s in years.items() if y < cur_y0 and sum(v is not None for v in s) > 300}
    cur = years.get(cur_y0, [None] * 366)[:idx(TODAY) + 1]
    have = [i for i, v in enumerate(cur) if v is not None]
    if not have or len(past) < 5: return {'code': code, 'name': name, 'river': river, 'lat': lat, 'lon': lon, 'noData': True}
    ti = have[-1]
    if TODAY.toordinal() - (hy_start(TODAY).toordinal() + ti) > 10:  # no reading in the last 10 days
        return {'code': code, 'name': name, 'river': river, 'lat': lat, 'lon': lon, 'noData': True, 'lastDay': (hy_start(TODAY) + dt.timedelta(days=ti)).isoformat()}
    band = {'min': [], 'p10': [], 'med': [], 'p90': [], 'max': []}
    for i in range(366):
        vals = sorted(s[i] for s in past.values() if s[i] is not None)
        if len(vals) < 5:
            for k in band: band[k].append(None)
            continue
        q = lambda p: vals[min(len(vals) - 1, int(round(p * (len(vals) - 1))))]
        band['min'].append(vals[0]); band['p10'].append(q(.1)); band['med'].append(q(.5)); band['p90'].append(q(.9)); band['max'].append(vals[-1])
    v = cur[ti]
    same = [s[ti] for s in past.values() if s[ti] is not None]
    rank = 1 + sum(1 for x in same if x < v)
    pct = round(100 * sum(1 for x in same if x < v) / max(1, len(same)))
    rec_v, rec_k = min((x, k) for k, x in daily.items())
    back = lambda n: cur[ti - n] if ti >= n and cur[ti - n] is not None else None
    risk = 'critico' if rank <= 3 or pct <= 10 else 'baixo' if pct <= 30 else 'normal' if pct <= 70 else 'alto'
    st = {'code': code, 'name': name, 'river': river, 'lat': lat, 'lon': lon, 'last': {'t': last[0] if last else None, 'cm': last[1] if last else v},
          'day': ti, 'dayValue': v, 'rank': rank, 'of': len(same) + 1, 'pct': pct, 'risk': risk, 'firstYear': min(past), 'nYears': len(past),
          'med': band['med'][ti], 'p10': band['p10'][ti], 'd7': back(7), 'd30': back(30), 'record': {'cm': rec_v, 'date': rec_k},
          'cur': cur, 'band': {k: band[k] for k in ('p10', 'med', 'p90')}}
    if full:
        st['bandFull'] = band
        st['compare'] = {'%d/%02d' % (y, (y + 1) % 100): years[y] for y in (2015, 2023) if y in years}
    return st

stations = []
for code, name, river, lat, lon in STATIONS:
    s = summarize(code, name, river, lat, lon, code == MAIN)
    if s:
        stations.append(s)
        print(code, name, river, '|', 'sem dados recentes' if s.get('noData') else '%s cm, rank %d/%d, %d%%, %s' % (s['last']['cm'], s['rank'], s['of'], s['pct'], s['risk']))
main = next((s for s in stations if s['code'] == MAIN and not s.get('noData')), None)
res = {'updated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'hy0': '%d-08-01' % hy_start(TODAY).year, 'stations': stations}
if main:  # fields used by the drought tab chart (Boa Vista)
    res.update({'station': {'code': MAIN, 'name': 'Boa Vista', 'river': 'Rio Branco'}, 'last': main['last'], 'today': main['day'], 'cur': main['cur'],
                'band': main['bandFull'], 'compare': main['compare'], 'nYears': main['nYears'], 'firstYear': main['firstYear'], 'rank': main['rank'],
                'of': main['of'], 'd7': main['d7'], 'd30': main['d30'], 'dayValue': main['dayValue'], 'record': main['record']})
    del main['bandFull']; del main['compare']
path = os.path.join(OUT, 'seca.json')
json.dump(res, open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
print('stations', len(stations), '| file', os.path.getsize(path))
