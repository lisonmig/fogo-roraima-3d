# 🔥 Fogo em Roraima 3D

Mapa 3D, gratuito e aberto, dos **focos de incêndio**, da **seca dos rios** e do **risco para propriedades rurais** em Roraima, com dados oficiais do INPE e da ANA, atualizado a cada 30 minutos.

Projeto de extensão da **Universidade Estadual de Roraima (UERR)**. Sem anúncios e sem fins comerciais.

> **Versão beta.** É uma ferramenta de apoio feita com dados de satélite e modelos de previsão do tempo. Não substitui a avaliação no local, o Corpo de Bombeiros (193) ou a Defesa Civil (199). As indicações de "pode ser ilegal?" são indícios por satélite, **não são acusação**.

## O que o mapa mostra

**Fogo**
- Focos de calor do INPE (todos os satélites), em 3D sobre o relevo e a imagem de satélite, com linha do tempo de dezembro de 2025 até agora.
- Eventos de fogo oficiais do INPE (contorno, tipo e situação: queimando, em observação ou apagado).
- Área queimada estimada (cicatrizes), vento, umidade e chuva.
- Terras Indígenas, municípios, imóveis do CAR e alertas de desmatamento (DETER).
- "Pode ser ilegal?": indícios por satélite e simulação educativa de multa (Decreto 6.514/2008).

**Para quem mora ou produz no campo**
- Estradas e vicinais, vilas e fazendas; busca por nome, código do CAR ou coordenada de GPS.
- **Meu local** (salvo só no aparelho): nível de perigo, tempo estimado até o fogo chegar (vento, umidade, vegetação e rios no caminho), seta mostrando de onde vem o risco, imóvel do CAR com possível prejuízo e botão para compartilhar o alerta (WhatsApp).

**Seca e água**
- Nível dos rios nas réguas da ANA, comparado com todos os anos desde 1968 na mesma data.
- Clique em um rio para ver o risco hídrico.

## Como usar

Abra o site (GitHub Pages) no navegador do computador ou do celular. No celular, use o menu do navegador → **"Adicionar à tela inicial"** para instalar como app.

## Como funciona

| Pasta / arquivo | O que é |
|---|---|
| `docs/` | O site publicado: `index.html` e os dados que ele carrega (`*.json`, `relevo.png`, `imagem.jpg`, `cobertura.png`). |
| `scripts/prep_rr.py` | Focos do INPE, tempo (Open-Meteo), incêndios agrupados, CAR, DETER, Terras Indígenas e vegetação → `roraima3d.json`. |
| `scripts/prep_eventos_inpe.py` | Eventos de fogo do INPE → `eventos_inpe.json` (e guarda um histórico, porque o INPE só mostra os atuais). |
| `scripts/prep_seca.py` | Réguas dos rios da ANA → `seca.json`. |
| `scripts/prep_rios.py`, `prep_estradas.py` | Rios, estradas, vilas e fazendas do OpenStreetMap → `rios.json`, `estradas.json`. |
| `scripts/prep_car_todos.py` | Todos os imóveis do CAR de Roraima, em arquivo leve → `car_todos.json`. |
| `scripts/montar_site.py` | Copia o mapa de trabalho (`mapa-3d/`) para `docs/`, com o ícone e o manifesto do app. |
| `dados-3d/` | Downloads guardados (só Roraima), para não baixar tudo de novo. |
| `.github/workflows/atualizar.yml` | Atualização automática a cada 30 minutos (disparada pelo cron-job.org; o agendamento do GitHub fica de reserva). |

### Atualização automática

O GitHub Actions roda os scripts a cada 30 minutos (disparado por um agendador externo gratuito, o cron-job.org) e publica o site de novo. É gratuito em repositórios públicos e não depende de nenhum computador ligado. Para atualizar na hora: aba **Actions** → **Atualizar mapa** → **Run workflow**.

Para ativar na primeira vez: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### Rodar no próprio computador

Precisa de Python 3.10 ou mais novo com `numpy`, `pillow` e `shapely`.

```
pip install numpy pillow shapely
python scripts/prep_rr.py dados-3d docs
python scripts/prep_eventos_inpe.py dados-3d docs
python scripts/prep_seca.py dados-3d docs
python -m http.server 8000 --directory docs
```

Depois abra http://127.0.0.1:8000. Abrir o `index.html` com duplo clique não funciona: o navegador bloqueia a leitura dos dados.

## Fontes e licenças dos dados

| Dado | Fonte | Licença / uso |
|---|---|---|
| Focos de calor, eventos de fogo, DETER | [INPE – Programa Queimadas](https://data.inpe.br/queimadas/) e [TerraBrasilis](https://terrabrasilis.dpi.inpe.br/) | Dados públicos, citar a fonte |
| Nível dos rios | [ANA – Agência Nacional de Águas](https://www.snirh.gov.br/hidroweb/) (Rede Hidrometeorológica Nacional) | Dados públicos, citar a fonte |
| Terras Indígenas | [FUNAI](https://www.gov.br/funai/pt-br/atuacao/terras-indigenas/geoprocessamento-e-mapas) | Dados públicos |
| Limites de município e estado | IBGE | Dados públicos |
| Imóveis rurais (CAR) | [SICAR](https://consultapublica.car.gov.br/) | Dados públicos (sem nome de proprietário) |
| Estradas, rios, vilas, fazendas | © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL |
| Vento, umidade, temperatura, chuva | [Open-Meteo](https://open-meteo.com) (modelo) | Uso gratuito não comercial, com crédito (CC BY 4.0) |
| Imagem de satélite | [Sentinel-2 cloudless 2025 – EOX IT Services](https://s2maps.eu) (dados Copernicus Sentinel modificados) | **CC BY-NC-SA 4.0 – não comercial** |
| Vegetação | NASA MODIS Land Cover (IGBP) 2023, via GIBS | Dados públicos da NASA |
| Relevo | Terrarium / Mapzen (SRTM) | Dados públicos |

Por causa da imagem da EOX e do plano gratuito do Open-Meteo, **o site não pode ter uso comercial** (anúncios, venda).

## Limitações

- O satélite não vê fogo pequeno, sob nuvem ou fumaça, nem brasa.
- A área queimada e o tempo de chegada do fogo são estimativas simples (regras práticas de propagação), não um modelo completo de incêndio.
- O CAR é declarado pelo próprio dono e pode ter sobreposições; não comprova posse nem autoria de fogo.
- Os valores de prejuízo por hectare são de referência, sem fonte oficial, e podem ser ajustados no mapa.
- O nível do rio é a altura na régua, não a profundidade: pode ser negativo.
- Unidades de conservação ainda não aparecem (a base consultada do MMA tinha nomes trocados).

## Licença

Código sob a [licença MIT](LICENSE). Os dados seguem as licenças de cada fonte (tabela acima).

Projeto de extensão · UERR · 2026
