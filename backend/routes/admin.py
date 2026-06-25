"""
AI 法律助手 — 管理后台 API 路由
Dashboard 聚合、全量记录浏览
"""
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from db import get_pool, get_user_by_auth_token

router = APIRouter(prefix="/api/admin", tags=["admin"])


async def require_admin_user(request: Request) -> dict:
    user = await get_user_by_auth_token(request.cookies.get("user_token"))
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def _parse_date_range(start: str | None, end: str | None) -> tuple[float | None, float | None]:
    start_ts = None
    end_ts = None
    if start:
        try:
            start_ts = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
    if end:
        try:
            end_ts = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() + 86399.999
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
    return start_ts, end_ts


@router.get("/dashboard")
async def admin_dashboard(request: Request):
    """聚合仪表盘数据：总览卡片 + 近 30 天趋势"""
    await require_admin_user(request)
    pool = await get_pool()
    now = time.time()
    today_start = int(now) - int(now) % 86400
    seven_days_ago = today_start - 7 * 86400
    thirty_days_ago = today_start - 30 * 86400

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # 用户统计
            await cur.execute("SELECT COUNT(*) FROM users")
            total_users = (await cur.fetchone())[0]

            await cur.execute("SELECT COUNT(*) FROM users WHERE is_active = 1")
            active_users = (await cur.fetchone())[0]

            await cur.execute("SELECT COUNT(*) FROM users WHERE created_at >= %s", (seven_days_ago,))
            new_users_7d = (await cur.fetchone())[0]

            # 会话统计
            await cur.execute("SELECT COUNT(*) FROM sessions")
            total_sessions = (await cur.fetchone())[0]

            await cur.execute("SELECT COUNT(*) FROM sessions WHERE last_active >= %s", (today_start,))
            active_sessions_today = (await cur.fetchone())[0]

            # 消息统计
            await cur.execute("SELECT COUNT(*) FROM messages WHERE created_at >= %s", (today_start,))
            messages_today = (await cur.fetchone())[0]

            # 合同审查统计
            await cur.execute("SELECT COUNT(*) FROM contract_reviews")
            total_reviews = (await cur.fetchone())[0]

            await cur.execute("SELECT COUNT(*) FROM contract_reviews WHERE created_at >= %s", (seven_days_ago,))
            reviews_7d = (await cur.fetchone())[0]

            # 法规检索统计
            await cur.execute("SELECT COUNT(*) FROM research_records")
            total_research = (await cur.fetchone())[0]

            await cur.execute("SELECT COUNT(*) FROM research_records WHERE created_at >= %s", (seven_days_ago,))
            research_7d = (await cur.fetchone())[0]

            # 翻译统计
            await cur.execute("SELECT COUNT(*) FROM translation_records")
            total_translations = (await cur.fetchone())[0]

            # usage_logs 统计
            await cur.execute(
                "SELECT COUNT(*), COALESCE(SUM(estimated_cost), 0) FROM usage_logs WHERE created_at >= %s",
                (today_start,),
            )
            row = await cur.fetchone()
            api_calls_today = row[0]
            cost_today = float(row[1] or 0)

            await cur.execute(
                "SELECT COUNT(*), COALESCE(SUM(estimated_cost), 0) FROM usage_logs WHERE created_at >= %s",
                (thirty_days_ago,),
            )
            row = await cur.fetchone()
            api_calls_30d = row[0]
            cost_30d = float(row[1] or 0)

            # 近 30 天 daily 趋势（API 调用量 + 消息数）
            await cur.execute(
                """
                SELECT
                    DATE(FROM_UNIXTIME(created_at)) AS d,
                    COUNT(*) AS api_calls,
                    COALESCE(SUM(estimated_cost), 0) AS cost
                FROM usage_logs
                WHERE created_at >= %s
                GROUP BY d
                ORDER BY d ASC
                """,
                (thirty_days_ago,),
            )
            usage_trend_rows = await cur.fetchall()

            await cur.execute(
                """
                SELECT
                    DATE(FROM_UNIXTIME(created_at)) AS d,
                    COUNT(*) AS msg_count
                FROM messages
                WHERE created_at >= %s
                GROUP BY d
                ORDER BY d ASC
                """,
                (thirty_days_ago,),
            )
            msg_trend_rows = await cur.fetchall()

    # 合并趋势
    trend_map: dict[str, dict] = {}
    for row in usage_trend_rows:
        d = row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0])
        trend_map.setdefault(d, {"date": d, "api_calls": 0, "cost": 0.0, "messages": 0})
        trend_map[d]["api_calls"] = int(row[1])
        trend_map[d]["cost"] = float(row[2] or 0)
    for row in msg_trend_rows:
        d = row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0])
        trend_map.setdefault(d, {"date": d, "api_calls": 0, "cost": 0.0, "messages": 0})
        trend_map[d]["messages"] = int(row[1])

    daily_trend = sorted(trend_map.values(), key=lambda x: x["date"])

    return {
        "stats": {
            "total_users": total_users,
            "active_users": active_users,
            "new_users_7d": new_users_7d,
            "total_sessions": total_sessions,
            "active_sessions_today": active_sessions_today,
            "messages_today": messages_today,
            "total_reviews": total_reviews,
            "reviews_7d": reviews_7d,
            "total_research": total_research,
            "research_7d": research_7d,
            "total_translations": total_translations,
            "api_calls_today": api_calls_today,
            "cost_today": round(cost_today, 4),
            "api_calls_30d": api_calls_30d,
            "cost_30d": round(cost_30d, 4),
        },
        "daily_trend": daily_trend,
    }


@router.get("/records/contracts")
async def admin_contract_records(
    request: Request,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    start: str | None = None,
    end: str | None = None,
    username: str | None = None,
):
    """管理员查看所有用户的合同审查记录"""
    await require_admin_user(request)
    start_ts, end_ts = _parse_date_range(start, end)
    pool = await get_pool()

    where = []
    params = []
    if start_ts:
        where.append("cr.created_at >= %s")
        params.append(start_ts)
    if end_ts:
        where.append("cr.created_at <= %s")
        params.append(end_ts)
    if username:
        where.append("u.username LIKE %s")
        params.append(f"%{username}%")
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    offset = (page - 1) * page_size
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT COUNT(*)
                FROM contract_reviews cr
                LEFT JOIN users u ON u.id = cr.user_id
                {where_sql}
                """,
                params,
            )
            total = (await cur.fetchone())[0]

            await cur.execute(
                f"""
                SELECT cr.id, cr.user_id, u.username, cr.filename, cr.file_mime,
                       cr.note, cr.parsed_source, cr.review_json, cr.created_at, cr.updated_at
                FROM contract_reviews cr
                LEFT JOIN users u ON u.id = cr.user_id
                {where_sql}
                ORDER BY cr.created_at DESC
                LIMIT %s OFFSET %s
                """,
                [*params, page_size, offset],
            )
            rows = await cur.fetchall()

    records = []
    for row in rows:
        review = {}
        try:
            review = json.loads(row[7] or "{}")
        except Exception:
            pass
        issues = review.get("issues") if isinstance(review, dict) else []
        records.append({
            "id": row[0],
            "user_id": row[1],
            "username": row[2] or "(已删除)",
            "filename": row[3],
            "file_mime": row[4] or "",
            "note": row[5] or "",
            "parsed_source": row[6] or "",
            "overall_risk": review.get("overall_risk", "medium") if isinstance(review, dict) else "medium",
            "issue_count": len(issues) if isinstance(issues, list) else 0,
            "created_at": row[8],
            "updated_at": row[9],
        })

    return {"records": records, "total": total, "page": page, "page_size": page_size}


@router.get("/records/research")
async def admin_research_records(
    request: Request,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    start: str | None = None,
    end: str | None = None,
    username: str | None = None,
):
    """管理员查看所有用户的法规检索记录"""
    await require_admin_user(request)
    start_ts, end_ts = _parse_date_range(start, end)
    pool = await get_pool()

    where = []
    params = []
    if start_ts:
        where.append("rr.created_at >= %s")
        params.append(start_ts)
    if end_ts:
        where.append("rr.created_at <= %s")
        params.append(end_ts)
    if username:
        where.append("u.username LIKE %s")
        params.append(f"%{username}%")
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    offset = (page - 1) * page_size
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT COUNT(*)
                FROM research_records rr
                LEFT JOIN users u ON u.id = rr.user_id
                {where_sql}
                """,
                params,
            )
            total = (await cur.fetchone())[0]

            await cur.execute(
                f"""
                SELECT rr.id, rr.user_id, u.username, rr.query_text,
                       rr.references_json, rr.meta_json, rr.created_at, rr.updated_at
                FROM research_records rr
                LEFT JOIN users u ON u.id = rr.user_id
                {where_sql}
                ORDER BY rr.created_at DESC
                LIMIT %s OFFSET %s
                """,
                [*params, page_size, offset],
            )
            rows = await cur.fetchall()

    records = []
    for row in rows:
        refs = []
        try:
            refs = json.loads(row[4] or "[]")
        except Exception:
            pass
        records.append({
            "id": row[0],
            "user_id": row[1],
            "username": row[2] or "(已删除)",
            "query": (row[3] or "")[:100],
            "law_count": len([r for r in refs if isinstance(r, dict) and r.get("type") == "law"]) if isinstance(refs, list) else 0,
            "case_count": len([r for r in refs if isinstance(r, dict) and r.get("type") == "case"]) if isinstance(refs, list) else 0,
            "created_at": row[5],
            "updated_at": row[6],
        })

    return {"records": records, "total": total, "page": page, "page_size": page_size}


@router.get("/records/translations")
async def admin_translation_records(
    request: Request,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    start: str | None = None,
    end: str | None = None,
    username: str | None = None,
):
    """管理员查看所有用户的翻译记录"""
    await require_admin_user(request)
    start_ts, end_ts = _parse_date_range(start, end)
    pool = await get_pool()

    where = []
    params = []
    if start_ts:
        where.append("tr.created_at >= %s")
        params.append(start_ts)
    if end_ts:
        where.append("tr.created_at <= %s")
        params.append(end_ts)
    if username:
        where.append("u.username LIKE %s")
        params.append(f"%{username}%")
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    offset = (page - 1) * page_size
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT COUNT(*)
                FROM translation_records tr
                LEFT JOIN users u ON u.id = tr.user_id
                {where_sql}
                """,
                params,
            )
            total = (await cur.fetchone())[0]

            await cur.execute(
                f"""
                SELECT tr.id, tr.user_id, u.username, tr.filename,
                       tr.source_lang, tr.target_lang, tr.total_blocks,
                       tr.translated_blocks, tr.created_at, tr.updated_at
                FROM translation_records tr
                LEFT JOIN users u ON u.id = tr.user_id
                {where_sql}
                ORDER BY tr.created_at DESC
                LIMIT %s OFFSET %s
                """,
                [*params, page_size, offset],
            )
            rows = await cur.fetchall()

    records = []
    for row in rows:
        records.append({
            "id": row[0],
            "user_id": row[1],
            "username": row[2] or "(已删除)",
            "filename": row[3],
            "source_lang": row[4],
            "target_lang": row[5],
            "total_blocks": row[6],
            "translated_blocks": row[7],
            "progress": f"{row[7]}/{row[6]}" if row[6] else "0/0",
            "created_at": row[8],
            "updated_at": row[9],
        })

    return {"records": records, "total": total, "page": page, "page_size": page_size}
