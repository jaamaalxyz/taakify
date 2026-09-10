# pg_dump sidecar: same Postgres major as the server (docker-compose.prod.yml
# postgres:17-alpine) so the dump format always matches, plus rclone for the
# off-VM push and curl for the Sentry failure alert.
FROM postgres:17-alpine

RUN apk add --no-cache rclone curl

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
