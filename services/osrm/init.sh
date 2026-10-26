#!/bin/sh
# Собирает граф OSRM из выгрузки дорог и поднимает routed.
# Первый запуск: extract + partition + customize (минуты-десятки, зависит от bbox).
# Дальше граф лежит в ./osrm-data — старт занимает секунды.
set -eu

NAME="${OSRM_MAP_NAME:-center}"
THREADS="${OSRM_THREADS:-4}"
DATA=/data

cd "$DATA"

SRC=""
for candidate in "$NAME.osm.pbf" "$NAME.osm" "$NAME.osm.bz2"; do
  if [ -f "$candidate" ]; then
    SRC="$candidate"
    break
  fi
done

# osrm-extract называет результат по входу (moscow.osm → moscow.osrm), поэтому граф
# ищем по имени выбранной выгрузки: в ./osrm-data может лежать и старый, и новый набор.
GRAPH="$NAME.osrm"

if [ ! -f "$GRAPH" ]; then
  if [ -z "$SRC" ]; then
    echo "В $DATA нет ни $NAME.osm.pbf, ни $NAME.osm — строить граф не из чего." >&2
    echo "Выгрузка дорог: scripts/osrm-prepare.sh (bbox меняется переменной BBOX)." >&2
    exit 1
  fi
  echo "$(date -u +%T) osrm-extract $SRC"
  osrm-extract -p /opt/car.lua "$SRC" --threads "$THREADS"
  # osrm-extract снимает расширение по-своему; если суффикс не совпал — берём единственный граф в каталоге
  [ -f "$GRAPH" ] || GRAPH="$(ls -1t ./*.osrm 2>/dev/null | head -1 || true)"
fi

echo "$(date -u +%T) граф: $GRAPH"

# OSRM добавляет расширения к полному имени графа: из moscow-csfo-roads.osrm получается
# moscow-csfo-roads.osrm.partition, а не moscow-csfo-roads.partition.
if [ ! -f "$GRAPH.partition" ]; then
  echo "$(date -u +%T) osrm-partition $GRAPH"
  osrm-partition "$GRAPH" --threads "$THREADS"
  echo "$(date -u +%T) osrm-customize $GRAPH"
  osrm-customize "$GRAPH" --threads "$THREADS"
fi

echo "$(date -u +%T) osrm-routed :5000 (algorithm=mld)"
exec osrm-routed --algorithm mld "$GRAPH" --threads "$THREADS"
