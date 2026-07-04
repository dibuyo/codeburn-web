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
- PVC: `codeburn-data` de 1Gi con `local-path`
- Imagen en containerd del nodo k3s: `codeburn-web:v0.9.8`

## Datos y lecturas locales

El pod mantiene una copia inicial de los datos que usaba Docker en una PVC local-path:

- `codeburn-data` -> `/app/data`

Los historiales locales se leen mediante NFS desde `raspi5`:

- `/home/martin/.openclaw` -> `/home/node/.openclaw` solo lectura
- `/home/martin/.claude` -> `/home/node/.claude` solo lectura
- `/home/martin/.codex` -> `/home/node/.codex` solo lectura

No hay secretos propios de Codeburn en Kubernetes.

## Comandos utiles

```bash
kubectl --context k3s-local -n infrastructure get pods -l app=codeburn
kubectl --context k3s-local -n infrastructure logs deploy/codeburn -f
kubectl --context k3s-local -n infrastructure rollout restart deploy/codeburn
kubectl --context k3s-local -n infrastructure get ingressroute codeburn-home
curl -I https://codeburn.home/
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
