# osmium-tool в контейнере: резать выгрузки OSM без установки пакета на хост.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["osmium"]
