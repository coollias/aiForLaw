"""
AI 法律助手 — 认证模块
简单密码登录，Session + Cookie 管理
"""
import hashlib
import hmac
import os
import time
from typing import Optional

# Session 存储（简单内存版本，重启失效）
_sessions: dict[str, dict] = {}

# 默认密钥（可被 main.py 中的 env 覆盖）
SESSION_SECRET = "change-me-in-env"
SESSION_MAX_AGE = 24 * 3600  # 默认 24 小时


def init(secret: str, max_age_hours: int = 24):
    global SESSION_SECRET, SESSION_MAX_AGE
    SESSION_SECRET = secret
    SESSION_MAX_AGE = max_age_hours * 3600


def _hash_password(password: str) -> str:
    """对密码做简单哈希存储"""
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(input_pwd: str, stored_hash: str) -> bool:
    """验证输入的密码是否匹配"""
    return hmac.compare_digest(
        _hash_password(input_pwd),
        stored_hash
    )


def create_session() -> str:
    """创建一个新 Session，返回 token"""
    token = hashlib.sha256(os.urandom(32)).hexdigest()
    _sessions[token] = {
        "created_at": time.time(),
        "messages": [],  # 对话历史
    }
    # 定期清理过期 session
    _cleanup()
    return token


def get_session(token: Optional[str]) -> Optional[dict]:
    """获取 Session 数据，过期返回 None"""
    if not token or token not in _sessions:
        return None
    session = _sessions[token]
    if time.time() - session["created_at"] > SESSION_MAX_AGE:
        del _sessions[token]
        return None
    return session


def _cleanup():
    """清理过期 session"""
    now = time.time()
    expired = [
        t for t, s in _sessions.items()
        if now - s["created_at"] > SESSION_MAX_AGE
    ]
    for t in expired:
        del _sessions[t]


def get_messages(token: Optional[str]) -> list[dict]:
    """获取对话历史"""
    session = get_session(token)
    if session:
        return session.get("messages", [])
    return []


def add_message(token: Optional[str], role: str, content: str):
    """添加一条对话记录"""
    session = get_session(token)
    if session:
        session["messages"].append({"role": role, "content": content})
        # 限制历史长度，防止内存溢出
        if len(session["messages"]) > 100:
            session["messages"] = session["messages"][-80:]


def clear_messages(token: Optional[str]):
    """清空对话历史"""
    session = get_session(token)
    if session:
        session["messages"] = []


def delete_session(token: Optional[str]):
    """退出登录"""
    if token and token in _sessions:
        del _sessions[token]
