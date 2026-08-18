FROM python:3.12-slim

WORKDIR /app

#
# Optional: only present if backend/export-zscaler-cert.ps1 has been run on
# this machine. The bracket glob keeps this from failing the build when the
# file doesn't exist - a plain filename would.
#
COPY zscaler-root-ca.cr[t] /usr/local/share/ca-certificates/zscaler-root-ca.crt

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]