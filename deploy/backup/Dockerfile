# Backup image: the Postgres client tools of the server version plus the openssl CLI, which the
# plain postgres:16-alpine image is not guaranteed to include (it ships the libraries, not the tool).
FROM postgres:16-alpine
RUN apk add --no-cache openssl
COPY backup.sh /backup.sh
COPY check-anchors.sh /check-anchors.sh
ENTRYPOINT ["sh", "/backup.sh"]
