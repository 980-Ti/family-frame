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

## 미디어 업로드 구조

각 Media는 자신만의 MediaAsset과 비공개 RGW 객체 세트를 가집니다. 브라우저가 presigned URL로 임시 객체를 올리면 백엔드가 파일을 검증하고 이미지 또는 영상을 처리한 뒤 `assets/{familyId}/{mediaId}` 아래에 original, display, thumbnail을 저장합니다. 파일 내용이 같아도 다른 Media의 Asset이나 객체를 조회하거나 공유하지 않습니다.

`MAX_ACTIVE_UPLOADS_PER_USER`는 한 사용자가 동시에 유지할 수 있는 `PENDING_UPLOAD`와 `PROCESSING` Media 수를 제한하며 기본값은 5입니다. 프론트엔드도 선택한 파일을 최대 5개씩 병렬 전송하고, 완료되거나 실패한 자리에 다음 파일을 투입합니다.

`20260806020000_remove_media_deduplication` migration은 `Media.mediaAssetId`를 1:1 관계로 변경합니다. 기존 DB에 하나의 MediaAsset을 참조하는 Media가 둘 이상 있으면 migration은 데이터를 임의 삭제하거나 분리하지 않고 중단됩니다. 배포 전에 다음 쿼리 결과가 비어 있는지 확인하고, 결과가 있으면 보존할 객체와 Media를 운영 정책에 따라 수동 전환해야 합니다.

```sql
SELECT "mediaAssetId", COUNT(*)
FROM "Media"
WHERE "mediaAssetId" IS NOT NULL
GROUP BY "mediaAssetId"
HAVING COUNT(*) > 1;
```

결과가 있으면 첫 Media가 기존 Asset을 유지하도록 정한 뒤, 나머지 Media마다 RGW 객체를 Media 전용 prefix로 복사하고 새 MediaAsset을 생성해 `mediaAssetId`를 교체합니다. 모든 공유 참조가 해소되고 위 쿼리 결과가 비어 있을 때만 migration을 적용합니다. migration은 공유 참조가 남아 있으면 스키마를 변경하기 전에 중단됩니다.

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
