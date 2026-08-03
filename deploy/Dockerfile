FROM node:22.19-bookworm-slim AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_GOOGLE_ENABLED=true
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_GOOGLE_ENABLED=$VITE_SUPABASE_GOOGLE_ENABLED
RUN npm run build

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AXIOM_CHEMISTRY_PYTHON=/usr/local/bin/python \
    AXIOM_CHEMISTRY_URL=http://127.0.0.1:8791 \
    AXIOM_CHEMISTRY_HOST=127.0.0.1 \
    AXIOM_CHEMISTRY_PORT=8791

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libexpat1 \
        libgomp1 \
        libsm6 \
        libstdc++6 \
        libxext6 \
        libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/requirements-admet.txt /tmp/requirements-admet.txt
RUN pip install --no-cache-dir -r /tmp/requirements-admet.txt
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=web-build /app /app

RUN mkdir -p /app/services/artifacts /app/services/receptors /tmp/axiom-matplotlib
EXPOSE 10000
CMD ["node", "scripts/start-production.mjs"]
