#!/bin/sh
# Собирает граф OSRM из готового PBF-экспорта: выгрузка по bbox → фильтр дорог → extract.
#
# Нужен, когда регион больше Москвы. Overpass такие объёмы не отдаёт (измеренный тайл
# 0.25°×0.25° — 46 с), а сырой округ Geofabrik osrm-extract не переваривает: в ЦФО 111M
# узлов, а после обрезки и фильтра дорог — 6.4M, и пик RAM сборки падает до ~1.5 ГБ.
# osmium живёт в контейнере (services/osrm/osmium.Dockerfile), чтобы не ставить пакет на хост.
#
# Боксов несколько: один связный коридор (Москва + область) плюс по маленькому bbox на город,
# которого в коридоре нет. Список берётся из cities.ts — того же, по которому симуляция
# расселяет парк, поэтому «город с машинами, но без улиц» здесь получить нельзя.
#
#   scripts/osrm-prepare-pbf.sh                       # Москва, МО и столицы ЦФО
#   NAME=nw-region PBF_URL=https://download.geofabrik.de/russia/northwestern-fed-district-latest.osm.pbf \
#     BBOX=27.50,56.00,33.50,60.00 scripts/osrm-prepare-pbf.sh    # следующий регион
#   BUILD=0 scripts/osrm-prepare-pbf.sh               # только подготовить pbf
set -eu

NAME="${NAME:-moscow-csfo-roads}"
# Имя выгрузки Geofabrik: файл лежит в osrm-data/<PBF>.src.pbf и переиспользуется всеми
# графами из этого округа, а NAME влияет только на части, дороги и сам граф.
PBF="${PBF:-central-fed-district}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/russia/$PBF-latest.osm.pbf}"
# Москва вместе с областью; северо-западный угол захватывает Тверь, чтобы знакомые
# междугородние поездки демо не вываливались в прямую.
BBOX="${BBOX:-35.60,54.60,39.60,57.20}"
THREADS="${OSRM_THREADS:-4}"
BUILD="${BUILD:-1}"
OSMIUM_IMAGE="${OSMIUM_IMAGE:-dtramp-osmium}"
OSRM_IMAGE="${OSRM_IMAGE:-osrm/osrm-backend:v5.25.0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/osrm-data"
SRC="$DATA/$PBF.src.pbf"
BOXES="$DATA/$NAME.boxes"
PARTS="$DATA/extracts/$NAME"
CLIPPED="$DATA/$NAME.clipped.osm.pbf"
ROADS="$DATA/$NAME.osm.pbf"

mkdir -p "$DATA" "$PARTS"
docker build -q -t "$OSMIUM_IMAGE" -f "$ROOT/services/osrm/osmium.Dockerfile" "$ROOT/services/osrm" >/dev/null
osmium() { docker run --rm -v "$DATA:/data:z" "$OSMIUM_IMAGE" "$@"; }

if [ ! -f "$SRC" ]; then
  echo "$(date -u +%T) качу выгрузку: $PBF_URL"
  # -L обязателен: -latest.osm.pbf отвечает 307 на датированный файл, а без флага curl
  # сохраняет сам редирект (282 байта) и делает вид, что всё удалось
  curl -sSL --retry 3 --retry-delay 15 -o "$SRC" "$PBF_URL"
fi
echo "$(date -u +%T) выгрузка: $(du -h "$SRC" | cut -f1)"

if [ ! -f "$ROADS" ]; then
  "$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/osrm-city-boxes.ts" "$BBOX" > "$BOXES"
  mkdir -p "$PARTS"
  index=0
  while read -r box; do
    [ -n "$box" ] || continue
    part="$PARTS/part-$index.osm.pbf"
    # Каждое место отдельно: osmium extract со всеми bbox одним проходом сожрал 8 ГБ и
    # упёрся в OOM, а по одному боксу проходит в разы легче.
    if [ ! -s "$part" ]; then
      echo "$(date -u +%T) osmium extract $box"
      osmium extract -b "$box" -O -o "/data/extracts/$NAME/part-$index.osm.pbf" "/data/$PBF.src.pbf"
    fi
    index=$((index + 1))
  done < "$BOXES"

  if [ ! -f "$CLIPPED" ]; then
    echo "$(date -u +%T) osmium merge частей: $(find "$PARTS" -name 'part-*.osm.pbf' | wc -l)"
    # merge выкидывает одинаковые объекты: узлы на границе коридора и города лежат в двух частях
    osmium merge $(for part in "$PARTS"/part-*.osm.pbf; do printf '/data/extracts/%s/%s ' "$NAME" "$(basename "$part")"; done) \
      -O -o "/data/$NAME.clipped.osm.pbf"
  fi
  echo "$(date -u +%T) osmium tags-filter w/highway"
  # отношения ограничений поворота тащим вместе с дорогами, иначе граф разрешит развороты,
  # которых на самом деле нет
  osmium tags-filter "/data/$NAME.clipped.osm.pbf" w/highway r/type=restriction \
    -O -o "/data/$NAME.osm.pbf"
fi
# Проверка и счётчики — всегда, даже когда фильтр не перезапускался: рваная топология
# выглядит потом как «маршрут не строится» при живом OSRM, и ловить её дешевле здесь.
osmium check-refs "/data/$NAME.osm.pbf"
osmium fileinfo -e "/data/$NAME.osm.pbf" | sed -n 's/^ *Number of \(nodes\|ways\|relations\): /\1: /p'
echo "$(date -u +%T) дорог: $(du -h "$ROADS" | cut -f1)"

[ "$BUILD" = 1 ] || { echo 'BUILD=0 — граф не собираю'; exit 0; }

# Имя графа диктует вход: osrm-extract не принимает -o и пишет $NAME.osrm рядом с $NAME.osm.pbf,
# это и есть то значение OSRM_MAP_NAME, которое потом нужно указать в .env.
docker run --rm -v "$DATA:/data:z" "$OSRM_IMAGE" sh -c "
  set -e
  [ -f /data/$NAME.osrm ] || osrm-extract -p /opt/car.lua /data/$NAME.osm.pbf --threads $THREADS
  [ -f /data/$NAME.osrm.partition ] || {
    osrm-partition /data/$NAME.osrm --threads $THREADS
    osrm-customize /data/$NAME.osrm --threads $THREADS
  }"

cat <<DONE

$(date -u +%T) граф готов: $NAME
  1) в .env: OSRM_MAP_NAME=$NAME
  2) docker compose up -d --force-recreate osrm
  3) НЕ пересоздавайте контейнер, пока osrm-partition дописывает $NAME.osrm.partition:
     полуграфический файл выглядит как готовый, а routed на нём отвечает NoRoute на всё.
DONE
