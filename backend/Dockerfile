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

#
# The vehicle cutout model (Detect vehicle in the Vehicle Models editor -
# see cut_out_vehicle() in app.py): IS-Net "general use", the open-source
# salient-object model rembg ships, ~180 MB. Downloaded once here, through
# the build proxy, so the backend runs it fully offline. Its own layer, so
# app changes don't download it again.
#
ARG CUTOUT_MODEL_URL=https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
ENV CUTOUT_MODEL_PATH=/models/isnet-general-use.onnx

RUN mkdir -p /models && python -c "import os, urllib.request; urllib.request.urlretrieve(os.environ['CUTOUT_MODEL_URL'], os.environ['CUTOUT_MODEL_PATH'])"

COPY . .

EXPOSE 5000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]