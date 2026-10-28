# eMajlis API — image de production (Railway).
# LibreOffice : conversion Word/Excel/PowerPoint en PDF (lecture et miniatures).
# Ghostscript : rendu de la première page des PDF, y compris en arabe.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    HOME=/tmp

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ghostscript \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-crosextra-carlito fonts-crosextra-caladea \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Données persistantes (inscriptions push, miniatures) : montez un volume Railway sur /app/data.
RUN mkdir -p /app/data /app/thumbnails
ENV PUSH_STORE_PATH=/app/data/push-devices.json \
    THUMB_CACHE_DIR=/app/data/thumbnails \
    OFFICE_CACHE_DIR=/app/data/thumbnails/pdf

EXPOSE 3000
CMD ["node", "src/server.js"]
