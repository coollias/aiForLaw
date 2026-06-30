"""
AI 法律助手 — 元典 MCP 客户端
连接元典法律检索 MCP 服务（HTTP SSE），提供法规/案例/企业信息检索
使用 MCP SDK streamable HTTP client + 持久化连接池

修复记录：
- 问题1: 增加 structuredContent 和嵌套 JSON (dataPreview.extra.wenshu) 的提取
- 问题3: 建立持久化 MCP 连接池，避免每次调用都新建 SSE 连接
"""
import asyncio
import contextlib
import json
import os
from typing import Any, Optional

import httpx
from mcp.client.streamable_http import streamable_http_client
from mcp import ClientSession

# ===== MCP 服务器配置 =====
MCP_SERVERS = {
    "law": {
        "key": "law",
        "url": "https://open.chineselaw.com/mcp/law/stream",
        "name": "元典法律法规检索",
    },
    "case": {
        "key": "case",
        "url": "https://open.chineselaw.com/mcp/case/stream",
        "name": "元典案例检索",
    },
    "company": {
        "key": "company",
        "url": "https://open.chineselaw.com/mcp/company/stream",
        "name": "元典企业信息",
    },
    "zhipu_search": {
        "key": "zhipu_search",
        "url": "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
        "name": "智谱AI联网搜索",
    },
}

# 服务分组（决定使用哪个 API Key）
MCP_SERVER_GROUPS = {
    "zhipu_search": "zhipu",
}
# 默认分组
DEFAULT_GROUP = "yuandian"

# ===== 全局状态 =====
_mcp_api_key: str = ""
_zhipu_api_key: str = ""
_mcp_enabled: bool = False
# 缓存: OpenAI 格式的工具定义列表
_mcp_tool_definitions: list[dict] = []
# 缓存: tool_name -> {"server_key": str, "original_name": str, ...}
_mcp_tool_registry: dict[str, dict] = {}
_initialized: bool = False

# ===== 持久化连接池（问题3修复） =====
# _mcp_connections[server_key] = {"stack": AsyncExitStack, "session": ClientSession}
_mcp_connections: dict[str, dict] = {}
# 分组 httpx 客户端: group -> httpx.AsyncClient
_mcp_http_clients: dict[str, httpx.AsyncClient] = {}
_mcp_conn_lock = asyncio.Lock()


def init_mcp(api_key: str = "", zhipu_api_key: str = "", enabled: bool = True):
    """初始化 MCP 配置"""
    global _mcp_api_key, _zhipu_api_key, _mcp_enabled, _initialized
    _mcp_api_key = api_key
    _zhipu_api_key = zhipu_api_key
    has_any_key = bool(api_key) or bool(zhipu_api_key)
    _mcp_enabled = enabled and has_any_key
    _initialized = False
    if _mcp_enabled:
        server_count = len(MCP_SERVERS)
        print(f"[MCP] MCP 已启用 ({server_count} 个服务, 含智谱 AI 联网搜索)")
    else:
        print("[MCP] MCP 未启用")


def is_mcp_available() -> bool:
    """检查 MCP 是否可用"""
    return _mcp_enabled


async def _connect_and_list_tools(server_key: str) -> list[dict]:
    """
    连接单个 MCP 服务器并获取工具列表。
    使用持久化连接（_ensure_connection），连接在不断，后续请求直接复用。
    返回 OpenAI 格式的 tool definitions。
    """
    cfg = MCP_SERVERS[server_key]
    tools = []

    try:
        conn = await _ensure_connection(server_key)
        if not conn:
            print(f"[MCP] {cfg['name']}: 无法建立持久化连接")
            return tools

        session = conn["session"]
        result = await session.list_tools()

        for tool in result.tools:
            # 生成唯一的工具名（加上服务前缀避免冲突）
            already_scoped = tool.name.startswith(f"yuandian_{server_key}_") or tool.name.startswith("yuandian_rh_")
            unique_name = tool.name if already_scoped else f"yuandian_{server_key}_{tool.name}"

            # 注册工具映射
            _mcp_tool_registry[unique_name] = {
                "server_key": server_key,
                "original_name": tool.name,
                "description": tool.description or tool.name,
                "input_schema": tool.inputSchema or {},
            }

            # 转为 OpenAI function calling 格式
            # 智谱搜索工具：使用更清晰的中文描述
            description = tool.description or tool.name
            if server_key == "zhipu_search":
                description = "联网搜索互联网上的最新信息。当用户问到时事、新闻、最新法规动态、不确定法律数据库是否覆盖的问题时，使用此工具。参数 search_query 为搜索关键词，count 为返回结果数量（默认5），search_recency_filter 可选 oneDay/oneWeek/oneMonth/oneYear。"

            tools.append({
                "type": "function",
                "function": {
                    "name": unique_name,
                    "description": f"[{cfg['name']}] {description}",
                    "parameters": tool.inputSchema if tool.inputSchema else {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "检索关键词",
                            },
                        },
                        "required": ["query"],
                    },
                },
            })

        print(f"[MCP] {cfg['name']}: 获取到 {len(tools)} 个工具")
    except Exception as e:
        print(f"[MCP] {cfg['name']}: 连接失败 — {e}")

    return tools


async def refresh_tools():
    """连接所有 MCP 服务器，刷新工具缓存（启动时调用一次）"""
    global _mcp_tool_definitions, _mcp_tool_registry, _initialized

    if not _mcp_enabled:
        print("[MCP] MCP 未启用，跳过工具加载")
        _initialized = True
        return

    _mcp_tool_definitions = []
    _mcp_tool_registry = {}

    # 并发连接所有 MCP 服务器
    results = await asyncio.gather(
        *[_connect_and_list_tools(key) for key in MCP_SERVERS],
        return_exceptions=True,
    )

    for i, result in enumerate(results):
        if isinstance(result, list):
            _mcp_tool_definitions.extend(result)
        elif isinstance(result, Exception):
            server_name = list(MCP_SERVERS.values())[i]["name"]
            print(f"[MCP] {server_name}: 加载异常 — {result}")

    print(f"[MCP] 总计加载 {len(_mcp_tool_definitions)} 个工具, "
          f"{len(_mcp_tool_registry)} 个已注册")
    _initialized = True


# ===== 持久化连接管理（问题3修复） =====

async def _get_http_client(server_key: str = "") -> httpx.AsyncClient:
    """获取分组 httpx 客户端（按服务器使用不同的 API Key）"""
    group = MCP_SERVER_GROUPS.get(server_key, DEFAULT_GROUP)
    api_key = _zhipu_api_key if group == "zhipu" else _mcp_api_key

    existing = _mcp_http_clients.get(group)
    if existing:
        return existing

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=15.0),
        headers={
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {api_key}",
        },
    )
    _mcp_http_clients[group] = client
    return client


async def _ensure_connection(server_key: str) -> dict | None:
    """
    确保与服务器的持久化连接已建立。
    返回连接字典，包含 session 引用。
    """
    # 快速路径：已有可用连接
    conn = _mcp_connections.get(server_key)
    if conn and not conn.get("_broken"):
        return conn

    cfg = MCP_SERVERS[server_key]
    url = cfg["url"]

    try:
        stack = contextlib.AsyncExitStack()

        # 复用分组 http client
        http_client = await _get_http_client(server_key)

        # 进入 transport 上下文（保持连接不断开）
        # 使用非 deprecated 版本以传入自定义 http_client
        streams = await stack.enter_async_context(
            streamable_http_client(url, http_client=http_client)
        )
        read, write, _get_session_id = streams

        # 进入 session 上下文
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()

        new_conn = {
            "stack": stack,
            "session": session,
            "_broken": False,
        }

        # 原子替换（关闭旧连接）
        async with _mcp_conn_lock:
            old = _mcp_connections.get(server_key)
            if old:
                try:
                    await old["stack"].aclose()
                except Exception:
                    pass
            _mcp_connections[server_key] = new_conn

        cfg = MCP_SERVERS[server_key]
        print(f"[MCP] 持久化连接已建立: {cfg['name']}")
        return new_conn

    except Exception as e:
        cfg = MCP_SERVERS[server_key]
        print(f"[MCP] {cfg['name']}: 持久化连接失败 — {str(e)[:200]}")
        return None


async def close_mcp_connections():
    """关闭所有持久化 MCP 连接（应用 shutdown 时调用）"""
    global _mcp_connections, _mcp_http_clients

    for server_key, conn in list(_mcp_connections.items()):
        try:
            stack = conn.get("stack")
            if stack:
                await stack.aclose()
        except Exception as e:
            print(f"[MCP] 关闭 {server_key} 连接失败: {e}")

    _mcp_connections.clear()

    for group, client in _mcp_http_clients.items():
        try:
            await client.aclose()
        except Exception:
            pass
    _mcp_http_clients.clear()

    print("[MCP] 所有持久化连接已关闭")


# ===== 数据提取（问题1修复） =====

def _extract_result_data(result) -> str:
    """
    从 MCP CallToolResult 中提取最丰富的数据。

    提取优先级：
      1. structuredContent（MCP新协议的结构化数据字段）——直接返回
      2. content[].text 中的嵌套数据（如 dataPreview.extra.wenshu）——提取后直接返回
      3. 原始 content[].text 内容

    注意：只返回单一 JSON 块，方便下游 json.loads 直接解析。
    """
    # 1. 优先提取 structuredContent（MCP新协议字段）
    try:
        sc = getattr(result, "structuredContent", None)
        if sc is not None:
            return json.dumps(sc, ensure_ascii=False)
    except Exception:
        pass

    # 2. 提取 content[].text / content[].data
    raw_texts = []
    for content in result.content:
        if hasattr(content, "text") and content.text:
            raw_texts.append(content.text)
        elif hasattr(content, "data"):
            raw_texts.append(str(content.data))

    if not raw_texts:
        return json.dumps({"result": "工具执行完成，无文本输出"}, ensure_ascii=False)

    combined = "\n".join(raw_texts)

    # 尝试解析为 JSON，递归提取深层嵌套数据
    try:
        parsed = json.loads(combined)
        enrichment = _extract_nested_content(parsed)
        if enrichment is not None:
            # 富化数据包含了 metadata + 实际 items，直接返回（单一 JSON）
            return json.dumps(enrichment, ensure_ascii=False)
        # 没有找到富化嵌套内容，返回原始 JSON
        return combined
    except (json.JSONDecodeError, ValueError, TypeError):
        # 不是 JSON，直接返回原文
        return combined


def _extract_nested_content(obj: Any, depth: int = 0) -> Any:
    """
    递归搜索 JSON 对象，查找附带在响应中的有效数据负载。
    主要针对元典 MCP 返回的 {dataPreview: {extra: {wenshu: [...]}}} 结构。

    参数：
        obj: 要搜索的 JSON 对象
        depth: 当前递归深度（防止栈溢出）

    返回：
        找到的有效数据字典（带 _data_source 和 items），或 None
    """
    if depth > 10:
        return None

    if isinstance(obj, dict):
        # ---- 路径1: dataPreview.extra.wenshu（案例检索的主要数据路径） ----
        dp = obj.get("dataPreview")
        if isinstance(dp, dict):
            extra = dp.get("extra")
            if isinstance(extra, dict):
                # 案例数据
                wenshu = extra.get("wenshu")
                if isinstance(wenshu, list) and len(wenshu) > 0 and isinstance(wenshu[0], dict):
                    return {
                        "_data_source": "dataPreview.extra.wenshu",
                        "item_count": len(wenshu),
                        "items": wenshu,
                    }
                # 法规/其他数据
                for key in ("laws", "lawsList", "case_list", "results", "list", "data", "items", "records"):
                    val = extra.get(key)
                    if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                        return {
                            "_data_source": f"dataPreview.extra.{key}",
                            "item_count": len(val),
                            "items": val,
                        }

            # dataPreview 本身也可能是数组
            for key in ("wenshu", "laws", "cases", "results", "list", "items"):
                val = dp.get(key)
                if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                    return {
                        "_data_source": f"dataPreview.{key}",
                        "item_count": len(val),
                        "items": val,
                    }

        # ---- 路径2: 直接 key 关键词查找 ----
        for data_key in ("data", "result", "results", "items", "list", "records", "wenshu", "cases", "laws"):
            val = obj.get(data_key)
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                sample = val[0]
                if any(k in sample for k in ("title", "name", "ah", "案号", "content", "id", "scid", "url", "jbdw", "法条", "法规")):
                    return {
                        "_data_source": f"root.{data_key}",
                        "item_count": len(val),
                        "items": val,
                    }

        # ---- 路径3: 递归查找嵌套路径 ----
        for probe_key in ("extra", "dataPreview", "resultData", "responseData", "dataPreview"):
            val = obj.get(probe_key)
            if isinstance(val, (dict, list)):
                found = _extract_nested_content(val, depth + 1)
                if found is not None:
                    return found

    elif isinstance(obj, list) and len(obj) > 0 and isinstance(obj[0], dict):
        sample = obj[0]
        if any(k in sample for k in ("title", "name", "ah", "案号", "content", "id", "scid", "jbdw", "url", "法条", "法规")):
            return {
                "_data_source": "root_list",
                "item_count": len(obj),
                "items": obj,
            }

    return None


# ===== MCP 工具执行 =====

async def _call_tool_persistent(server_key: str, original_name: str, arguments: dict) -> str:
    """在持久化会话上调用工具，自动重连一次。"""
    conn = await _ensure_connection(server_key)
    if not conn:
        return json.dumps(
            {"error": f"无法连接到 {MCP_SERVERS[server_key]['name']}"},
            ensure_ascii=False,
        )

    try:
        result = await conn["session"].call_tool(original_name, arguments)
        return _extract_result_data(result)
    except Exception as e:
        error_str = str(e)
        print(f"[MCP] 调用 {original_name} 失败 ({error_str[:120]}), 标记连接断开")

        # 标记为 broken，下次 _ensure_connection 会重建
        conn["_broken"] = True
        async with _mcp_conn_lock:
            if _mcp_connections.get(server_key) is conn:
                del _mcp_connections[server_key]

        # 自动重连一次
        try:
            cfg = MCP_SERVERS[server_key]
            print(f"[MCP] 正在重连 {cfg['name']}...")
            new_conn = await _ensure_connection(server_key)
            if new_conn:
                result = await new_conn["session"].call_tool(original_name, arguments)
                return _extract_result_data(result)
        except Exception as retry_e:
            print(f"[MCP] 重连后仍失败: {retry_e}")

        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def execute_mcp_tool(tool_name: str, arguments: dict) -> str:
    """
    执行 MCP 工具调用。
    使用持久化连接池（问题3修复），自动重连。
    返回工具执行结果的 JSON 字符串（问题1修复：含完整结构化数据）。
    """
    registry = _mcp_tool_registry.get(tool_name)
    if not registry:
        return json.dumps({"error": f"未知工具: {tool_name}"}, ensure_ascii=False)

    server_key = registry["server_key"]
    original_name = registry["original_name"]
    return await _call_tool_persistent(server_key, original_name, arguments)


# ===== 工具定义 =====

def get_mcp_tool_definitions() -> list[dict]:
    """获取 OpenAI 格式的 MCP 工具定义列表"""
    return _mcp_tool_definitions


def get_mcp_tool_names() -> list[str]:
    """获取所有可用的 MCP 工具名称"""
    return list(_mcp_tool_registry.keys())


# ===== 便捷检索方法 =====

async def search_law_direct(query: str, region: str = "") -> str:
    """直接通过元典 MCP 检索法律法规（快捷方法）"""
    arguments: dict[str, Any] = {"query": query}
    if region:
        arguments["query"] = f"{region} {query}"
    # 找到 law 服务器的搜索工具
    for name, reg in _mcp_tool_registry.items():
        if reg["server_key"] == "law" and "search" in name.lower():
            return await execute_mcp_tool(name, arguments)
    # fallback: 尝试所有 law 工具
    for name, reg in _mcp_tool_registry.items():
        if reg["server_key"] == "law":
            return await execute_mcp_tool(name, arguments)
    return json.dumps({"error": "未找到法律法规检索工具"}, ensure_ascii=False)


async def search_case_direct(query: str, region: str = "") -> str:
    """向后兼容的案例检索入口，默认使用语义检索。"""
    return await search_case_vector_direct(query, region=region)


def _find_tool_name(server_key: str, original_name: str) -> str | None:
    for unique_name, registry in _mcp_tool_registry.items():
        if registry["server_key"] == server_key and registry["original_name"] == original_name:
            return unique_name
    return None


async def _execute_named_case_tool(original_name: str, arguments: dict) -> str:
    tool_name = _find_tool_name("case", original_name)
    if not tool_name:
        return json.dumps({"error": f"未找到案例工具: {original_name}"}, ensure_ascii=False)
    return await execute_mcp_tool(tool_name, arguments)


async def search_case_vector_direct(
    query: str,
    *,
    region: str = "",
    return_num: int = 10,
    date_start: str = "",
    date_end: str = "",
) -> str:
    """案例语义检索，同时覆盖普通案例和权威案例。"""
    arguments: dict[str, Any] = {
        "query": str(query or "").strip(),
        "rewrite_flag": True,
        "return_num": max(1, min(int(return_num or 10), 20)),
    }
    if region:
        arguments["wenshu_filter"] = {"xzqh_p": region}
    if date_start or date_end:
        arguments["wenshu_filter"] = arguments.get("wenshu_filter") or {}
        if date_start:
            arguments["wenshu_filter"]["ja_start"] = date_start
        if date_end:
            arguments["wenshu_filter"]["ja_end"] = date_end
    return await _execute_named_case_tool("yuandian_case_vector_search", arguments)


async def search_case_ordinary_direct(arguments: dict, region: str = "", date_start: str = "", date_end: str = "") -> str:
    """普通裁判案例结构化检索。"""
    payload = dict(arguments or {})
    payload["top_k"] = max(1, min(int(payload.get("top_k") or 10), 20))
    if region:
        payload["xzqh_p"] = [region]
    if date_start:
        payload["ja_start"] = date_start
    if date_end:
        payload["ja_end"] = date_end
    if not any(value not in (None, "", [], {}) for key, value in payload.items() if key != "top_k"):
        payload["qw"] = "相关争议"
    return await _execute_named_case_tool("yuandian_rh_ptal_search", payload)


async def search_case_authoritative_direct(arguments: dict, region: str = "", date_start: str = "", date_end: str = "") -> str:
    """权威、典型、参考及公报案例结构化检索。"""
    payload = dict(arguments or {})
    payload["top_k"] = max(1, min(int(payload.get("top_k") or 10), 20))
    if region:
        payload["xzqh_p"] = [region]
    if date_start:
        payload["ja_start"] = date_start
    if date_end:
        payload["ja_end"] = date_end
    if not any(value not in (None, "", [], {}) for key, value in payload.items() if key != "top_k"):
        payload["qw"] = "相关争议"
    return await _execute_named_case_tool("yuandian_rh_qwal_search", payload)


async def get_case_details_direct(
    *,
    case_id: str = "",
    case_no: str = "",
    case_type: str = "",
) -> str:
    """按库内 ID 优先、案号兜底查询案例详情。"""
    arguments = {}
    if case_id and case_id != "未提取到信息":
        arguments["id"] = case_id
    elif case_no and case_no != "未提取到信息":
        arguments["ah"] = case_no
    else:
        return json.dumps({"error": "案例详情查询缺少 id/案号"}, ensure_ascii=False)
    if case_type in ("ptal", "qwal"):
        arguments["type"] = case_type
    return await _execute_named_case_tool("yuandian_rh_case_details", arguments)
