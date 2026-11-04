# Argus — Google Cloud Deployment Guide

**Target:** Google Cloud Run (6 services) · Artifact Registry · Secret Manager · Cloud Storage · Cloud NAT · Cloud Logging, with MongoDB Atlas as the database and the Meta Model API for models.
**Status:** deployment plan for the hackathon build (not yet executed). Commands use `gcloud` and Docker; replace the variables in §2.

---

## 1. What gets deployed

| Cloud Run service | Image | Port | Role | Ingress | Instances |
|---|---|---|---|---|---|
| `argus-api` | `argus-api` (Dockerfile.api) | 8000 | Web app + public API: ingestion, sessions, analysis queue, SSE, closure, dossier | public | **exactly 1** (min 1, max 1), CPU always allocated |
| `argus-orchestrator` | `argus-inspection` (Dockerfile.inspection) | 8100 | Inspection orchestrator: SAM 3.1, routing, work-order reader, video tracking | internal | 1 |
| `argus-video-agent` | `argus-inspection` | 8101 | Muse Spark on video keyframes | internal | 1–3 |
| `argus-image-agent` | `argus-inspection` | 8102 | Muse Spark → Muse Wonder on photographs | internal | 1–3 |
| `argus-pointcloud-agent` | `argus-inspection` | 8103 | Open3D merged-scan registration vs CAD | internal | 1 |
| `argus-simulator` | `argus-simulator` (simulator repo) | 4173 | Prepared-evidence sender (demo) | public | 1 |

Shared resources:

- **Artifact Registry** repository `argus` (three images).
- **Cloud Storage** bucket for evidence, uploaded documents, dossiers and merged video — mounted into `argus-api` at `/app/data`.
- **Secret Manager:** `META_API_KEY`, `MONGODB_URI`, `ARGUS_INGEST_TOKEN`.
- **VPC + Cloud NAT with a static IP:** all services send outbound traffic through the VPC (Direct VPC egress), so the internal services are reachable and every call to MongoDB Atlas and the Meta API leaves from one static IP that Atlas can allow-list.
- **MongoDB Atlas** (existing cluster) and **Cloud Logging** (automatic on Cloud Run when `GCP_PROJECT_ID` is set).

```
Browser ──HTTPS──► argus-api (public, 1 instance) ──VPC──► argus-orchestrator (internal) ──VPC──► video / image / pointcloud agents (internal)
                     │  ▲                                    │                                          │
                     │  └──── evidence download (HTTPS) ─────┴──────────────────────────────────────────┘
                     ├── /app/data ⇄ Cloud Storage bucket (FUSE mount)
                     └── Cloud NAT (static IP) ──► MongoDB Atlas ; orchestrator/agents ──► Cloud NAT ──► Meta Model API
Simulator (public) ──HTTPS + ingest token──► argus-api
```

## 2. Prerequisites and variables

- `gcloud` CLI (logged in), Docker with `buildx`, a billing-enabled GCP project, a MongoDB Atlas cluster, a Meta Model API key.
- **Build images for `linux/amd64`.** Cloud Run runs amd64; an Apple-silicon Mac builds arm64 by default.

```bash
export PROJECT=your-gcp-project
export REGION=us-central1
export REPO=$REGION-docker.pkg.dev/$PROJECT/argus
export TAG=$(git rev-parse --short HEAD)
export BUCKET=$PROJECT-argus-data
export API_SA=argus-api@$PROJECT.iam.gserviceaccount.com
export INSP_SA=argus-inspection@$PROJECT.iam.gserviceaccount.com
export SIM_SA=argus-simulator@$PROJECT.iam.gserviceaccount.com
export NET="--network=argus-vpc --subnet=argus-run --vpc-egress=all-traffic"

gcloud config set project $PROJECT
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  storage.googleapis.com logging.googleapis.com compute.googleapis.com iam.googleapis.com
```

## 3. Build and push the images

```bash
gcloud artifacts repositories create argus --repository-format=docker --location=$REGION
gcloud auth configure-docker $REGION-docker.pkg.dev

# from the argus repository root
docker buildx build --platform linux/amd64 -f Dockerfile.api        -t $REPO/argus-api:$TAG        --push .
docker buildx build --platform linux/amd64 -f Dockerfile.inspection -t $REPO/argus-inspection:$TAG --push .

# from the argus_simulation repository root
docker buildx build --platform linux/amd64 -f Dockerfile -t $REPO/argus-simulator:$TAG --push .
```

The images contain the rule library, CAD registry, CAD file, CAD reference cloud and the demo work order; the simulator image contains its prepared evidence (~200 MB).

## 4. Storage, secrets and service accounts

```bash
# Bucket for runtime data (evidence, documents, dossiers, merged video)
gcloud storage buckets create gs://$BUCKET --location=$REGION --uniform-bucket-level-access

# Secrets (values are read from your shell, never committed)
printf '%s' "$META_API_KEY"       | gcloud secrets create META_API_KEY       --data-file=-
printf '%s' "$MONGODB_URI"        | gcloud secrets create MONGODB_URI        --data-file=-
printf '%s' "$ARGUS_INGEST_TOKEN" | gcloud secrets create ARGUS_INGEST_TOKEN --data-file=-

# One service account per role
gcloud iam service-accounts create argus-api        --display-name="Argus API"
gcloud iam service-accounts create argus-inspection --display-name="Argus inspection service"
gcloud iam service-accounts create argus-simulator  --display-name="Argus simulator"

# API: read/write the bucket, write logs, read its secrets
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:$API_SA --role=roles/storage.objectAdmin
for SA in $API_SA $INSP_SA; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/logging.logWriter
done
gcloud secrets add-iam-policy-binding MONGODB_URI        --member=serviceAccount:$API_SA  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding ARGUS_INGEST_TOKEN --member=serviceAccount:$API_SA  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding META_API_KEY       --member=serviceAccount:$INSP_SA --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding ARGUS_INGEST_TOKEN --member=serviceAccount:$SIM_SA  --role=roles/secretmanager.secretAccessor
```

No key files: on Cloud Run the services authenticate to GCS and Cloud Logging as their service account (`GOOGLE_APPLICATION_CREDENTIALS` stays unset; the API's logger detects Cloud Run via `K_SERVICE`).

## 5. Network: VPC, Cloud NAT and the Atlas allow-list

```bash
gcloud compute networks create argus-vpc --subnet-mode=custom
gcloud compute networks subnets create argus-run --network=argus-vpc --region=$REGION \
  --range=10.10.0.0/24 --enable-private-ip-google-access

gcloud compute addresses create argus-nat-ip --region=$REGION
gcloud compute routers create argus-router --network=argus-vpc --region=$REGION
gcloud compute routers nats create argus-nat --router=argus-router --region=$REGION \
  --nat-all-subnet-ip-ranges --nat-external-ip-pool=argus-nat-ip

gcloud compute addresses describe argus-nat-ip --region=$REGION --format='value(address)'
```

Add that static IP to **MongoDB Atlas → Network Access**. All Argus services deploy with Direct VPC egress (`$NET`, all traffic), so:

- calls to the **internal** orchestrator and agents (ingress `internal`) are accepted, because they arrive from the VPC;
- calls to MongoDB Atlas and the Meta Model API leave through Cloud NAT from the static IP.

## 6. Deploy the services

Deploy bottom-up: agents → orchestrator → API (the API needs the orchestrator URL; the orchestrator needs the agent URLs).

### 6.1 Agents (one image, three services)

```bash
COMMON_INSP="--image=$REPO/argus-inspection:$TAG --region=$REGION --service-account=$INSP_SA $NET \
  --ingress=internal --allow-unauthenticated --execution-environment=gen2 \
  --set-secrets=META_API_KEY=META_API_KEY:latest"
INSP_ENV="MODEL_CALL_THREADS=32,AGENT_HTTP_TIMEOUT_S=300,META_ADAPTER_LIVE=1,AGENT_HOST=0.0.0.0,GCP_PROJECT_ID=$PROJECT,LOG_LEVEL=info,META_SCREEN_MODEL=muse-spark-1.3,META_REVIEW_MODEL=muse-wonder-1.0,META_SAM_MODEL=sam-3.1,GEO_MIN_FITNESS=0.9,GEO_MIN_COVERAGE=0.3"

gcloud run deploy argus-video-agent      $COMMON_INSP --set-env-vars=$INSP_ENV --port=8101 --command=python --args=agent_service.py,video,8101      --cpu=1 --memory=2Gi --timeout=900 --max-instances=3
gcloud run deploy argus-image-agent      $COMMON_INSP --set-env-vars=$INSP_ENV --port=8102 --command=python --args=agent_service.py,image,8102      --cpu=1 --memory=2Gi --timeout=900 --max-instances=3
gcloud run deploy argus-pointcloud-agent $COMMON_INSP --set-env-vars=$INSP_ENV --port=8103 --command=python --args=agent_service.py,pointcloud,8103 --cpu=4 --memory=8Gi --timeout=900 --max-instances=1

url() { gcloud run services describe $1 --region=$REGION --format='value(status.url)'; }
VIDEO_URL=$(url argus-video-agent); IMAGE_URL=$(url argus-image-agent); PC_URL=$(url argus-pointcloud-agent)
```

`--ingress=internal` keeps them off the internet; `--allow-unauthenticated` is needed because the orchestrator calls them without identity tokens (see §9 for hardening).

### 6.2 Orchestrator

```bash
gcloud run deploy argus-orchestrator $COMMON_INSP --port=8100 \
  --cpu=2 --memory=4Gi --timeout=3600 --min-instances=1 --max-instances=1 \
  --set-env-vars=$INSP_ENV,SERVICE_NAME=argus-inspection,AGENT_TRANSPORT=http,VIDEO_AGENT_URL=$VIDEO_URL,IMAGE_AGENT_URL=$IMAGE_URL,POINTCLOUD_AGENT_URL=$PC_URL,AGENT_JOBS_FILE=/tmp/agent_jobs.json,SAM_CONCURRENCY=10,VIDEO_TRACK_FPS=5
ORCH_URL=$(url argus-orchestrator)
```

`--timeout=3600`: SAM video tracking of a whole inspection video takes several minutes. One instance: it keeps per-session logs and caches in memory.

### 6.3 API (and web app)

```bash
gcloud run deploy argus-api --image=$REPO/argus-api:$TAG --region=$REGION --service-account=$API_SA $NET \
  --port=8000 --allow-unauthenticated --ingress=all \
  --min-instances=1 --max-instances=1 --no-cpu-throttling \
  --cpu=2 --memory=4Gi --timeout=3600 --execution-environment=gen2 \
  --add-volume=name=data,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount=volume=data,mount-path=/app/data \
  --set-secrets=MONGODB_URI=MONGODB_URI:latest,ARGUS_INGEST_TOKEN=ARGUS_INGEST_TOKEN:latest \
  --set-env-vars=ARGUS_DATA_DIR=/app/data,ARGUS_DB_FILE=/tmp/argus-db.json,MONGODB_DB=argus,GCP_PROJECT_ID=$PROJECT,SERVICE_NAME=argus-api,LOG_LEVEL=info,INSPECTION_SERVICE_URL=$ORCH_URL,ANALYSIS_CONCURRENCY=6,VIDEO_ANALYSIS_EVERY=4,CLOSE_DRAIN_TIMEOUT_MS=120000,MAX_ORDER_UPLOAD_MB=25

API_URL=$(url argus-api)
# The inspection services download evidence from the API: tell the API its own public URL
gcloud run services update argus-api --region=$REGION --update-env-vars=EVIDENCE_BASE_URL=$API_URL
```

Why these flags:

- **Exactly one instance, CPU always on.** The API keeps the live analysis queue, SSE connections and its working state in memory, and runs analysis after the HTTP response returns. More than one instance would split sessions between processes. (MongoDB is the source of truth on restart; accepted-but-unanalysed evidence is re-queued at startup.)
- **`--timeout=3600`.** SSE streams last up to the Cloud Run maximum of 60 minutes; the browser reconnects automatically and resumes with `Last-Event-ID`.
- **Bucket mounted at `/app/data`.** Evidence, documents, dossiers and merged videos survive restarts. The working DB file (`ARGUS_DB_FILE`) stays on local disk because it is rewritten on every event; MongoDB is loaded at startup.
- **Database:** the cloud uses the Atlas database `argus` (`MONGODB_DB=argus`); local runs default to `argus-local`. Never point two running APIs at the same database — each one rewrites whole collections when it saves. If Atlas is unreachable at startup (e.g. the NAT IP is not yet allow-listed), the API serves from its local store and retries every 30 s; on the first successful connection it merges both sides. `/api/v1/health` reports `mongo: true` only when actually connected.
- **Do not also set `GCS_BUCKET`.** With the mount, files already land in the bucket. `GCS_BUCKET` makes the API upload each file a second time to the same object key, and a reader that arrives during the second write can receive a truncated file (found in the first deployment: the uploaded work order could not be parsed). The health check then reports `gcs:false` — expected, the bucket is used through the mount.

### 6.4 Simulator

```bash
gcloud run deploy argus-simulator --image=$REPO/argus-simulator:$TAG --region=$REGION --service-account=$SIM_SA \
  --port=4173 --allow-unauthenticated --cpu=2 --memory=2Gi --timeout=900 --max-instances=1 \
  --set-secrets=ARGUS_INGEST_TOKEN=ARGUS_INGEST_TOKEN:latest \
  --set-env-vars=SIM_PORT=4173,ARGUS_BASE_URL=$API_URL,MAX_CONCURRENT_UPLOADS=3
```

In the simulator UI, set **Argus API URL** to `$API_URL` (the field defaults to `http://localhost:8000`). The first replay of each scenario cuts the video and point cloud into chunks with ffmpeg inside the container (a few seconds; cached until the instance restarts).

## 7. Verify

```bash
curl -s $API_URL/api/v1/health                 # {"ok":true,"storage":{"gcs":true,"mongo":true,...}}
curl -s $(url argus-simulator)/api/health
gcloud run services logs read argus-orchestrator --region=$REGION --limit=20   # internal services: check via logs
```

End-to-end: open `$API_URL`, start an inspection with the demo work order, paste its ID into the simulator, send, watch findings arrive, end the inspection, open the dossier. Then check:

- **Cloud Logging:** entries from `argus-api`, `argus-inspection` and each agent, labelled with the session ID.
- **Bucket:** `evidence/<sessionId>/…`, `documents/<sessionId>/…`, `dossiers/<sessionId>.html`.
- **Atlas:** `inspections`, `referenceSnapshots`, `evidence`, `findings`, `observations`, `events`, `dossiers`.

## 8. Updating, rollback and teardown

```bash
# Update: build and push a new $TAG (§3), then for each service
gcloud run services update argus-api --region=$REGION --image=$REPO/argus-api:$TAG

# Rollback to a previous revision
gcloud run revisions list --service=argus-api --region=$REGION
gcloud run services update-traffic argus-api --region=$REGION --to-revisions=REVISION_NAME=100

# Pause costs after the demo (API and orchestrator are always-on while min-instances=1)
gcloud run services update argus-api          --region=$REGION --min-instances=0
gcloud run services update argus-orchestrator --region=$REGION --min-instances=0

# Teardown
for S in argus-api argus-orchestrator argus-video-agent argus-image-agent argus-pointcloud-agent argus-simulator; do
  gcloud run services delete $S --region=$REGION --quiet; done
gcloud compute routers nats delete argus-nat --router=argus-router --region=$REGION --quiet
gcloud compute routers delete argus-router --region=$REGION --quiet
gcloud compute addresses delete argus-nat-ip --region=$REGION --quiet
gcloud compute networks subnets delete argus-run --region=$REGION --quiet
gcloud compute networks delete argus-vpc --quiet
# Bucket and secrets hold data: delete deliberately
# gcloud storage rm -r gs://$BUCKET ; gcloud secrets delete META_API_KEY MONGODB_URI ARGUS_INGEST_TOKEN
```

## 9. Security notes and hardening

The hackathon build has **no login** (by design, Spec §10.4). In this deployment:

- Evidence-ingestion endpoints require `ARGUS_INGEST_TOKEN` (bearer token, server-to-server; the simulator holds it in Secret Manager).
- **Read endpoints and the web app are public** to anyone who has the URL, including evidence downloads. Acceptable for a private demo URL; not for real customer data.

Before real data:

1. Put `argus-api` behind an external HTTPS load balancer with **Identity-Aware Proxy** (ingress `internal-and-cloud-load-balancing`) so only signed-in users reach the web app and read APIs. Producers (simulator or real cameras) then need either an IAP-allowed service identity or a separate, token-protected ingestion route.
2. Replace `--allow-unauthenticated` on the internal services with Cloud Run IAM (`roles/run.invoker` for the calling service accounts). This needs a small code change: the API and orchestrator must attach Google-signed ID tokens to their calls.
3. Use signed GCS URLs for evidence downloads instead of streaming through the API.
4. Confirm the Meta Model API data-handling terms for engineering evidence (non-contributor / private inference where available).

## 10. Constraints to keep in mind

- **Single-instance API and orchestrator.** Their state is in memory (queue, SSE listeners, caches). Horizontal scaling would need the queue moved to Cloud Tasks / Pub/Sub and SSE fan-out through Redis or Pub/Sub — documented as future work in the tech stack.
- **Request time limit 60 minutes.** Covers SSE (reconnects resume), SAM video tracking and merged-scan registration.
- **Cloud Storage FUSE is not a local disk.** Writes are object uploads and renames are not atomic. Fine for write-once evidence and dossiers; the frequently rewritten DB file is kept off the mount for that reason.
- **Egress.** Every Meta call and every Atlas call leaves through Cloud NAT. If Atlas rejects connections, check the static IP is on its access list.
- **Images are large.** `argus-inspection` includes Open3D and ffmpeg (~2.1 GB; `argus-api` ~1.1 GB); cold starts take tens of seconds, hence min-instances for the orchestrator.
- **Model latency.** A cold SAM 3.1 concept call took ~80 s in testing; later calls 3–9 s. Leave `--timeout` generous on the agents and orchestrator.
