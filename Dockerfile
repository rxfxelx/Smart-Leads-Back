# Imagem base com Node.js 20 e Debian (para suportar Python)
FROM node:20-bullseye

# Instalar Python e pip
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Define a pasta principal da aplicação
WORKDIR /app

# Copia os arquivos de dependência Node
COPY package*.json ./

# Instala as dependências Node (sem as de desenvolvimento)
RUN npm ci --omit=dev

# Copia o restante do código para dentro do container
COPY . .

# Instala as dependências Python do scraper
RUN pip3 install --no-cache-dir -r scraper/requirements.txt

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# Expor a porta (Railway vai mapear)
EXPOSE 8080

# Comando para rodar o app
CMD ["node","server/src/server.js"]
