"""Supabase Storage signing endpoints.

The memory editor (Phase C7) sometimes wants to attach binary content
(images, PDFs, recordings) to an agent's workspace. Embedding base64 in
markdown bloats the gateway's openclaw.json and slows hot-reloads, so we
route attachments through a dedicated Supabase Storage bucket and reference
them by signed URL inside the agent's markdown files.

Two endpoints:
  - `POST /api/v1/storage/agent-attachments/sign-upload` — returns a
    signed URL the browser uploads to directly.
  - `GET  /api/v1/storage/agent-attachments/sign-download/{path}` — returns
    a short-lived signed URL the browser fetches from.

The bucket name is hard-coded as `agent-attachments`. It's created
on-demand on first sign-upload using the service-role key. The bucket is
private; nothing is publicly downloadable without a signed URL.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import require_org_admin
from app.core.auth import AuthContext, get_auth_context
from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import get_session
from sqlmodel import Field, SQLModel

if TYPE_CHECKING:
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app.services.organizations import OrganizationContext


logger = get_logger(__name__)
router = APIRouter(prefix="/storage", tags=["storage"])
SESSION_DEP = Depends(get_session)
AUTH_DEP = Depends(get_auth_context)
ORG_ADMIN_DEP = Depends(require_org_admin)

BUCKET_NAME = "agent-attachments"
# Signed upload URLs expire fast (the upload is one-shot); downloads can
# live longer because they're used inline in markdown views.
UPLOAD_EXPIRES_SECONDS = 5 * 60
DOWNLOAD_EXPIRES_SECONDS = 60 * 60


class SignUploadRequest(SQLModel):
    """Browser-side request to upload one attachment."""

    filename: str = Field(description="Original filename; used to derive extension.")
    agent_id: UUID = Field(description="mc-v2 Agent UUID — scopes the storage path.")
    content_type: str | None = Field(
        default=None,
        description="MIME type the browser will PUT with. Optional.",
    )


class SignUploadResponse(SQLModel):
    upload_url: str = Field(description="One-shot signed URL to PUT the file at.")
    storage_path: str = Field(
        description="`agent/<uuid>/<rand>-<filename>` — record this in your markdown.",
    )
    token: str = Field(description="Signed upload token; the URL embeds it but we also expose it.")
    expires_in: int = UPLOAD_EXPIRES_SECONDS


class SignDownloadResponse(SQLModel):
    download_url: str
    expires_in: int = DOWNLOAD_EXPIRES_SECONDS


def _storage_base_url() -> str:
    base = settings.supabase_url.strip().rstrip("/")
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage not configured (SUPABASE_URL is empty).",
        )
    return f"{base}/storage/v1"


def _service_role_headers() -> dict[str, str]:
    key = settings.supabase_service_role_key.strip()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage not configured (SUPABASE_SERVICE_ROLE_KEY is empty).",
        )
    return {"apikey": key, "Authorization": f"Bearer {key}"}


async def _ensure_bucket(client: httpx.AsyncClient, headers: dict[str, str]) -> None:
    """Create the bucket on first use. Idempotent.

    Returns silently if the bucket already exists; raises 502 on other
    errors. We don't run this on app startup because it'd add a network
    call to every cold boot; lazy on-first-use is cheaper.
    """
    # GET /bucket/<name> returns 404 if missing, 200 if present.
    probe = await client.get(
        f"{_storage_base_url()}/bucket/{BUCKET_NAME}", headers=headers,
    )
    if probe.status_code == 200:
        return
    if probe.status_code != 404:
        logger.warning("storage.bucket_probe.unexpected status=%s", probe.status_code)
    create = await client.post(
        f"{_storage_base_url()}/bucket",
        headers=headers,
        json={"name": BUCKET_NAME, "public": False},
    )
    if create.status_code >= 400 and create.status_code != 409:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to create Storage bucket: {create.text}",
        )


def _safe_filename(original: str) -> str:
    """Strip path traversal + force a short ascii-safe filename."""
    base = os.path.basename(original.replace("\\", "/"))
    # Keep only alphanumerics, dot, hyphen, underscore.
    cleaned = "".join(c if (c.isalnum() or c in ".-_") else "-" for c in base)
    if not cleaned:
        cleaned = "attachment"
    # Cap length so paths don't blow Postgres limits even with prefix.
    return cleaned[:80]


@router.post("/agent-attachments/sign-upload", response_model=SignUploadResponse)
async def sign_upload(
    body: SignUploadRequest,
    auth: AuthContext = AUTH_DEP,  # noqa: ARG001 — admin gate enforces auth
    ctx: OrganizationContext = ORG_ADMIN_DEP,  # noqa: ARG001 — guards endpoint
) -> SignUploadResponse:
    """Mint a one-shot upload URL inside the agent-attachments bucket.

    The storage path is `agent/<agent_uuid>/<random>-<safe_filename>`. The
    random prefix keeps multiple uploads of the same filename from
    colliding; the agent_uuid prefix scopes deletes if we ever delete an
    Agent row's attachments.
    """
    safe = _safe_filename(body.filename)
    # uuid4().hex slice is enough entropy for collision-free names.
    from uuid import uuid4
    storage_path = f"agent/{body.agent_id}/{uuid4().hex[:12]}-{safe}"

    headers = _service_role_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        await _ensure_bucket(client, headers)
        signing_resp = await client.post(
            f"{_storage_base_url()}/object/upload/sign/{BUCKET_NAME}/{storage_path}",
            headers=headers,
            json={"expiresIn": UPLOAD_EXPIRES_SECONDS},
        )
        if signing_resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to mint upload URL: {signing_resp.text}",
            )
        data = signing_resp.json()
        # Supabase Storage returns `{ url, token }` where url is a relative
        # path. Absolutize so the browser doesn't need to know the base.
        relative = data.get("url") or ""
        token = data.get("token") or ""
        absolute = (
            relative if relative.startswith("http")
            else f"{_storage_base_url()}{relative}"
        )
    return SignUploadResponse(
        upload_url=absolute,
        storage_path=storage_path,
        token=token,
    )


@router.get(
    "/agent-attachments/sign-download/{storage_path:path}",
    response_model=SignDownloadResponse,
)
async def sign_download(
    storage_path: str,
    auth: AuthContext = AUTH_DEP,  # noqa: ARG001
    ctx: OrganizationContext = ORG_ADMIN_DEP,  # noqa: ARG001
) -> SignDownloadResponse:
    """Mint a short-lived signed GET URL for a stored attachment."""
    headers = _service_role_headers()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{_storage_base_url()}/object/sign/{BUCKET_NAME}/{storage_path}",
            headers=headers,
            json={"expiresIn": DOWNLOAD_EXPIRES_SECONDS},
        )
        if resp.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Attachment not found in Storage.",
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to mint download URL: {resp.text}",
            )
        data = resp.json()
        relative = data.get("signedURL") or data.get("url") or ""
        absolute = (
            relative if relative.startswith("http")
            else f"{_storage_base_url()}{relative}"
        )
    return SignDownloadResponse(download_url=absolute)
