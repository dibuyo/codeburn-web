# CodeBurn Web en Docker

El servicio corre `server.js` en Node dentro de Docker y persiste la base SQLite/WAL/SHM y logs con el bind mount local `./data:/app/data`.

## Comandos

```bash
# levantar en background
./start.sh
# o: docker compose up -d

# parar
docker compose down

# ver logs
docker compose logs -f codeburn-web

# rebuild + levantar
docker compose up -d --build

# status del contenedor
docker compose ps

# probar API
curl http://127.0.0.1:8787/api/status
```

El compose expone `8787` en `0.0.0.0` y usa `restart: unless-stopped` para que Docker lo reinicie automáticamente al boot.
