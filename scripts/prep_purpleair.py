"""Qualidade do ar MEDIDA em Roraima: sensores PurpleAir (baixo custo), com a correção da EPA para PM2,5.

Uso:  python prep_purpleair.py <pasta_cache> <pasta_saida> [resposta_de_teste.json]

Escreve <pasta_saida>/ar_medido.json. A chave vem da variável de ambiente PURPLEAIR_API_KEY (segredo do GitHub,
lida só no Actions); sem a chave o script não faz nada. Se a consulta falhar, republica a última leitura boa
guardada em <pasta_cache>/purpleair_ultimo.json (com a hora em que foi feita).

Privacidade: o arquivo público não leva o nome dado pelo dono do sensor (pode ser nome de pessoa ou endereço),
só o de instituições; e a posição é arredondada para ~1 km.

Correção: EPA / Barkjohn et al. (2021), versão estendida para fumaça, sobre o canal CF=1 (média dos lasers A e B)
e a umidade medida pelo próprio sensor. Sensores cujos dois lasers discordam (mais de 5 µg/m³ e mais de 70%) ficam fora
do resumo.
"""
import datetime as dt
import json
import os
import re
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.purpleair.com/v1/sensors'
FIELDS = 'name,latitude,longitude,location_type,last_seen,humidity,pm2.5_cf_1,pm2.5_cf_1_a,pm2.5_cf_1_b,pm2.5_60minute,pm2.5_24hour,confidence'
RR = dict(nwlng=-64.9, nwlat=5.3, selng=-58.8, selat=-1.6)          # Roraima inteira
BV = dict(lat0=2.70, lat1=2.95, lon0=-60.80, lon1=-60.55)           # Boa Vista (resumo)
INSTIT = re.compile(r'inpa|uerr|ufrr|ifrr|embrapa|femarh|ibama|inpe|icmbio|funai|sesau|defesa civil|bombeiro|universidade|instituto', re.I)


def epa(cf1, rh):
    """PM2,5 corrigido (µg/m³) a partir do canal CF=1 e da umidade relativa (%)."""
    x = cf1
    if x < 30:
        v = 0.524 * x - 0.0862 * rh + 5.75
    elif x < 50:
        k = x / 20 - 1.5
        v = (0.786 * k + 0.524 * (1 - k)) * x - 0.0862 * rh + 5.75
    elif x < 210:
        v = 0.786 * x - 0.0862 * rh + 5.75
    elif x < 260:
        k = x / 50 - 4.2
        v = (0.69 * k + 0.786 * (1 - k)) * x - 0.0862 * rh * (1 - k) + 2.966 * k + 5.75 * (1 - k) + 8.84e-4 * x * x * k
    else:
        v = 2.966 + 0.69 * x + 8.84e-4 * x * x
    return max(0.0, v)


def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def montar(resp):
    f = {name: k for k, name in enumerate(resp['fields'])}
    g = lambda row, name: row[f[name]] if name in f and row[f[name]] is not None else None
    sens = []
    for row in resp.get('data', []):
        lat, lon = g(row, 'latitude'), g(row, 'longitude')
        if lat is None or lon is None:
            continue
        a, b, cf, rh = g(row, 'pm2.5_cf_1_a'), g(row, 'pm2.5_cf_1_b'), g(row, 'pm2.5_cf_1'), g(row, 'humidity')
        if a is not None and b is not None:
            bruto = (a + b) / 2
            ok = not (abs(a - b) > 5 and abs(a - b) / max(bruto, 0.01) > 0.7)
        else:
            bruto = cf if cf is not None else (a if a is not None else b)
            ok = bruto is not None
        nome = str(g(row, 'name') or '')
        s = {
            'nome': nome if INSTIT.search(nome) else 'Sensor %d' % (len(sens) + 1),
            'lat': round(lat, 2), 'lon': round(lon, 2),
            'externo': g(row, 'location_type') == 0,
            'visto': iso(g(row, 'last_seen')) if g(row, 'last_seen') else None,
            'umid': rh,
            'pm25_bruto': None if bruto is None else round(bruto, 1),
            'pm25': None if bruto is None or rh is None else round(epa(bruto, rh), 1),
            'pm25_60min_bruto': g(row, 'pm2.5_60minute'),
            'pm25_24h_bruto': g(row, 'pm2.5_24hour'),
            'canais_ok': bool(ok),
        }
        sens.append(s)
    bv = [s['pm25'] for s in sens if s['externo'] and s['canais_ok'] and s['pm25'] is not None
          and BV['lat0'] <= s['lat'] <= BV['lat1'] and BV['lon0'] <= s['lon'] <= BV['lon1']]
    return {
        'atualizado': iso(resp.get('data_time_stamp') or resp.get('time_stamp') or dt.datetime.now(dt.timezone.utc).timestamp()),
        'fonte': 'PurpleAir (sensores de baixo custo)',
        'correcao': 'EPA, Barkjohn et al. (2021)',
        'n': len(sens),
        'boa_vista': {'n': len(bv), 'pm25_mediana': round(statistics.median(bv), 1) if bv else None},
        'sensores': sens,
    }


def consultar(key):
    q = dict(RR, fields=FIELDS, max_age=3600)
    req = urllib.request.Request(API + '?' + urllib.parse.urlencode(q), headers={'X-API-Key': key, 'User-Agent': 'fogo-roraima-3d'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    cache_dir, out_dir = sys.argv[1], sys.argv[2]
    ultimo = os.path.join(cache_dir, 'purpleair_ultimo.json'); saida = os.path.join(out_dir, 'ar_medido.json')
    res = None
    try:
        if len(sys.argv) > 3:
            resp = json.load(open(sys.argv[3], encoding='utf-8'))
        else:
            key = os.environ.get('PURPLEAIR_API_KEY', '').strip()
            if not key:
                print('ar_medido: sem a chave PURPLEAIR_API_KEY; nada a fazer'); return
            resp = consultar(key)
        res = montar(resp)
        os.makedirs(cache_dir, exist_ok=True)
        json.dump(res, open(ultimo, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    except urllib.error.HTTPError as e:
        print('ar_medido: a PurpleAir respondeu HTTP', e.code)          # nunca imprime a chave nem os cabeçalhos
    except Exception as e:
        print('ar_medido: falhou a consulta:', type(e).__name__)
    if res is None and os.path.exists(ultimo):
        res = json.load(open(ultimo, encoding='utf-8')); res['reaproveitado'] = True
        print('ar_medido: usando a última leitura boa, de', res.get('atualizado'))
    if res is None:
        return
    json.dump(res, open(saida, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, separators=(',', ':'))
    print('ar_medido.json:', res['n'], 'sensores em Roraima;', res['boa_vista']['n'], 'válidos em Boa Vista; mediana PM2,5 corrigido:', res['boa_vista']['pm25_mediana'])
    for s in res['sensores']:
        print('  %-28s %6.2f %7.2f  externo=%s canais_ok=%s  bruto=%s  corrigido=%s  umid=%s' % (
            s['nome'][:28], s['lat'], s['lon'], s['externo'], s['canais_ok'], s['pm25_bruto'], s['pm25'], s['umid']))


if __name__ == '__main__':
    main()
