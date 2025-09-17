FROM node:20-bullseye

# Python + utilitários
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps
COPY package*.json ./
RUN npm install --omit=dev   # já que você não tem package-lock.json

# Código
COPY . .

# Python deps
RUN pip3 install --no-cache-dir -r scraper/requirements.txt
# Instala Chromium para o Playwright
RUN python3 -m playwright install --with-deps chromium

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["node","server/src/server.js"]
