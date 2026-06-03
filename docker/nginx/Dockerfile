FROM nginx:1-alpine

# Limit envsubst to the augchatd template var. Without this filter, the
# image substitutes every env var present in the container, which would
# clobber nginx's own $host/$proxy_add_x_forwarded_for/$ssl_client_verify
# references if any of those names ever leaked into the environment.
ENV NGINX_ENVSUBST_FILTER_VARS=AUGCHATD_DOMAIN

COPY nginx.conf.template /etc/nginx/templates/augchatd.conf.template
COPY entrypoint.sh /docker-entrypoint.d/00-require-certs.sh
RUN chmod +x /docker-entrypoint.d/00-require-certs.sh
