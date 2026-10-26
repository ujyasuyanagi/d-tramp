#!/bin/sh
# Готовит выгрузку дорог для OSRM: скачивает OSM XML с Overpass в osrm-data/,
# контейнер osrm потом сам соберёт из него граф (первый запуск — десятки минут).
#
# Overpass QL не отдаёт бинарный PBF, только XML; osrm-extract читает XML как есть.
# Публичные зеркала периодически отдают «server too busy», поэтому перебираем несколько.
#
#   scripts/osrm-prepare.sh                       # дефолтный набор bbox
#   BBOX=59.85,29.90,60.05,30.40 scripts/osrm-prepare.sh          # другой город
#   BBOX="b1 b2 b3" NAME=center scripts/osrm-prepare.sh           # несколько рамок в одной выгрузке
#
# Рамок может быть несколько (через пробел): так дешевле покрывать междугородний
# коридор — трассу, а не квадрат на 200 км в сторону от неё.
set -eu

# Москва (где ездит парк) + коридор М-10 до Твери: без него междугородние поездки
# считать по дорогам нечем, и trip-service остаётся только прямая.
BBOX="${BBOX:-55.66,37.45,55.86,37.79 55.86,36.40,56.45,37.60 56.40,35.50,56.90,36.60 56.80,35.60,57.05,36.20}"
NAME="${NAME:-center}"
UA="D-Tramp-dev/0.1 (D-Tramp coursework, contact: none)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/osrm-data"
MIN_BYTES="${MIN_BYTES:-2000000}"
# Место на диске кончается быстрее, чем терпение: не тянем выгрузку гигантской.
MAX_BYTES="${MAX_BYTES:-1200000000}"

mkdir -p "$OUT_DIR"
QUERY="$OUT_DIR/$NAME.query.ql"
UNION=""
for box in $BBOX; do
  UNION="$UNION way[\"highway\"]($box);"
done
cat > "$QUERY" <<QLEOF
[out:xml][timeout:3600];
( $UNION );
out body;
>;
out skel qt;
QLEOF

for host in \
  https://maps.mail.ru/osm/tools/overpass/api/interpreter \
  https://overpass.private.coffee/api/interpreter \
  https://overpass-api.de/api/interpreter \
  https://overpass.kumi.systems/api/interpreter
do
  echo "== $host $(date +%T)"
  # shellcheck disable=SC2086
  if curl -sS -A "$UA" --compressed --max-time 3600 --retry 2 --retry-delay 10 \
       --max-filesize "$MAX_BYTES" \
       --data-urlencode "data@$QUERY" -o "$OUT_DIR/$NAME.osm" \
       -w "http=%{http_code} bytes=%{size_download}\n" "$host" \
     && [ "$(wc -c < "$OUT_DIR/$NAME.osm")" -gt "$MIN_BYTES" ]; then
    echo "готово: $OUT_DIR/$NAME.osm ($(du -h "$OUT_DIR/$NAME.osm" | cut -f1))"
    exit 0
  fi
  echo "не подошло, пробуем следующее зеркало"
  sleep 20
done

echo "Ни одно зеркало Overpass не отдало выгрузку. Повтори позже или укажи OSRM_PBF_URL:" >&2
echo "  curl -o osrm-data/$NAME.osm.pbf <ссылка на .osm.pbf>" >&2
exit 1
