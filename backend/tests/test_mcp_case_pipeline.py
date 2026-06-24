import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
DEPS_DIR = BACKEND_DIR / ".deps"
for dependency_path in (DEPS_DIR, DEPS_DIR / "win32", DEPS_DIR / "win32" / "lib", BACKEND_DIR):
    sys.path.insert(0, str(dependency_path))
if hasattr(os, "add_dll_directory"):
    os.add_dll_directory(str(DEPS_DIR / "pywin32_system32"))

import mcp_client


class CaseMcpRoutingTests(unittest.TestCase):
    def setUp(self):
        mcp_client._mcp_tool_registry = {
            "yuandian_case_vector_search": {"server_key": "case", "original_name": "yuandian_case_vector_search"},
            "yuandian_rh_ptal_search": {"server_key": "case", "original_name": "yuandian_rh_ptal_search"},
            "yuandian_rh_qwal_search": {"server_key": "case", "original_name": "yuandian_rh_qwal_search"},
            "yuandian_rh_case_details": {"server_key": "case", "original_name": "yuandian_rh_case_details"},
        }

    def test_three_search_channels_route_to_explicit_tools(self):
        async def run():
            with patch.object(mcp_client, "execute_mcp_tool", new=AsyncMock(return_value='{"status":"success"}')) as execute:
                await asyncio.gather(
                    mcp_client.search_case_vector_direct("逾期交付违约责任", region="北京", return_num=8),
                    mcp_client.search_case_ordinary_direct({"qw": "逾期交付", "search_mode": "or"}),
                    mcp_client.search_case_authoritative_direct({"qw": "逾期交付", "search_mode": "or"}),
                )
                calls = {call.args[0]: call.args[1] for call in execute.await_args_list}
                self.assertEqual(set(calls), {
                    "yuandian_case_vector_search",
                    "yuandian_rh_ptal_search",
                    "yuandian_rh_qwal_search",
                })
                self.assertEqual(calls["yuandian_case_vector_search"]["wenshu_filter"]["xzqh_p"], "北京")
                self.assertEqual(calls["yuandian_rh_ptal_search"]["qw"], "逾期交付")
                self.assertEqual(calls["yuandian_rh_qwal_search"]["search_mode"], "or")

        asyncio.run(run())

    def test_details_prefer_id_and_preserve_library_type(self):
        async def run():
            with patch.object(mcp_client, "execute_mcp_tool", new=AsyncMock(return_value='{"status":"success"}')) as execute:
                await mcp_client.get_case_details_direct(case_id="case-id", case_no="（2025）京01民终1号", case_type="qwal")
                execute.assert_awaited_once_with(
                    "yuandian_rh_case_details",
                    {"id": "case-id", "type": "qwal"},
                )

        asyncio.run(run())

    @unittest.skipUnless(os.getenv("RUN_LIVE_MCP_TESTS") == "1", "live MCP smoke test is opt-in")
    def test_live_search_and_detail(self):
        from dotenv import load_dotenv

        load_dotenv(BACKEND_DIR / ".env")
        mcp_client.init_mcp(os.getenv("YUANDIAN_API_KEY", ""), True)

        def decode(raw):
            data = json.loads(raw)

            def find_rows(value):
                if isinstance(value, str):
                    try:
                        return find_rows(json.loads(value))
                    except (TypeError, ValueError, json.JSONDecodeError):
                        return []
                if isinstance(value, list):
                    if value and isinstance(value[0], dict) and any(key in value[0] for key in ("id", "ah", "scid", "title")):
                        return value
                    for item in value:
                        rows = find_rows(item)
                        if rows:
                            return rows
                    return []
                if isinstance(value, dict):
                    for key in ("lst", "list", "rows", "results", "data", "result"):
                        if key in value:
                            rows = find_rows(value[key])
                            if rows:
                                return rows
                    for nested in value.values():
                        rows = find_rows(nested)
                        if rows:
                            return rows
                return []

            rows = find_rows(data)
            return data, rows

        async def run():
            await mcp_client.refresh_tools()
            vector_raw, ordinary_raw, authority_raw = await asyncio.gather(
                mcp_client.search_case_vector_direct("买卖合同逾期付款违约金", return_num=2),
                mcp_client.search_case_ordinary_direct({"qw": "逾期付款 违约金", "search_mode": "or", "top_k": 2}),
                mcp_client.search_case_authoritative_direct({"qw": "逾期付款 违约金", "search_mode": "or", "top_k": 2}),
            )
            decoded = [decode(raw) for raw in (vector_raw, ordinary_raw, authority_raw)]
            for response, _ in decoded:
                self.assertTrue(
                    response.get("status") in ("success", 200) or response.get("code") == 200,
                    response,
                )
            detail_candidate = next((row for _, rows in decoded[1:] for row in rows if row.get("id") or row.get("ah")), None)
            self.assertIsNotNone(
                detail_candidate,
                json.dumps({"ordinary": ordinary_raw[:1200], "authority": authority_raw[:1200]}, ensure_ascii=False),
            )
            detail_type = "ptal" if detail_candidate in decoded[1][1] else "qwal"
            detail_raw = await mcp_client.get_case_details_direct(
                case_id=detail_candidate.get("id") or "",
                case_no=detail_candidate.get("ah") or "",
                case_type=detail_type,
            )
            detail = json.loads(detail_raw)
            self.assertTrue(detail.get("status") in ("success", 200) or detail.get("code") == 200, detail)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
