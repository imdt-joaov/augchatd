FROM alpine:3.20
RUN apk add --no-cache certbot openssl
COPY letsencrypt.sh /usr/local/bin/letsencrypt.sh
RUN chmod +x /usr/local/bin/letsencrypt.sh
WORKDIR /out
ENTRYPOINT ["/usr/local/bin/letsencrypt.sh"]
