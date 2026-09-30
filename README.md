# Lab 8 - Kubernetes, Basic CI/CD & Monitoring

Web Services & SOA Laboratory. Lab 7 gave the User/Product/Order microservices a real API Gateway and
config-based service discovery and put them on Render. Lab 8 moves orchestration onto **Kubernetes**
(deployments, services, scaling, self-healing), adds a **basic GitHub Actions CI workflow**, and adds real
**Prometheus + Grafana monitoring** on top of the running system. The application itself - routes, status
codes, database-per-service design - is unchanged from Lab 7; nothing here is a rebuild.

**Application flow (unchanged):** Client/Postman → API Gateway → User/Product/Order Services → MongoDB
Atlas. MongoDB stays external to the cluster, exactly as the handout requires - only the application layer
moves into Kubernetes.

## What's new vs. Lab 7

- Every service now exposes `GET /metrics` (Prometheus text format, via `prom-client`) alongside its
  existing `GET /health`. `metrics.js` in each service is a small shared module: a `Counter`
  (`http_requests_total`) and a `Histogram` (`http_request_duration_seconds`), both labeled by
  `method`/`route`/`status`. The gateway labels metrics by *target service name* rather than raw path, to
  keep the number of distinct time series small (a raw path like `/users/670a1b2c...` would create a new
  series per request).
- A minimal `test/smoke.test.js` per service (Node's built-in `node:test` runner, no extra dependency) - just
  enough for the CI workflow's "run tests" step to mean something real, not a placeholder that always
  passes: it actually asserts on schema shape (required fields, the unique-email index) and module exports.
- `k8s/` - Kubernetes manifests for all four services plus Prometheus/Grafana.
- `.github/workflows/ci.yml` - checkout, install, test, Docker build, matrixed across all four services.

## Kubernetes environment used

_Fill in once set up:_ Docker Desktop's built-in Kubernetes (simplest for local development - shares the
same Docker image cache used to build `*.:v1` images in Labs 5-7, and its `LoadBalancer` Services map
straight to `localhost` with no extra tooling) **or** a cloud cluster (GKE/EKS/AKS) if used instead - if so,
image names in the manifests need to point at a pushed registry image (e.g. Docker Hub) rather than a local
tag, since a cloud cluster's nodes can't see images that only exist in a local Docker Desktop cache.

## Namespace, ConfigMap, Secret

Everything for this lab lives in the `lab8` namespace (`kubectl create namespace lab8`), created once before
anything else is applied.

`k8s/configmap.yaml` holds every **non-sensitive** value the services need - internal Service URLs and
ports - read into each container via `env.valueFrom.configMapKeyRef`. Nothing in it is a secret.

MongoDB connection strings **are** sensitive and go in a `Secret`, never the ConfigMap and never committed.
`k8s/templates/mongo-secret.example.yaml` is a template only (with `<user>`/`<pass>` placeholders, deliberately
kept **outside** the flat `k8s/` folder so a plain `kubectl apply -f k8s/` can never pick it up and overwrite
the real Secret with these placeholders) - the real Secret is
created directly on the cluster and never touches disk in this repo:

```bash
kubectl create secret generic mongo-secrets -n lab8 \
  --from-literal=USER_MONGODB_URI='mongodb+srv://<user>:<pass>@<cluster>/lab8_user?retryWrites=true&w=majority' \
  --from-literal=PRODUCT_MONGODB_URI='mongodb+srv://<user>:<pass>@<cluster>/lab8_product?retryWrites=true&w=majority' \
  --from-literal=ORDER_MONGODB_URI='mongodb+srv://<user>:<pass>@<cluster>/lab8_order?retryWrites=true&w=majority'
```

Same Atlas cluster used since Lab 4/5/7 - just three more database names, one per service.

## Building the images (for a local Docker-Desktop-Kubernetes cluster)

```bash
docker build -t api-gateway:v1 ./api-gateway
docker build -t user-service:v1 ./user-service
docker build -t product-service:v1 ./product-service
docker build -t order-service:v1 ./order-service
```

Each Deployment manifest sets `imagePullPolicy: IfNotPresent`, so Kubernetes uses these local images
directly - no registry push needed when the cluster and the Docker daemon that built the images are the same
machine (true for Docker Desktop's Kubernetes; **not** true for a separate cloud cluster).

## Applying the manifests

```bash
kubectl config current-context
kubectl get nodes
kubectl create namespace lab8

kubectl apply -f k8s/configmap.yaml
# create the mongo-secrets Secret (command above) before this next line
kubectl apply -f k8s/ -n lab8
kubectl apply -f k8s/monitoring/ -n lab8

kubectl get deployments -n lab8
kubectl get pods -n lab8
kubectl get services -n lab8
```

## Accessing the gateway

```bash
kubectl get service api-gateway -n lab8
```

On Docker Desktop's Kubernetes, a `LoadBalancer` Service's `EXTERNAL-IP` resolves to `localhost`, so the
gateway is reachable at `http://localhost:3000` directly. If `EXTERNAL-IP` stays `<pending>` (common outside
Docker Desktop), fall back to:

```bash
kubectl port-forward service/api-gateway 3000:3000 -n lab8
```

Test with the same Postman collection from Lab 7 (`postman/Microservices-Lab7-Gateway.postman_collection.json`),
`gateway_base` set to `http://localhost:3000`.

## Scaling

```bash
kubectl scale deployment user-service --replicas=3 -n lab8
kubectl get pods -n lab8
```

The `user-service` Service's ClusterIP and DNS name don't change - it load-balances across however many
Pods currently match its selector, which is the entire point of never addressing a Pod by its own IP.

## Self-healing

```bash
kubectl get pods -n lab8
kubectl delete pod <a-user-service-pod-name> -n lab8
kubectl get pods -n lab8
```

The Deployment's controller notices the actual replica count dropped below the desired count and creates a
replacement Pod automatically - nothing manual restarts it.

## Troubleshooting commands

```bash
kubectl describe pod <pod-name> -n lab8
kubectl logs <pod-name> -n lab8
kubectl get endpoints -n lab8
```

`get endpoints` is the fastest way to tell "wrong selector" apart from "Pod not ready yet" - an empty
endpoint list for a Service means its selector doesn't match any Pod's labels at all, while a Service with
endpoints listed but requests still failing usually means the Pods exist but aren't passing their readiness
probe yet.

## GitHub Actions CI

`.github/workflows/ci.yml` runs on every push/PR to `main`, matrixed across all four services
(`api-gateway`, `user-service`, `product-service`, `order-service`) so the same four steps - checkout,
`npm ci`, `npm test`, `docker build` - run independently for each one and a failure in one service's tests
doesn't hide a problem in another's. `npm test` runs each service's real `test/smoke.test.js` via Node's
built-in test runner (`node --test`) - no external test framework needed.

## Prometheus

Deployed as its own Pod (`k8s/monitoring/prometheus-deployment.yaml`) with its scrape config
(`k8s/monitoring/prometheus-config.yaml`) targeting all four services by their Kubernetes Service DNS name,
e.g. `user-service:3001`, at `/metrics`:

```yaml
scrape_configs:
  - job_name: 'user-service'
    static_configs:
      - targets: ['user-service:3001']
# ...same pattern for api-gateway (3000), product-service (3002), order-service (3003)
```

Access Prometheus the same way as the gateway (`LoadBalancer` → `localhost:9090`, or
`kubectl port-forward service/prometheus 9090:9090 -n lab8`). Useful checks:

- **Status → Targets** - all four should show `UP`.
- Query `up{job=~"api-gateway|user-service|product-service|order-service"}` - `1` per target.
- Query `rate(http_requests_total[5m])` - request rate per service/route, should visibly rise after
  generating Postman traffic.

## Grafana

Pre-provisioned (`k8s/monitoring/grafana-provisioning.yaml` +
`k8s/monitoring/grafana-dashboard-configmap.yaml`) with the Prometheus datasource and a **Lab 8** dashboard
already loaded on startup - nothing to click through manually beyond logging in
(`admin`/`admin`, Grafana's own default - you'll be prompted to change it on first login).

Dashboard panels, each answering one of the handout's suggested monitoring questions:

| Panel | Question it answers | Query |
|---|---|---|
| Targets Up | Are targets reachable? | `up{job=~"api-gateway\|user-service\|product-service\|order-service"}` |
| Request Rate | How much traffic is arriving? | `sum(rate(http_requests_total[1m])) by (job)` |
| Error Rate (5xx) | Are failures increasing? | `sum(rate(http_requests_total{status=~"5.."}[1m])) by (job)` |
| P95 Latency | How long are requests taking? | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job))` |

Access the same way as Prometheus (`localhost:3300`, or
`kubectl port-forward service/grafana 3300:3300 -n lab8` - note the Service port is `3300`, not `3000`, so
port-forwarding both the gateway and Grafana at once never collides).

## Generating traffic & observing it

1. Run the Postman collection against `http://localhost:3000` (or the port-forwarded URL) a handful of times
   - `GET /users`, `GET /products`, a `POST /orders`.
2. Open Prometheus, re-run `rate(http_requests_total[5m])` - the graph should show a visible bump.
3. Open Grafana's Lab 8 dashboard - Request Rate panel reflects the same traffic within one scrape interval
   (15s).
4. Safe controlled failure experiment: hit a route that 404s (`GET /nope` through the gateway, or
   `GET /users/<a-bogus-id>`) a few times, then check Grafana's Error Rate panel - it only counts `5xx`, so a
   `404` intentionally won't move that panel; this is a useful thing to point out in evidence, since it shows
   the metric is actually discriminating between "client sent something wrong" (4xx, not an error in *our*
   system) and "our system failed" (5xx) rather than just counting all non-2xx responses as "errors."

## Architecture

```
                              Client / Postman
                                     │
                                     ▼
                        ┌─────────────────────┐
                        │  api-gateway Service │  LoadBalancer -> localhost:3000 (only Service exposed externally)
                        └──────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
   ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
   │ user-service Svc    │ │ product-service Svc │ │ order-service Svc  │   ClusterIP - internal only
   │ (ClusterIP)         │ │ (ClusterIP)          │ │ (ClusterIP)         │
   └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘
              │ Deployment (1-3 replicas, self-healing)        │ REST/JSON (Order -> User, Order -> Product)
              ▼                                                 ▼
        MongoDB Atlas (external, per-service database)  ────────┘

   ┌─────────────────────────────────────────────────────────────┐
   │  Prometheus  ──scrapes /metrics on all 4 services──▶         │   both LoadBalancer,
   │  Grafana     ──queries Prometheus, dashboards────────────────│   localhost:9090 / :3300
   └─────────────────────────────────────────────────────────────┘

                      all of the above inside namespace: lab8
```

## Troubleshooting

- **`kubectl apply -f k8s/` silently overwrote the real `mongo-secrets` Secret with placeholder values** the
  first time this was applied - the template file `mongo-secret.example.yaml` was originally sitting
  directly inside `k8s/`, and `kubectl apply -f k8s/` applies every YAML file in that folder (not
  recursively into `k8s/monitoring/`, but everything at that top level), so it merged the example's literal
  `<user>`/`<pass>` strings onto the real Secret created moments earlier via `kubectl create secret`. Fixed
  by moving the template to `k8s/templates/` (outside the flat apply path) and recreating the real Secret.
  Lesson: anything that must never be auto-applied doesn't belong in the same flat directory as the things
  you `kubectl apply -f <dir>/` in bulk.
- **Grafana's container port (3000) is the same number as the gateway's** - purely coincidental (two
  unrelated images both defaulting to port 3000), not a real conflict since each runs in its own Pod. Set
  Grafana's *Service* port to `3300` specifically so port-forwarding both at once never collides on the host
  side.
- **Metrics cardinality**: the gateway's logging middleware already resolved a request's target service name
  for its console log line; the metrics middleware reuses that same resolution as the Prometheus `route`
  label instead of the raw request path, which would otherwise create a new time series per unique id
  requested (`/users/507f1f77...`, `/users/507f191e...`, ...) and make Prometheus's cardinality blow up over
  time.
- **`npm test` needed an actual test, not a stub** - the handout's example workflow runs `npm test`
  unconditionally; a package.json with no `test` script makes `npm test`/`npm ci`'s post-install lifecycle
  fail the whole CI run. Added a real (if small) `node:test` suite per service instead of a placeholder that
  always exits 0, so a genuinely broken schema/module would actually fail CI.
- (Carried forward from Labs 5-7) if Docker Desktop's engine won't start with a
  "file cannot be accessed by the system" error on a socket under `%LOCALAPPDATA%\Docker\run`, quit Docker
  Desktop fully, rename (don't delete) that stuck file/folder, relaunch - documented in detail in the Lab 5
  README.

## Submission checklist cross-reference

Every item in the handout's Section 7.1 evidence table is covered by a screenshot in `screenshots/` (see
that folder) plus the source-of-truth files already in this repo: manifests in `k8s/`, the CI workflow in
`.github/workflows/ci.yml`, the Grafana dashboard definition in
`k8s/monitoring/grafana-dashboard-configmap.yaml`, and the architecture diagram above.
