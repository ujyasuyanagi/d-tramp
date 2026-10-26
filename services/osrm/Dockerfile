FROM osrm/osrm-backend:v5.25.0

COPY services/osrm/init.sh /init.sh

ENTRYPOINT ["/bin/sh", "/init.sh"]
