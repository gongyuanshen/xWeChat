"""Explicit controls for the independent snapshot refresh service."""
import asyncio
import json

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..logging_config import get_logger
from ..snapshot_refresh import SNAPSHOT_REFRESH, SnapshotRefreshError
from ..snapshot_events import snapshot_event_version, wait_snapshot_change
from ..snapshot_registry import snapshot_read_scope

router = APIRouter(prefix="/api/decrypt/snapshot-refresh", tags=["snapshot-refresh"])
logger = get_logger(__name__)


class SnapshotAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account: str = Field(..., min_length=1)


class SnapshotStartRequest(SnapshotAccountRequest):
    interval_seconds: float = Field(30, ge=1, allow_inf_nan=False, strict=True)
    resume: bool = Field(False, strict=True)


class SnapshotStopRequest(SnapshotAccountRequest):
    user_paused: bool = Field(False, strict=True)


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except SnapshotRefreshError as exc:
        raise HTTPException(status_code=exc.status_code, detail={
            "code": "snapshot_refresh_failed", "stage": exc.stage, "message": str(exc),
        }) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[snapshot-refresh] control/state request failed")
        raise HTTPException(status_code=500, detail={
            "code": "snapshot_refresh_failed", "stage": "state_read", "message": str(exc),
        }) from exc


@router.get("/status")
def snapshot_refresh_status(account: str = Query(..., min_length=1)):
    return _call(SNAPSHOT_REFRESH.status, account)


@router.get("/events")
async def snapshot_refresh_events(request: Request, account: str = Query(..., min_length=1)):
    with snapshot_read_scope(independent=True):
        _call(SNAPSHOT_REFRESH.status, account)
    version = snapshot_event_version(account)

    async def events():
        current = version
        while not await request.is_disconnected():
            yield "event: snapshot_changed\ndata: " + json.dumps({"account": account, "sequence": current}) + "\n\n"
            while not await request.is_disconnected():
                observed = await asyncio.to_thread(wait_snapshot_change, account, current)
                if observed != current:
                    current = observed
                    break
                yield ": keep-alive\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/start", status_code=202)
def start_snapshot_refresh(request: SnapshotStartRequest):
    return _call(SNAPSHOT_REFRESH.start, request.account, interval_seconds=request.interval_seconds,
                 resume=request.resume)


@router.post("/stop")
def stop_snapshot_refresh(request: SnapshotStopRequest):
    return _call(SNAPSHOT_REFRESH.stop, request.account, user_paused=request.user_paused)


@router.post("/once", status_code=202)
def refresh_snapshot_once(request: SnapshotAccountRequest):
    return _call(SNAPSHOT_REFRESH.once, request.account)
