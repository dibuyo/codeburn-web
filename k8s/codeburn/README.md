# Codeburn en k3s

Codeburn esta publicado en el cluster local k3s como servicio interno de infraestructura.

## URL

- https://codeburn.home/

## Recursos

- Contexto Kubernetes: `k3s-local`
- Namespace: `infrastructure`
- Deployment: `codeburn`
- Service: `codeburn:8787`
- IngressRoute: `codeburn-home`
- PVC: `codeburn-data` de 1Gi con `local-path`, montada como config de Codeburn upstream
- Imagen en containerd del nodo k3s: `codeburn-web:upstream-20260703-2319`
- Fuente de la imagen: `https://github.com/getagentseal/codeburn` (`1678cbd`, version `0.9.15`)
- Comando de inicio: `codeburn web --no-open --port 8787`

## Datos y lecturas locales

La imagen actual usa el upstream de Codeburn. La PVC local-path se monta como configuracion persistente:

- `codeburn-data` -> `/home/node/.config/codeburn`

Los historiales locales se leen mediante NFS desde `raspi5`:

- `/home/martin/.openclaw` -> `/home/node/.openclaw` solo lectura
- `/home/martin/.claude` -> `/home/node/.claude` solo lectura
- `/home/martin/.codex` -> `/home/node/.codex` solo lectura

No hay secretos propios de Codeburn en Kubernetes.

## Imagen upstream

El upstream bindearia por defecto solo en `127.0.0.1` y rechazaria hosts externos para proteger contra DNS rebinding. Para publicarlo por Traefik se construye una imagen local con un parche minimo en `src/web-dashboard.ts`:

- `CODEBURN_ALLOW_REMOTE=1` permite requests por `codeburn.home`
- `HOST=0.0.0.0` hace que el dashboard escuche dentro del pod

Los archivos de build local estan en:

```bash
/home/martin/.openclaw/workspace/developer/codeburn-upstream/Dockerfile.k3s
/home/martin/.openclaw/workspace/developer/codeburn-upstream/patch_remote.js
```

## Comandos utiles

```bash
kubectl --context k3s-local -n infrastructure get pods -l app=codeburn
kubectl --context k3s-local -n infrastructure logs deploy/codeburn -f
kubectl --context k3s-local -n infrastructure rollout restart deploy/codeburn
kubectl --context k3s-local -n infrastructure get ingressroute codeburn-home
curl -I https://codeburn.home/
curl -fsS https://codeburn.home/api/usage | head
```

## Docker anterior

El proyecto ya vive en:

```bash
/home/martin/.openclaw/workspace/developer/codeburn-web
```

El compose anterior se bajo con:

```bash
cd /home/martin/.openclaw/workspace/developer/codeburn-web
docker compose down
```
