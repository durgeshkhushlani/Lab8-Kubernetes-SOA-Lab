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
- `.github/workflows/ci.yml` - a CI/CD workflow: checkout, install, test and Docker build for all four
  services, then publishing a **versioned (commit-SHA-tagged) image of each service to GitHub Container
  Registry**. The cluster is then moved onto one of those images with a rolling update (see "CI/CD").
- Health/readiness probes on every Deployment, documented below.

## Kubernetes environment used

**Docker Desktop's built-in Kubernetes**, single node, provisioned with **kubeadm** (Kubernetes v1.36.1),
context name `docker-desktop`. Chosen because it shares Docker Desktop's image cache - images built locally
as `*:v1` are usable straight away with `imagePullPolicy: IfNotPresent` - and because its `LoadBalancer`
Services map straight to `localhost` with no extra tooling. (Docker Desktop also offers a `kind`-based
provisioner; it needs the separate containerd image store enabled to see locally built images, so kubeadm
was the simpler choice here.)

Prerequisites: Docker Desktop with Kubernetes enabled (Settings -> Kubernetes), `kubectl` on the PATH, a
MongoDB Atlas cluster (external to the cluster, same as Lab 7), a GitHub repository (for Actions + GHCR), and
Postman. To access the cluster: `kubectl config current-context` must print `docker-desktop`.

A cloud cluster (GKE/EKS/AKS) would work the same way, with one difference: its nodes can't see images that
only exist in a local Docker cache, so the Deployments would reference the registry images from the start.

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

## Health & readiness probes

Every Deployment (gateway, user, product, order) declares both probes against the service's existing
`GET /health` endpoint (e.g. `k8s/user-deployment.yaml`):

```yaml
readinessProbe:
  httpGet: { path: /health, port: 3001 }
  initialDelaySeconds: 5
  periodSeconds: 5
livenessProbe:
  httpGet: { path: /health, port: 3001 }
  initialDelaySeconds: 15
  periodSeconds: 10
```

**Expected behavior:**

- **Readiness** answers "may this Pod receive traffic yet?". The services only start listening *after*
  `mongoose.connect()` to Atlas succeeds, so a new Pod reports `READY 0/1` until it is actually connected,
  then flips to `1/1` and only then is added to the Service's endpoints. This was visible live when
  `user-service` was scaled from 1 to 3 replicas: the two new Pods showed `0/1 Running` for a few seconds
  before becoming `1/1`.
- During a **rolling update** this is what keeps the system available: Kubernetes starts the replacement Pod,
  waits for it to pass readiness, and only then terminates an old one - a Pod that hasn't connected to the
  database never receives a request.
- **Liveness** answers "is this process still healthy?". If `/health` stops answering for several
  consecutive checks, the kubelet restarts the container - a hung process recovers without anyone
  intervening. (Self-healing for a *deleted* Pod is a different mechanism - the Deployment controller - shown
  in the self-healing section above.)

Verify a Pod reports Ready and see the probe settings Kubernetes is actually using:

```
kubectl get pods -n lab8
kubectl describe pod <pod-name> -n lab8 | findstr /i "Liveness Readiness Ready"
```

(`findstr` is the Windows `cmd` equivalent of `grep`; on Linux/macOS use `| grep -iE "liveness|readiness|ready"`.)

## GitHub Actions CI/CD

Flow: **Git push -> build/test -> Docker image -> container registry -> Kubernetes rollout -> verification.**
`.github/workflows/ci.yml` implements the first four stages automatically; the last two are a short,
documented `kubectl` procedure (explained below).

| Stage | Job | What happens | Runs on |
|---|---|---|---|
| Build & test | `build-test` (matrixed over `api-gateway`, `user-service`, `product-service`, `order-service`) | checkout, `npm ci`, `npm test` (each service's real `test/smoke.test.js` via Node's built-in runner), `docker build` | every push **and** pull request to `main` |
| Registry delivery | `publish` (same matrix, `needs: build-test`) | log in to GHCR with the run's automatic `GITHUB_TOKEN`, build, and push a versioned image | pushes to `main` only - pull requests never publish |

The matrix means each service builds, tests and publishes independently, and a failing test in one service
fails only that leg instead of hiding behind another's green result.

### Registry & image naming/tagging

- **Registry:** GitHub Container Registry (`ghcr.io`) - no extra account or stored password, because the
  workflow authenticates with the per-run `GITHUB_TOKEN` (`permissions: packages: write` on the `publish`
  job only).
- **Name:** `ghcr.io/<github-owner>/<service>:<tag>`, e.g.
  `ghcr.io/durgeshkhushlani/user-service:<tag>` (the owner is lower-cased by the workflow, since GHCR
  requires lowercase).
- **Tag:** the full **Git commit SHA** (`${{ github.sha }}`) - every image traces back to exactly one commit,
  and a tag is never reused, so "what is running?" always has a precise answer. (Local baseline images
  from earlier in this lab keep their simple `v1` tag.)
- Each image carries an `org.opencontainers.image.source` label pointing at this repository, which is what
  links the package to the repo in GitHub's UI.
- **No secrets in images:** `.dockerignore` excludes `.env`; the MongoDB URIs reach containers only through
  the Kubernetes `Secret` at run time.

### Kubernetes image update / rollout procedure

The GitHub-hosted runner cannot reach a cluster that lives on `localhost` inside Docker Desktop, so the
last stage is performed by hand against the local cluster (with a cloud cluster this would be one more
workflow job using a kubeconfig stored as a repository secret). This is "continuous *delivery*" - CI produces
and delivers a validated, versioned artifact; a person decides when to roll it out.

1. Push to `main`; wait for the `publish` jobs to finish (Actions tab).
2. The package must be readable by the cluster: in GitHub -> Packages -> `<service>` -> Package settings,
   set visibility to **Public** (the images contain no secrets), otherwise the pull fails with
   `ImagePullBackOff` (a private package would need an `imagePullSecret`).
3. Take the commit SHA that was published: `git rev-parse HEAD` (or copy it from the package's tag list).
4. Roll the Deployment onto that image:

```
kubectl set image deployment/user-service user-service=ghcr.io/durgeshkhushlani/user-service:<full-commit-sha> -n lab8
kubectl rollout status deployment/user-service -n lab8
kubectl get pods -n lab8 -l app=user-service
kubectl describe deployment user-service -n lab8 | findstr /i "Image"
```

5. `rollout status` ends with `successfully rolled out`; `get pods` shows the old Pods being replaced one
   at a time (the default `RollingUpdate` strategy - readiness probes gate each step); `describe` shows the
   new image reference. To undo: `kubectl rollout undo deployment/user-service -n lab8`.
6. Verify end to end: `GET /users` through the gateway still returns `200`.

Note: after `kubectl set image` the live Deployment is intentionally ahead of the YAML in `k8s/`, which still
describes the local `user-service:v1` baseline - that is the normal consequence of an imperative rollout.

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

### Application metrics vs. infrastructure metrics

- **Application metrics** (what the dashboard is built around): request rate, error rate and latency from
  `http_requests_total` / `http_request_duration_seconds`, exposed by each service at `/metrics`. These answer
  "is the *system* working for its users?".
- **Basic workload health:** the `up` metric per target (Prometheus can scrape the Pod behind each Service),
  together with the Kubernetes-side signals already covered in this README - Deployment `READY` counts,
  readiness/liveness probes, and Pod restarts in `kubectl get pods`. `prom-client`'s default metrics
  (`process_resident_memory_bytes`, `process_cpu_seconds_total`, event-loop lag) are also being collected per
  service and can be queried the same way.
- **Infrastructure metrics** (Pod/container/node CPU & memory from the kubelet, Deployment replica state as
  metrics) would need extra components - cAdvisor/kubelet scraping, `kube-state-metrics`, `node-exporter`,
  usually installed together as `kube-prometheus-stack`. They are deliberately out of scope for this lab,
  which prioritizes application request/error/latency metrics.

**Scrape-target caveat:** Prometheus targets the `ClusterIP` Service name (e.g. `user-service:3001`, same
style as the handout's `gateway-service:8080` example), so with several replicas each scrape lands on
whichever Pod the Service picks. Per-Pod series would need Kubernetes service discovery
(`kubernetes_sd_configs` plus RBAC) - an easy next step, but not needed for the availability/traffic/error/
latency questions this lab asks.

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

### Delivery pipeline (how a code change reaches the cluster)

```
 git push to main
        │
        ▼
 GitHub Actions  ── build-test (x4 services) ──▶ npm ci · npm test · docker build
        │  (all four green)
        ▼
 publish (x4) ──▶ GHCR:  ghcr.io/durgeshkhushlani/<service>:<commit-SHA>      <- versioned image
        │
        ▼   kubectl set image deployment/<service> <service>=ghcr.io/...:<commit-SHA> -n lab8
 Kubernetes (namespace lab8): rolling update, each new Pod gated by its readiness probe
        │
        ▼
 Verify: kubectl rollout status · GET /users through the gateway · Prometheus/Grafana keep scraping
```

## Troubleshooting

- **`ImagePullBackOff` after rolling out a registry image** - the most likely cause is that the GHCR package
  is still *private* (new packages default to private), so the cluster's anonymous pull is rejected. Check
  with `kubectl describe pod <pod> -n lab8` (Events section). Fix: set the package's visibility to Public
  (it contains no secrets) or add an `imagePullSecret`. `kubectl rollout undo deployment/<service> -n lab8`
  returns to the previous working image in the meantime.
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

## Evidence (screenshots/)

| # | Handout evidence | Screenshot / file |
|---|---|---|
| 1 | Lab 7 baseline | `01-lab7-baseline-health` |
| 2 | Kubernetes environment (context + node) | `02-kubectl-context-nodes` |
| 3 | Manifests (gateway, services, configuration) | the YAML files in `k8s/` (`k8s/templates/` holds the secret *template* only) |
| 4 | Deployment (Pods, Deployments, Services in `lab8`) | `03-deployments-pods-services` |
| 5 | Gateway test through Kubernetes | `04a-gateway-service`, `04b-postman-users`, `04c-postman-orders` |
| 6 | Scaling `user-service` to 3 replicas | `05-scaling-3-replicas` |
| 7 | Self-healing | `self-healing-before-after` |
| 8 | Troubleshooting (describe / logs / endpoints) | `troubleshooting-describe-logs-endpoints` |
| 9 | GitHub Actions run | `github-actions-ci-run` (first CI run), `github-actions-cicd-run` (CI/CD run with the `publish` jobs) |
| 10 | Prometheus targets + query | `prometheus-targets`, `prometheus-query-up` |
| 11 | Grafana dashboard | `grafana-dashboard-initial` |
| 12 | Traffic observed in monitoring | `grafana-dashboard-after-traffic` |
| 13 | Architecture | `architecture-diagram` (the pipeline diagram above is the delivery-flow companion) |
| new | Probe configuration + Pod Ready | `probes-config-and-ready` |
| new | Versioned image in the container registry | `ghcr-versioned-image` |
| new | Kubernetes rollout to the new image | `rollout-user-service-new-image` |

Also required by the handout, covered in this README: container registry naming/tagging approach and the CI/CD
stages with the rollout procedure ("GitHub Actions CI/CD" above), and the probe configuration and expected
behavior ("Health & readiness probes" above). No credentials are committed: `.env` files and
`k8s/mongo-secret.yaml` are git-ignored, the Secret is created on the cluster with `kubectl create secret`, and
GHCR is accessed with the per-run `GITHUB_TOKEN`.
