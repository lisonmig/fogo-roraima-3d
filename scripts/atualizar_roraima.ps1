# Atualiza os dados do mapa 3D de Roraima: baixa de novo os focos de ontem e de hoje do INPE,
# o vento/umidade (Open-Meteo) e regrava mapa-3d\roraima3d.json.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\atualizar_roraima.ps1
# Cada execução acrescenta uma linha em atualizacao.log.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$py   = Join-Path $root '.venv\Scripts\python.exe'
$log  = Join-Path $root 'atualizacao.log'
$env:PYTHONIOENCODING = 'utf-8'

$saida = & $py -I (Join-Path $root 'scripts\prep_rr.py') (Join-Path $root 'dados-3d') (Join-Path $root 'mapa-3d') 2>&1 | ForEach-Object { "$_" }
$ok = ($LASTEXITCODE -eq 0)

# estradas e vilas (OpenStreetMap): o download fica guardado 30 dias; uma falha aqui não impede a atualização dos focos
if ($ok) {
    $saida += & $py -I (Join-Path $root 'scripts\prep_estradas.py') (Join-Path $root 'dados-3d') (Join-Path $root 'mapa-3d') 2>&1 | ForEach-Object { "$_" }
    # todos os imóveis do CAR, em arquivo leve, para achar a propriedade de quem marca um local (o CAR é baixado de novo a cada 30 dias)
    $saida += & $py -I (Join-Path $root 'scripts\prep_car_todos.py') (Join-Path $root 'dados-3d') (Join-Path $root 'mapa-3d') 2>&1 | ForEach-Object { "$_" }
    # rios (OpenStreetMap): rios largos e principais são barreira para o fogo; o download fica guardado 60 dias
    $saida += & $py -I (Join-Path $root 'scripts\prep_rios.py') (Join-Path $root 'dados-3d') (Join-Path $root 'mapa-3d') 2>&1 | ForEach-Object { "$_" }
    # seca: nível do Rio Branco em Boa Vista (ANA), comparado com todos os anos desde 1967
    $saida += & $py -I (Join-Path $root 'scripts\prep_seca.py') (Join-Path $root 'dados-3d') (Join-Path $root 'mapa-3d') 2>&1 | ForEach-Object { "$_" }
    # eventos de fogo oficiais do INPE (contorno e tipo); guarda um arquivo histórico em dados-3d
    $saida += & $py -I (Join-Path $root 'scripts\prep_eventos_inpe.py') (Join-Path $root 'dados-3d') (Join-Path $root 'mapa-3d') 2>&1 | ForEach-Object { "$_" }
}

$resumo = ($saida | Where-Object { $_ -match '^fires RR|^daily' } | Select-Object -Last 3) -join ' ; '
$status = if ($ok) { 'OK' } else { 'ERRO' }
Add-Content -Path $log -Value ("{0}  {1}  {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $status, $resumo) -Encoding UTF8

$saida
if (-not $ok) { Write-Output 'ATUALIZACAO FALHOU'; exit 1 }
Write-Output 'ATUALIZACAO OK'
