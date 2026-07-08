FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/styles.css /usr/share/nginx/html/static/styles.css
COPY frontend/app.js /usr/share/nginx/html/static/app.js

EXPOSE 80
