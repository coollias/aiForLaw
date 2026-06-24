"""
AI 法律助手 — 数据库管理模块
MySQL 连接池 + 会话/消息表操作
"""
import asyncio
import hashlib
import json
import os
import time
from typing import Optional

import aiomysql

# 全局连接池
_pool: aiomysql.Pool | None = None

# 数据库配置
DB_HOST = ""
DB_PORT = 3306
DB_USER = ""
DB_PASSWORD = ""
DB_NAME = "ai_law_helper"

# 表结构常量
CREATE_SESSIONS_TABLE = """
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id BIGINT,
    created_at DOUBLE NOT NULL,
    last_active DOUBLE NOT NULL,
    title VARCHAR(200) DEFAULT '新对话',
    INDEX idx_user_last_active (user_id, last_active),
    INDEX idx_last_active (last_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_MESSAGES_TABLE = """
CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    role ENUM('user', 'assistant', 'tool') NOT NULL,
    content TEXT,
    tool_calls LONGTEXT,
    tool_call_id VARCHAR(128),
    created_at DOUBLE NOT NULL,
    INDEX idx_session_id (session_id),
    INDEX idx_session_created (session_id, created_at),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_PASSWORD_TABLE = """
CREATE TABLE IF NOT EXISTS settings (
    k VARCHAR(64) PRIMARY KEY,
    v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_USERS_TABLE = """
CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(128) NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DOUBLE NOT NULL,
    updated_at DOUBLE NOT NULL,
    INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_AUTH_SESSIONS_TABLE = """
CREATE TABLE IF NOT EXISTS auth_sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    created_at DOUBLE NOT NULL,
    expires_at DOUBLE NOT NULL,
    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_CONTRACT_REVIEWS_TABLE = """
CREATE TABLE IF NOT EXISTS contract_reviews (
    id VARCHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    session_id VARCHAR(64),
    filename VARCHAR(255) NOT NULL,
    file_mime VARCHAR(128),
    file_path VARCHAR(512),
    note TEXT,
    parsed_source VARCHAR(32),
    parsed_doc_json LONGTEXT,
    review_json LONGTEXT NOT NULL,
    created_at DOUBLE NOT NULL,
    updated_at DOUBLE NOT NULL,
    INDEX idx_user_updated (user_id, updated_at),
    INDEX idx_session_id (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_RESEARCH_RECORDS_TABLE = """
CREATE TABLE IF NOT EXISTS research_records (
    id VARCHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    query_text TEXT NOT NULL,
    answer_text LONGTEXT,
    references_json LONGTEXT,
    meta_json LONGTEXT,
    created_at DOUBLE NOT NULL,
    updated_at DOUBLE NOT NULL,
    INDEX idx_user_updated (user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

CREATE_RESEARCH_MESSAGES_TABLE = """
CREATE TABLE IF NOT EXISTS research_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    record_id VARCHAR(64) NOT NULL,
    user_id BIGINT NOT NULL,
    role VARCHAR(16) NOT NULL,
    content LONGTEXT,
    files_json LONGTEXT,
    created_at DOUBLE NOT NULL,
    INDEX idx_record_created (record_id, created_at),
    INDEX idx_user_created (user_id, created_at),
    CONSTRAINT fk_research_messages_record
        FOREIGN KEY (record_id) REFERENCES research_records(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

MAX_MESSAGES_PER_SESSION = 200


async def init_db(
    host: str,
    user: str,
    password: str,
    database: str = "ai_law_helper",
    port: int = 3306,
):
    """初始化数据库连接池和表结构"""
    global _pool, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
    DB_HOST = host
    DB_PORT = port
    DB_USER = user
    DB_PASSWORD = password
    DB_NAME = database

    # 先连接到 MySQL 创建数据库（如果不存在）
    tmp_pool = await aiomysql.create_pool(
        host=host, port=port, user=user, password=password,
        charset="utf8mb4", autocommit=True,
    )
    async with tmp_pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{database}` "
                f"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    tmp_pool.close()
    await tmp_pool.wait_closed()

    # 创建正式连接池
    _pool = await aiomysql.create_pool(
        host=host, port=port, user=user, password=password,
        db=database, charset="utf8mb4", autocommit=True,
        minsize=2, maxsize=10,
    )

    # 建表
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(CREATE_USERS_TABLE)
            await cur.execute(CREATE_SESSIONS_TABLE)
            await cur.execute(CREATE_MESSAGES_TABLE)
            await cur.execute(CREATE_PASSWORD_TABLE)
            await cur.execute(CREATE_AUTH_SESSIONS_TABLE)
            await cur.execute(CREATE_CONTRACT_REVIEWS_TABLE)
            await cur.execute(CREATE_RESEARCH_RECORDS_TABLE)
            await cur.execute(CREATE_RESEARCH_MESSAGES_TABLE)
            # 如果旧表缺 title 列，自动补充
            try:
                await cur.execute("ALTER TABLE sessions ADD COLUMN title VARCHAR(200) DEFAULT '新对话'")
            except Exception:
                pass  # 列已存在
            try:
                await cur.execute("ALTER TABLE sessions ADD COLUMN user_id BIGINT")
            except Exception:
                pass  # 列已存在
            try:
                await cur.execute("ALTER TABLE sessions ADD INDEX idx_user_last_active (user_id, last_active)")
            except Exception:
                pass  # 索引已存在

    print(f"[DB] MySQL 连接成功: {host}:{port}/{database}")


async def get_pool() -> aiomysql.Pool:
    """获取连接池"""
    if _pool is None:
        raise RuntimeError("数据库未初始化，请先调用 init_db()")
    return _pool


async def close_db():
    """关闭连接池"""
    global _pool
    if _pool:
        try:
            _pool.close()
            await _pool.wait_closed()
        except Exception:
            pass
        _pool = None


# ===== 密码存储 =====

def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


async def get_stored_password_hash() -> str:
    """从数据库获取存储的密码哈希"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT v FROM settings WHERE k = 'password_hash'")
            row = await cur.fetchone()
            return row[0] if row else ""


async def set_stored_password(password: str):
    """设置密码（首次启动）"""
    pool = await get_pool()
    phash = _hash_password(password)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO settings (k, v) VALUES ('password_hash', %s) "
                "ON DUPLICATE KEY UPDATE v = VALUES(v)",
                (phash,)
            )


async def verify_password(input_pwd: str) -> bool:
    """验证密码，首次使用则自动设置"""
    stored = await get_stored_password_hash()
    if not stored:
        # 首次启动：用用户预设的密码
        await set_stored_password(input_pwd)
        return True
    import hmac
    return hmac.compare_digest(_hash_password(input_pwd), stored)


# ===== 用户与登录态管理 =====

def _public_user(row: dict) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "is_admin": bool(row["is_admin"]),
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def get_user_by_username(username: str) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute("SELECT * FROM users WHERE username = %s", (username,))
            return await cur.fetchone()


async def get_user_by_id(user_id: int) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            return await cur.fetchone()


async def ensure_user(username: str, password: str, is_admin: bool = False) -> dict:
    existing = await get_user_by_username(username)
    now = time.time()
    phash = _hash_password(password)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if existing:
                await cur.execute(
                    "UPDATE users SET password_hash = %s, is_admin = %s, is_active = 1, updated_at = %s "
                    "WHERE id = %s",
                    (phash, 1 if is_admin else 0, now, existing["id"]),
                )
            else:
                await cur.execute(
                    "INSERT INTO users (username, password_hash, is_admin, is_active, created_at, updated_at) "
                    "VALUES (%s, %s, %s, 1, %s, %s)",
                    (username, phash, 1 if is_admin else 0, now, now),
                )
    return await get_user_by_username(username)


async def bootstrap_admin_user(username: str, password: str) -> dict:
    """创建/更新默认管理员，并把旧会话迁移到该用户下。"""
    admin = await ensure_user(username, password, is_admin=True)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE sessions SET user_id = %s WHERE user_id IS NULL",
                (admin["id"],),
            )
    return admin


async def verify_user(username: str, password: str) -> Optional[dict]:
    import hmac
    user = await get_user_by_username(username)
    if not user or not user["is_active"]:
        return None
    if not hmac.compare_digest(_hash_password(password), user["password_hash"]):
        return None
    return user


async def create_auth_session(user_id: int, max_age_seconds: int) -> str:
    token = hashlib.sha256(os.urandom(32)).hexdigest()
    now = time.time()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                (token, user_id, now, now + max_age_seconds),
            )
            await cur.execute("DELETE FROM auth_sessions WHERE expires_at < %s", (now,))
    return token


async def get_user_by_auth_token(token: str | None) -> Optional[dict]:
    if not token:
        return None
    now = time.time()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT u.* FROM auth_sessions a JOIN users u ON u.id = a.user_id "
                "WHERE a.token = %s AND a.expires_at >= %s AND u.is_active = 1",
                (token, now),
            )
            return await cur.fetchone()


async def delete_auth_session(token: str | None):
    if not token:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM auth_sessions WHERE token = %s", (token,))


async def list_users() -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT id, username, is_admin, is_active, created_at, updated_at FROM users "
                "ORDER BY created_at ASC"
            )
            rows = await cur.fetchall()
    return [_public_user(r) for r in rows]


async def create_user(username: str, password: str, is_admin: bool = False) -> dict:
    username = username.strip()
    if not username:
        raise ValueError("用户名不能为空")
    if await get_user_by_username(username):
        raise ValueError("用户名已存在")
    user = await ensure_user(username, password, is_admin=is_admin)
    return _public_user(user)


async def update_user(user_id: int, *, password: str | None = None, is_admin: bool | None = None, is_active: bool | None = None) -> dict:
    user = await get_user_by_id(user_id)
    if not user:
        raise ValueError("用户不存在")
    fields = []
    values = []
    if password:
        fields.append("password_hash = %s")
        values.append(_hash_password(password))
    if is_admin is not None:
        fields.append("is_admin = %s")
        values.append(1 if is_admin else 0)
    if is_active is not None:
        fields.append("is_active = %s")
        values.append(1 if is_active else 0)
    fields.append("updated_at = %s")
    values.append(time.time())
    values.append(user_id)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = %s", values)
    updated = await get_user_by_id(user_id)
    return _public_user(updated)


# ===== Session 管理 =====

async def create_session(user_id: int, title: str = "新对话") -> str:
    """创建新会话，返回 session_id"""
    token = hashlib.sha256(os.urandom(32)).hexdigest()
    now = time.time()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO sessions (id, user_id, created_at, last_active, title) "
                "VALUES (%s, %s, %s, %s, %s)",
                (token, user_id, now, now, title),
            )
    await _cleanup_old_sessions(user_id)
    return token


async def update_session_title(session_id: str, title: str, user_id: int | None = None):
    """更新会话标题"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if user_id is None:
                await cur.execute(
                    "UPDATE sessions SET title = %s WHERE id = %s",
                    (title, session_id),
                )
            else:
                await cur.execute(
                    "UPDATE sessions SET title = %s WHERE id = %s AND user_id = %s",
                    (title, session_id, user_id),
                )


async def list_sessions(user_id: int) -> list[dict]:
    """列出所有会话（按最后活跃时间倒序）"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT id, title, created_at, last_active FROM sessions "
                "WHERE user_id = %s ORDER BY last_active DESC LIMIT 50",
                (user_id,),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": r["id"],
            "title": r["title"] or "新对话",
            "created_at": r["created_at"],
            "last_active": r["last_active"],
        }
        for r in rows
    ]


async def touch_session(session_id: str, user_id: int | None = None):
    """更新会话最后活跃时间"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if user_id is None:
                await cur.execute(
                    "UPDATE sessions SET last_active = %s WHERE id = %s",
                    (time.time(), session_id),
                )
            else:
                await cur.execute(
                    "UPDATE sessions SET last_active = %s WHERE id = %s AND user_id = %s",
                    (time.time(), session_id, user_id),
                )


async def get_session(session_id: str, user_id: int | None = None) -> Optional[dict]:
    """获取会话信息"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            if user_id is None:
                await cur.execute("SELECT * FROM sessions WHERE id = %s", (session_id,))
            else:
                await cur.execute(
                    "SELECT * FROM sessions WHERE id = %s AND user_id = %s",
                    (session_id, user_id),
                )
            return await cur.fetchone()


async def delete_session(session_id: str, user_id: int | None = None):
    """删除会话及关联消息"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if user_id is None:
                await cur.execute("DELETE FROM sessions WHERE id = %s", (session_id,))
            else:
                await cur.execute("DELETE FROM sessions WHERE id = %s AND user_id = %s", (session_id, user_id))


async def _cleanup_old_sessions(user_id: int | None = None):
    """清理超过 7 天未活跃的会话"""
    cutoff = time.time() - 7 * 86400
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if user_id is None:
                await cur.execute("DELETE FROM sessions WHERE last_active < %s", (cutoff,))
            else:
                await cur.execute("DELETE FROM sessions WHERE user_id = %s AND last_active < %s", (user_id, cutoff))


# ===== 消息管理 =====

async def get_messages(session_id: str, limit: int = 60) -> list[dict]:
    """获取会话的对话历史（最近 N 条）"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT role, content, tool_calls, tool_call_id FROM messages "
                "WHERE session_id = %s ORDER BY id ASC",
                (session_id,),
            )
            rows = await cur.fetchall()

    messages = []
    total = len(rows)
    start = max(0, total - limit)
    for row in rows[start:]:
        msg = {
            "role": row["role"],
            "content": row["content"],
        }
        if row["tool_calls"]:
            try:
                msg["tool_calls"] = json.loads(row["tool_calls"])
            except (json.JSONDecodeError, TypeError):
                pass
        if row["tool_call_id"]:
            msg["tool_call_id"] = row["tool_call_id"]
        messages.append(msg)
    return messages


async def add_message(
    session_id: str,
    role: str,
    content: str | None = None,
    tool_calls: list[dict] | None = None,
    tool_call_id: str | None = None,
):
    """添加一条消息"""
    pool = await get_pool()
    now = time.time()
    tc_json = json.dumps(tool_calls, ensure_ascii=False) if tool_calls else None
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (session_id, role, content, tc_json, tool_call_id, now),
            )
    # 更新最后活跃时间
    await touch_session(session_id)
    # 裁剪旧消息
    await _trim_messages(session_id)


async def _trim_messages(session_id: str):
    """保留最近的消息，删除过旧的"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id FROM messages WHERE session_id = %s ORDER BY id DESC",
                (session_id,),
            )
            rows = await cur.fetchall()
            if len(rows) > MAX_MESSAGES_PER_SESSION:
                keep_id = rows[MAX_MESSAGES_PER_SESSION - 1][0]
                await cur.execute(
                    "DELETE FROM messages WHERE session_id = %s AND id < %s",
                    (session_id, keep_id),
                )


async def clear_messages(session_id: str):
    """清空会话消息"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM messages WHERE session_id = %s", (session_id,)
            )


async def save_full_messages(session_id: str, messages: list[dict]):
    """
    保存完整的消息链（function calling 后调用）
    只保存本轮新增的 user/assistant/tool 消息
    """
    for msg in messages:
        if msg.get("role") == "system":
            continue
        await add_message(
            session_id=session_id,
            role=msg["role"],
            content=msg.get("content"),
            tool_calls=msg.get("tool_calls"),
            tool_call_id=msg.get("tool_call_id"),
        )


async def save_new_messages(session_id: str, messages: list[dict], start_index: int = 0):
    """只保存本轮新增的消息，避免把历史消息重复写入数据库。"""
    for msg in messages[start_index:]:
        if msg.get("role") == "system":
            continue
        await add_message(
            session_id=session_id,
            role=msg["role"],
            content=msg.get("content"),
            tool_calls=msg.get("tool_calls"),
            tool_call_id=msg.get("tool_call_id"),
        )


# ===== 法规/案例检索记录 =====

def _public_research_record(row: dict, include_detail: bool = False) -> dict:
    refs = []
    meta = {}
    try:
        refs = json.loads(row.get("references_json") or "[]")
    except (TypeError, json.JSONDecodeError):
        refs = []
    try:
        meta = json.loads(row.get("meta_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        meta = {}

    item = {
        "id": row["id"],
        "query": row.get("query_text") or "",
        "title": (row.get("query_text") or "检索记录").strip()[:40],
        "reference_count": len(refs) if isinstance(refs, list) else 0,
        "case_count": len([r for r in refs if isinstance(r, dict) and r.get("type") == "case"]) if isinstance(refs, list) else 0,
        "law_count": len([r for r in refs if isinstance(r, dict) and r.get("type") == "law"]) if isinstance(refs, list) else 0,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "meta": meta,
    }
    if include_detail:
        item["answer"] = row.get("answer_text") or ""
        item["references"] = refs if isinstance(refs, list) else []
    return item


async def save_research_record(
    user_id: int,
    query_text: str,
    answer_text: str,
    references: list[dict],
    meta: dict | None = None,
    messages: list[dict] | None = None,
) -> str:
    record_id = hashlib.sha256(os.urandom(32)).hexdigest()
    now = time.time()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO research_records "
                "(id, user_id, query_text, answer_text, references_json, meta_json, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    record_id,
                    user_id,
                    query_text,
                    answer_text,
                    json.dumps(references, ensure_ascii=False),
                    json.dumps(meta or {}, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            for message in messages or []:
                role = str(message.get("role") or "").strip()
                if role not in {"user", "assistant"}:
                    continue
                await cur.execute(
                    "INSERT INTO research_messages "
                    "(record_id, user_id, role, content, files_json, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (
                        record_id,
                        user_id,
                        role,
                        message.get("content") or "",
                        json.dumps(message.get("files") or [], ensure_ascii=False),
                        now,
                    ),
                )
    return record_id


def _public_research_message(row: dict) -> dict:
    files = []
    try:
        files = json.loads(row.get("files_json") or "[]")
    except (TypeError, json.JSONDecodeError):
        files = []
    return {
        "id": row["id"],
        "record_id": row["record_id"],
        "role": row.get("role") or "",
        "content": row.get("content") or "",
        "files": files if isinstance(files, list) else [],
        "created_at": row["created_at"],
    }


async def add_research_message(
    record_id: str,
    user_id: int,
    role: str,
    content: str,
    files: list[dict] | None = None,
) -> bool:
    if role not in {"user", "assistant"}:
        return False
    now = time.time()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id FROM research_records WHERE id = %s AND user_id = %s",
                (record_id, user_id),
            )
            if not await cur.fetchone():
                return False
            await cur.execute(
                "INSERT INTO research_messages "
                "(record_id, user_id, role, content, files_json, created_at) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (
                    record_id,
                    user_id,
                    role,
                    content or "",
                    json.dumps(files or [], ensure_ascii=False),
                    now,
                ),
            )
            await cur.execute(
                "UPDATE research_records SET updated_at = %s WHERE id = %s AND user_id = %s",
                (now, record_id, user_id),
            )
    return True


async def list_research_messages(record_id: str, user_id: int) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT * FROM research_messages "
                "WHERE record_id = %s AND user_id = %s ORDER BY created_at ASC, id ASC",
                (record_id, user_id),
            )
            rows = await cur.fetchall()
    return [_public_research_message(row) for row in rows]


async def list_research_records(user_id: int, limit: int = 30) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT * FROM research_records WHERE user_id = %s ORDER BY updated_at DESC LIMIT %s",
                (user_id, limit),
            )
            rows = await cur.fetchall()
    return [_public_research_record(row) for row in rows]


async def get_research_record(record_id: str, user_id: int) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT * FROM research_records WHERE id = %s AND user_id = %s",
                (record_id, user_id),
            )
            row = await cur.fetchone()
    if not row:
        return None
    record = _public_research_record(row, include_detail=True)
    messages = await list_research_messages(record_id, user_id)
    if not messages:
        messages = [
            {
                "id": 0,
                "record_id": record_id,
                "role": "user",
                "content": record.get("query") or "",
                "files": [],
                "created_at": record.get("created_at"),
            },
            {
                "id": 0,
                "record_id": record_id,
                "role": "assistant",
                "content": record.get("answer") or "",
                "files": [],
                "created_at": record.get("created_at"),
            },
        ]
    record["messages"] = messages
    return record


async def delete_research_record(record_id: str, user_id: int) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM research_messages WHERE record_id = %s AND user_id = %s",
                (record_id, user_id),
            )
            await cur.execute(
                "DELETE FROM research_records WHERE id = %s AND user_id = %s",
                (record_id, user_id),
            )
            return cur.rowcount > 0


# ===== 合同审查记录 =====

def _public_contract_review(row: dict) -> dict:
    review = {}
    try:
        review = json.loads(row.get("review_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        pass
    issues = review.get("issues") if isinstance(review, dict) else []
    return {
        "id": row["id"],
        "filename": row["filename"],
        "file_mime": row.get("file_mime") or "",
        "note": row.get("note") or "",
        "parsed_source": row.get("parsed_source") or "",
        "overall_risk": review.get("overall_risk", "medium") if isinstance(review, dict) else "medium",
        "issue_count": len(issues) if isinstance(issues, list) else 0,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def save_contract_review(
    *,
    user_id: int,
    session_id: str | None,
    filename: str,
    file_mime: str,
    file_path: str,
    note: str,
    parsed_doc: dict | None,
    review: dict,
) -> dict:
    review_id = hashlib.sha256(os.urandom(32)).hexdigest()
    now = time.time()
    parsed_json = json.dumps(parsed_doc, ensure_ascii=False) if parsed_doc else None
    review_json = json.dumps(review, ensure_ascii=False)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO contract_reviews "
                "(id, user_id, session_id, filename, file_mime, file_path, note, parsed_source, parsed_doc_json, review_json, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    review_id,
                    user_id,
                    session_id,
                    filename,
                    file_mime,
                    file_path,
                    note,
                    (parsed_doc or {}).get("source", ""),
                    parsed_json,
                    review_json,
                    now,
                    now,
                ),
            )
    return await get_contract_review(review_id, user_id)


async def list_contract_reviews(user_id: int, limit: int = 50) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT id, filename, file_mime, note, parsed_source, review_json, created_at, updated_at "
                "FROM contract_reviews WHERE user_id = %s ORDER BY updated_at DESC LIMIT %s",
                (user_id, limit),
            )
            rows = await cur.fetchall()
    return [_public_contract_review(row) for row in rows]


async def get_contract_review(review_id: str, user_id: int) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT * FROM contract_reviews WHERE id = %s AND user_id = %s",
                (review_id, user_id),
            )
            row = await cur.fetchone()
    if not row:
        return None
    try:
        parsed_doc = json.loads(row.get("parsed_doc_json") or "null")
    except (TypeError, json.JSONDecodeError):
        parsed_doc = None
    try:
        review = json.loads(row.get("review_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        review = {}
    public = _public_contract_review(row)
    public.update({
        "file_path": row.get("file_path") or "",
        "parsed_doc": parsed_doc,
        "review": review,
    })
    return public


async def delete_contract_review(review_id: str, user_id: int) -> Optional[str]:
    record = await get_contract_review(review_id, user_id)
    if not record:
        return None
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM contract_reviews WHERE id = %s AND user_id = %s",
                (review_id, user_id),
            )
    return record.get("file_path") or ""
