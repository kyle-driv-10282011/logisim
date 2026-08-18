FROM python:3.12-slim

#
# Outbound traffic (geocoding/routing calls to the public internet) goes
# through this proxy, which reaches the internet directly rather than
# through Zscaler's TLS-inspecting path - so no Zscaler root CA needs to be
# trusted here. Declared as ARGs so `docker compose build` can pass them
# through for pip during the build, and re-exported as ENV so they're also
# set at runtime for requests/geopy. Left blank, they're a no-op and this
# image falls back to reaching the internet directly.
#
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY}

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]