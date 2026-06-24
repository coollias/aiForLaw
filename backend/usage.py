"""Usage accounting helpers for model calls."""
import os
import time
from collections import defaultdict
from typing import Any

import aiomysql

from db import get_pool


CREATE_USAGE_LOGS_TABLE = """
CREATE TABLE IF NOT EXISTS usage_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    username VARCHAR(64) NOT NULL,
    feature VARCHAR(64) NOT NULL,
    model VARCHAR(128) NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    estimated_cost DECIMAL(12, 6) NOT NULL DEFAULT 0,
    success TINYINT(1) NOT NULL DEFAULT 1,
    error_message TEXT,
    meta_json LONGTEXT,
    created_at DOUBLE NOT NULL,
    INDEX idx_created_at (created_at),
    INDEX idx_user_created (user_id, created_at),
    INDEX idx_feature_created (feature, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""


def _get_attr(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def extract_usage(usage_obj: Any) -> dict[str, int] | None:
    """Normalize OpenAI-compatible usage objects."""
    if not usage_obj:
        return None
    prompt_tokens = int(_get_attr(usage_obj, "prompt_tokens", 0) or 0)
    completion_tokens = int(_get_attr(usage_obj, "completion_tokens", 0) or 0)
    total_tokens = int(_get_attr(usage_obj, "total_tokens", 0) or 0)
    if not total_tokens:
        total_tokens = prompt_tokens + completion_tokens
    if not any([prompt_tokens, completion_tokens, total_tokens]):
        return None
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }


def extract_response_usage(response: Any) -> dict[str, int] | None:
    return extract_usage(_get_attr(response, "usage"))


DEEPSEEK_PRICING = {
    "deepseek-v4-flash": {"input": 1.0, "output": 2.0},
    "deepseek-v4-pro": {"input": 3.0, "output": 6.0},
}
DEEPSEEK_PRICING_UPDATED = "2026-06-22"
DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing"


def model_prices(model: str | None = None) -> dict[str, float]:
    """Return current DeepSeek CNY prices per 1M tokens.

    Cache-hit token counts are not currently persisted, so input is deliberately
    estimated at the cache-miss rate. Legacy chat/reasoner aliases map to Flash.
    """
    normalized = (model or "").strip().lower()
    tier = "deepseek-v4-pro" if "v4-pro" in normalized or normalized.endswith("-pro") else "deepseek-v4-flash"
    defaults = DEEPSEEK_PRICING[tier]
    generic_input = os.getenv("MODEL_INPUT_PRICE_PER_1M_CNY")
    generic_output = os.getenv("MODEL_OUTPUT_PRICE_PER_1M_CNY")
    env_prefix = tier.upper().replace("-", "_")
    return {
        "input": float(generic_input if generic_input is not None else os.getenv(f"{env_prefix}_INPUT_PRICE_PER_1M_CNY", defaults["input"])),
        "output": float(generic_output if generic_output is not None else os.getenv(f"{env_prefix}_OUTPUT_PRICE_PER_1M_CNY", defaults["output"])),
    }


def estimate_cost(prompt_tokens: int, completion_tokens: int, model: str | None = None) -> float:
    """Estimate cost in CNY using current DeepSeek cache-miss pricing."""
    prices = model_prices(model)
    input_price = prices["input"]
    output_price = prices["output"]
    # MySQL SUM() values may be decimal.Decimal; normalize before combining
    # them with the floating-point pricing configuration.
    prompt_count = float(prompt_tokens or 0)
    completion_count = float(completion_tokens or 0)
    return (prompt_count / 1_000_000 * input_price) + (completion_count / 1_000_000 * output_price)


async def ensure_usage_tables() -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(CREATE_USAGE_LOGS_TABLE)


async def record_usage(
    *,
    user: dict | None,
    feature: str,
    model: str,
    usage: dict[str, int] | None,
    success: bool = True,
    error_message: str | None = None,
    meta_json: str | None = None,
) -> None:
    if not user or not usage:
        return
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or prompt_tokens + completion_tokens)
    cost = estimate_cost(prompt_tokens, completion_tokens, model)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO usage_logs
                    (user_id, username, feature, model, prompt_tokens, completion_tokens,
                     total_tokens, estimated_cost, success, error_message, meta_json, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    int(user["id"]),
                    str(user.get("username") or ""),
                    feature,
                    model,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    cost,
                    1 if success else 0,
                    error_message,
                    meta_json,
                    time.time(),
                ),
            )


async def record_response_usage(*, user: dict | None, feature: str, model: str, response: Any) -> None:
    await record_usage(user=user, feature=feature, model=model, usage=extract_response_usage(response))


async def get_usage_summary(start_ts: float | None = None, end_ts: float | None = None) -> dict:
    where = []
    params: list[Any] = []
    if start_ts:
        where.append("created_at >= %s")
        params.append(start_ts)
    if end_ts:
        where.append("created_at <= %s")
        params.append(end_ts)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                f"""
                SELECT
                    user_id, username, model,
                    COUNT(*) AS request_count,
                    SUM(prompt_tokens) AS prompt_tokens,
                    SUM(completion_tokens) AS completion_tokens,
                    SUM(total_tokens) AS total_tokens,
                    SUM(estimated_cost) AS estimated_cost,
                    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
                    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_count
                FROM usage_logs
                {where_sql}
                GROUP BY user_id, username, model
                ORDER BY total_tokens DESC
                """,
                params,
            )
            by_user = await cur.fetchall()

            await cur.execute(
                f"""
                SELECT
                    feature, model,
                    COUNT(*) AS request_count,
                    SUM(prompt_tokens) AS prompt_tokens,
                    SUM(completion_tokens) AS completion_tokens,
                    SUM(total_tokens) AS total_tokens,
                    SUM(estimated_cost) AS estimated_cost
                FROM usage_logs
                {where_sql}
                GROUP BY feature, model
                ORDER BY total_tokens DESC
                """,
                params,
            )
            by_feature = await cur.fetchall()

            await cur.execute(
                f"""
                SELECT
                    model,
                    COUNT(*) AS request_count,
                    SUM(prompt_tokens) AS prompt_tokens,
                    SUM(completion_tokens) AS completion_tokens,
                    SUM(total_tokens) AS total_tokens
                FROM usage_logs
                {where_sql}
                GROUP BY model
                ORDER BY total_tokens DESC
                """,
                params,
            )
            by_model = await cur.fetchall()

            await cur.execute(
                f"""
                SELECT
                    DATE(FROM_UNIXTIME(created_at)) AS usage_date,
                    model,
                    COUNT(*) AS request_count,
                    SUM(prompt_tokens) AS prompt_tokens,
                    SUM(completion_tokens) AS completion_tokens,
                    SUM(total_tokens) AS total_tokens
                FROM usage_logs
                {where_sql}
                GROUP BY usage_date, model
                ORDER BY usage_date ASC
                """,
                params,
            )
            daily_by_model = await cur.fetchall()

            await cur.execute(
                f"""
                SELECT
                    COUNT(*) AS request_count,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(estimated_cost), 0) AS estimated_cost
                FROM usage_logs
                {where_sql}
                """,
                params,
            )
            total = await cur.fetchone()

    def combine(rows: list[dict], keys: tuple[str, ...]) -> list[dict]:
        combined: dict[tuple, dict] = {}
        for row in rows:
            identity = tuple(row.get(key) for key in keys)
            target = combined.setdefault(identity, {key: row.get(key) for key in keys})
            for field in ("request_count", "prompt_tokens", "completion_tokens", "total_tokens", "success_count", "failed_count"):
                target[field] = int(target.get(field) or 0) + int(row.get(field) or 0)
            target["estimated_cost"] = float(target.get("estimated_cost") or 0) + estimate_cost(
                int(row.get("prompt_tokens") or 0), int(row.get("completion_tokens") or 0), row.get("model")
            )
        return sorted(combined.values(), key=lambda item: item.get("total_tokens", 0), reverse=True)

    priced_models = []
    for row in by_model:
        item = dict(row)
        prices = model_prices(item.get("model"))
        item["estimated_cost"] = estimate_cost(item.get("prompt_tokens") or 0, item.get("completion_tokens") or 0, item.get("model"))
        item["input_price_per_1m"] = prices["input"]
        item["output_price_per_1m"] = prices["output"]
        priced_models.append(item)

    daily: dict[str, dict] = defaultdict(lambda: {"request_count": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "estimated_cost": 0.0})
    for row in daily_by_model:
        date_value = row.get("usage_date")
        date_key = date_value.isoformat() if hasattr(date_value, "isoformat") else str(date_value)
        item = daily[date_key]
        for field in ("request_count", "prompt_tokens", "completion_tokens", "total_tokens"):
            item[field] += int(row.get(field) or 0)
        item["estimated_cost"] += estimate_cost(row.get("prompt_tokens") or 0, row.get("completion_tokens") or 0, row.get("model"))

    total = dict(total or {})
    total["estimated_cost"] = sum(float(row["estimated_cost"]) for row in priced_models)
    return {
        "total": total,
        "by_user": combine(by_user, ("user_id", "username")),
        "by_feature": combine(by_feature, ("feature",)),
        "by_model": priced_models,
        "daily": [{"date": date, **values} for date, values in sorted(daily.items())],
        "pricing": {
            "currency": "CNY",
            "input_basis": "cache_miss",
            "updated_at": DEEPSEEK_PRICING_UPDATED,
            "source_url": DEEPSEEK_PRICING_URL,
        },
    }


async def list_usage_logs(limit: int = 100, start_ts: float | None = None, end_ts: float | None = None) -> list[dict]:
    limit = max(1, min(int(limit or 100), 500))
    where = []
    params: list[Any] = []
    if start_ts:
        where.append("created_at >= %s")
        params.append(start_ts)
    if end_ts:
        where.append("created_at <= %s")
        params.append(end_ts)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                f"""
                SELECT id, user_id, username, feature, model, prompt_tokens, completion_tokens,
                       total_tokens, estimated_cost, success, error_message, created_at
                FROM usage_logs
                {where_sql}
                ORDER BY created_at DESC
                LIMIT %s
                """,
                [*params, limit],
            )
            rows = await cur.fetchall()
            for row in rows:
                row["estimated_cost"] = estimate_cost(
                    row.get("prompt_tokens") or 0,
                    row.get("completion_tokens") or 0,
                    row.get("model"),
                )
            return rows
