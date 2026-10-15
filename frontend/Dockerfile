FROM nginx:alpine

COPY . /usr/share/nginx/html

# Rendered with PROXY_SECRET at start (see the template).
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY require-proxy-secret.sh /docker-entrypoint.d/05-require-proxy-secret.sh
RUN chmod +x /docker-entrypoint.d/05-require-proxy-secret.sh \
 && rm -f /usr/share/nginx/html/nginx.conf.template \
          /usr/share/nginx/html/require-proxy-secret.sh

EXPOSE 80
