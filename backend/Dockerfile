FROM python:3.12-slim

#
# Optional HTTP proxy for pip during the build (docker-compose.yml passes
# the ones from .env), re-exported as ENV for requests/geopy at runtime -
# compose sets them again at runtime too. Left empty in .env, they're a
# no-op and the backend reaches the internet directly.
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