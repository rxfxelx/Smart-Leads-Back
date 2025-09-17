FROM python:3.11-slim

# Dependências
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl fonts-liberation wget gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Instala Chromium + deps do Playwright
RUN python -m playwright install --with-deps chromium

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host","0.0.0.0", "--port","8000"]
