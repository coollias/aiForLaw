"""Admin usage statistics routes."""
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request

from db import get_user_by_auth_token
from usage import get_usage_summary, list_usage_logs


router = APIRouter(prefix="/api/admin/usage", tags=["usage"])


async def require_admin_user(request: Request) -> dict:
    user = await get_user_by_auth_token(request.cookies.get("user_token"))
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def _parse_date(value: str | None, *, end: bool = False) -> float | None:
    if not value:
        return None
    try:
        dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
    ts = dt.timestamp()
    return ts + 86399.999 if end else ts


def _default_start(days: int | None) -> float | None:
    if not days:
        return None
    days = max(1, min(int(days), 365))
    return time.time() - days * 86400


@router.get("/summary")
async def usage_summary(
    request: Request,
    days: int | None = Query(default=30, ge=1, le=365),
    start: str | None = None,
    end: str | None = None,
):
    await require_admin_user(request)
    start_ts = _parse_date(start) if start else _default_start(days)
    end_ts = _parse_date(end, end=True)
    return await get_usage_summary(start_ts=start_ts, end_ts=end_ts)


@router.get("/logs")
async def usage_logs(
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
    days: int | None = Query(default=30, ge=1, le=365),
    start: str | None = None,
    end: str | None = None,
):
    await require_admin_user(request)
    start_ts = _parse_date(start) if start else _default_start(days)
    end_ts = _parse_date(end, end=True)
    return {"logs": await list_usage_logs(limit=limit, start_ts=start_ts, end_ts=end_ts)}
