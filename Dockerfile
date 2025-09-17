# Imagem oficial já vem com Chromium + deps corretas
FROM mcr.microsoft.com/playwright/python:v1.46.0-jammy

WORKDIR /app

# Instala apenas as libs Python do projeto
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copia o código
COPY . .

# Porta do FastAPI (uvicorn)
EXPOSE 8000

# Sobe a API
CMD ["uvicorn", "app.main:app", "--host","0.0.0.0", "--port","8000"]