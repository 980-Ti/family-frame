# Family Frame

가족 구성원만 접근할 수 있는 아이 사진·영상 달력 앨범입니다. 브라우저는 Next.js를 통해 NestJS API를 사용하고, 메타데이터는 PostgreSQL에, 원본 미디어와 파생 이미지는 S3 호환 비공개 저장소에 보관합니다.

## 로컬 실행

요구 사항은 Node.js 24+, Docker Desktop, FFmpeg(`ffmpeg`와 `ffprobe`가 PATH에 등록된 상태)입니다. 전역 `pnpm` 설치는 필요하지 않습니다.

```powershell
Copy-Item .env.example .env
npx --yes pnpm@10.15.0 install
npx --yes pnpm@10.15.0 db:generate
npx --yes pnpm@10.15.0 dev:all
```

- 웹: http://localhost:3000
- API 문서: http://localhost:4000/api/docs
- MinIO 콘솔: http://localhost:9001

`dev:all`은 PostgreSQL·MinIO 준비, bucket 생성, DB migration, 백엔드 readiness 확인, 프론트엔드 시작 순서로 실행합니다. 애플리케이션만 다시 시작할 때는 `pnpm dev`를 사용합니다. 포트를 바꾸려면 `BACKEND_PORT`와 `FRONTEND_PORT`를 서로 다른 값으로 지정합니다.

`.env`는 커밋하지 않습니다. 운영에서는 `DATABASE_URL`, `APP_ORIGIN`, `API_ORIGIN`, `S3_*` 주소와 자격증명을 모두 실제 환경에 맞게 설정합니다.

## Media deduplication experiment mode

`MEDIA_DEDUPLICATION_ENABLED`는 실험용 환경변수로 기본값은 `true`입니다. `false`는 운영 기능이 아니라 실험용 baseline이며, 동일한 파일이라도 각 Media마다 별도의 MediaAsset와 RGW 객체 경로를 생성합니다. 해시 계산, 이미지 변환, 영상 처리, DB 상태 전이, 업로드 API 흐름은 그대로 유지됩니다.

- 활성화(`true`): 같은 가족의 동일 파일은 기존 MediaAsset을 재사용하고 RGW 업로드를 생략합니다.
- 비활성화(`false`): 같은 가족의 동일 파일도 별도의 MediaAsset과 RGW 객체를 생성합니다.
- 실험 A/B 사이에는 DB와 RGW 데이터를 초기화하거나 별도 DB/Bucket를 사용해야 공정한 비교가 가능합니다.
- 동일 데이터셋, 동일 순서, 동일 동시성 조건으로 반복 실험하는 것을 권장합니다.

```powershell
$env:MEDIA_DEDUPLICATION_ENABLED = "true"
# 또는
$env:MEDIA_DEDUPLICATION_ENABLED = "false"
```

Helm override 예시는 다음과 같습니다.

```powershell
helm upgrade --install family-frame ... --set config.mediaDeduplicationEnabled=true
helm upgrade --install family-frame ... --set config.mediaDeduplicationEnabled=false
```

로컬 MinIO 초기화는 `temp/` 객체를 1일 뒤 만료하는 lifecycle을 매번 같은 설정으로 적용합니다. 운영 Ceph RGW의 `family-frame` bucket에도 `temp/` prefix를 1일 뒤 만료하는 동등한 S3 lifecycle을 반드시 설정해야 합니다. 애플리케이션의 best-effort 삭제와 별개로, 프로세스 종료 중 남은 임시 객체를 정리하는 안전망입니다.

## 검증

```powershell
npx --yes pnpm@10.15.0 typecheck
npx --yes pnpm@10.15.0 lint
npx --yes pnpm@10.15.0 test
npx --yes pnpm@10.15.0 build
```

## 컨테이너 이미지

저장소 루트를 빌드 컨텍스트로 사용합니다.

```powershell
docker build -f frontend/Dockerfile -t family-frame-frontend:local .
docker build -f backend/Dockerfile -t family-frame-backend:local .
```

이미지는 모두 일반 사용자로 실행됩니다. Next.js는 standalone 산출물만 포함하고, NestJS 이미지는 별도 마이그레이션 Job에서 `prisma migrate deploy`를 실행할 수 있도록 구성되어 있습니다.

## Kubernetes

`deploy/k8s`는 애플리케이션 Pod만 배포합니다. PostgreSQL과 Ceph RGW는 클러스터의 기존 서비스를 사용합니다.

1. `configmap.yaml`과 `app.yaml`의 공개 주소, RGW endpoint, bucket을 환경에 맞게 수정합니다.
2. `family-frame-tls` TLS Secret을 준비하거나 cert-manager가 같은 이름으로 생성하도록 설정합니다.
3. 예시 Secret을 복사하고 실제 값으로 바꾸되, 완성된 Secret 파일은 커밋하지 않습니다.
4. 이미지에는 같은 Git SHA 태그를 사용하고 `RELEASE_SHA`를 배포 시점에 치환합니다. `latest`를 사용하거나 이미 push한 SHA 태그를 덮어쓰지 않습니다.
5. 단일 가족 제약 migration 전에 사전 점검 SQL을 실행합니다. 중복이 나오면 migration을 중단하고 보존할 가족을 확인해 수동으로 정리합니다. 이 절차는 데이터를 자동 삭제하지 않습니다.
6. 매 배포마다 고유 이름의 migration Job을 생성해 성공을 기다린 뒤 애플리케이션을 배포합니다.

```powershell
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
Copy-Item deploy/k8s/secret.example.yaml deploy/k8s/secret.local.yaml
# secret.local.yaml의 값을 수정
kubectl apply -f deploy/k8s/secret.local.yaml

# 운영 DB에 안전한 경로로 접속한 셸에서 실행합니다. 중복이 있으면 오류로 중단됩니다.
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/k8s/preflight-single-family.sql
if ($LASTEXITCODE -ne 0) { throw "단일 가족 migration 사전 점검에 실패했습니다." }

$releaseSha = git rev-parse --short=12 HEAD
$registryOwner = "replace-with-your-ghcr-owner"
$migrationManifest = (Get-Content deploy/k8s/migration-job.yaml -Raw).Replace("replace-me", $registryOwner).Replace("RELEASE_SHA", $releaseSha)
$migrationJob = $migrationManifest | kubectl create -f - -o name
kubectl wait --for=condition=complete $migrationJob -n family-frame --timeout=120s
if ($LASTEXITCODE -ne 0) {
  kubectl logs -n family-frame $migrationJob
  throw "DB migration에 실패했습니다. 애플리케이션을 배포하지 않습니다."
}

$appManifest = (Get-Content deploy/k8s/app.yaml -Raw).Replace("replace-me", $registryOwner).Replace("RELEASE_SHA", $releaseSha)
$appManifest | kubectl apply -f -
```

배포 상태는 다음 명령으로 확인합니다.

```powershell
kubectl get pods,svc,ingress -n family-frame
kubectl get jobs -n family-frame
```
