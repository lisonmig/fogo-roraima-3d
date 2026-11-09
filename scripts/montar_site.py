"""Builds the public site in docs/ (GitHub Pages) from the map in mapa-3d/.
usage: python scripts/montar_site.py [mapa-3d] [docs]
Copies the page as index.html with a proper HTML skeleton, the data files and images, and writes the
app manifest and icons so the map can be installed on a phone."""
import json, os, shutil, sys
from PIL import Image, ImageDraw

SRC = sys.argv[1] if len(sys.argv) > 1 else 'mapa-3d'
DST = sys.argv[2] if len(sys.argv) > 2 else 'docs'
os.makedirs(DST, exist_ok=True)

HEAD = ('<!doctype html>\n<html lang="pt-BR">\n'
        '<meta name="description" content="Mapa 3D dos focos de incêndio, da seca e do risco para propriedades rurais em Roraima, com dados do INPE e da ANA. Projeto de extensão da UERR.">\n'
        '<meta property="og:title" content="Fogo em Roraima 3D">\n'
        '<meta property="og:description" content="Focos de incêndio, seca dos rios e risco para a sua propriedade, atualizados a cada 2 horas.">\n'
        '<meta name="theme-color" content="#c2410c">\n'
        '<link rel="manifest" href="manifest.webmanifest">\n'
        '<link rel="icon" href="icone-192.png">\n<link rel="apple-touch-icon" href="icone-192.png">\n')
page = open(os.path.join(SRC, 'fogo-roraima-3d.html'), encoding='utf-8').read()
if page.lstrip().lower().startswith('<!doctype'):
    page = page.split('\n', 1)[1]
# the 3D library is served from the site itself (docs/vendor), not from an outside CDN
page = page.replace('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js', 'vendor/three.min.js')
page = page.replace('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js', 'vendor/OrbitControls.js')
open(os.path.join(DST, 'index.html'), 'w', encoding='utf-8').write(HEAD + page.rstrip() + '\n</html>\n')

for n in ['roraima3d.json', 'estradas.json', 'eventos_inpe.json', 'seca.json', 'rios.json', 'car_todos.json', 'relevo.png', 'imagem.jpg', 'cobertura.png']:
    p = os.path.join(SRC, n)
    if os.path.exists(p): shutil.copy2(p, os.path.join(DST, n))
    else: print('faltando:', n)

# app icon: a flame on the accent colour
for size in (192, 512):
    im = Image.new('RGBA', (size, size), (194, 65, 12, 255)); d = ImageDraw.Draw(im); s = size / 100
    d.polygon([(50 * s, 12 * s), (72 * s, 44 * s), (76 * s, 64 * s), (66 * s, 82 * s), (50 * s, 88 * s), (34 * s, 82 * s), (24 * s, 64 * s), (32 * s, 46 * s), (40 * s, 56 * s)], fill=(255, 200, 80, 255))
    d.polygon([(50 * s, 44 * s), (62 * s, 64 * s), (58 * s, 80 * s), (50 * s, 84 * s), (42 * s, 80 * s), (40 * s, 66 * s)], fill=(255, 245, 220, 255))
    im.save(os.path.join(DST, 'icone-%d.png' % size))
json.dump({'name': 'Fogo em Roraima 3D', 'short_name': 'Fogo RR', 'lang': 'pt-BR', 'start_url': './', 'scope': './', 'display': 'standalone',
           'background_color': '#121110', 'theme_color': '#c2410c',
           'description': 'Focos de incêndio, seca dos rios e risco para propriedades rurais em Roraima.',
           'icons': [{'src': 'icone-192.png', 'sizes': '192x192', 'type': 'image/png'}, {'src': 'icone-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any maskable'}]},
          open(os.path.join(DST, 'manifest.webmanifest'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
open(os.path.join(DST, '.nojekyll'), 'w').close()  # serve the files as they are
print('site pronto em', DST, ':', sorted(os.listdir(DST)))
