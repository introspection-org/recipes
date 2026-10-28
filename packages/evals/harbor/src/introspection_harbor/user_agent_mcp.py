"""The user agent's environment primitives, served as an MCP server on the host.

Pi has no way for the process that starts it to register tools: its RPC mode
takes prompts and streams events, and extensions run inside Pi. So the
primitives are a streamable-HTTP MCP server inside the Harbor process, where
the trial's ``environment`` lives. A Recipe extension registers it with Pi's
own MCP client and calls the primitives through ``ctx.executeTool``.

Only what an MCP client needs is implemented: ``initialize``, ``ping``,
``tools/list`` and ``tools/call``, one JSON-RPC request per POST, answered as a
server-sent event stream. A prompt to the target waits for its whole turn,
which can take many minutes, so the stream carries a keepalive (a progress
notification when the client asked for one, a comment otherwise) and Node's
fetch never sees an idle connection. The server listens on 127.0.0.1 and
refuses a request without the per-run bearer token.

A call lives no longer than its connection: when the client hangs up, as it
does when Pi is killed, the call is cancelled, and ``close`` cancels and awaits
every call still running, so no primitive is still writing once it returns.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = "2025-06-18"
KEEPALIVE_SEC = 15.0
MAX_BODY_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class Tool:
    """One MCP tool: its schema, and the coroutine that answers a call.

    ``handler`` returns the result object, sent as ``structuredContent`` and,
    as JSON, as the text content. An exception becomes a tool result with
    ``isError`` and the exception's message.
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class ToolServer:
    """A minimal streamable-HTTP MCP server for ``tools`` at ``/mcp``."""

    def __init__(
        self,
        tools: Sequence[Tool],
        token: str,
        *,
        name: str = "introspection-user-agent",
        version: str = "0",
        keepalive_sec: float = KEEPALIVE_SEC,
    ) -> None:
        self._tools = {tool.name: tool for tool in tools}
        self._token = token
        self._info = {"name": name, "version": version}
        self._keepalive_sec = keepalive_sec
        self._server: asyncio.Server | None = None
        self._connections: set[asyncio.Task[Any]] = set()
        self._calls: set[asyncio.Future[dict[str, Any]]] = set()

    async def start(self) -> str:
        """Listen on a free port on 127.0.0.1 and return the endpoint URL."""

        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}/mcp"

    async def close(self) -> None:
        """Stop listening, then cancel and await every open connection and call."""

        if self._server is not None:
            self._server.close()
            running = {*self._connections, *self._calls}
            for task in running:
                task.cancel()
            await asyncio.gather(*running, return_exceptions=True)
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
            self._server = None

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        connection = asyncio.current_task()
        assert connection is not None
        self._connections.add(connection)
        try:
            await self._handle(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            self._connections.discard(connection)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        request_line = (await reader.readline()).decode("latin-1").split()
        headers: dict[str, str] = {}
        while (line := await reader.readline()) not in (b"\r\n", b"\n", b""):
            key, _, value = line.decode("latin-1").partition(":")
            headers[key.strip().lower()] = value.strip()
        if len(request_line) < 2:
            return await _respond(writer, 400)
        method, path = request_line[0], request_line[1].split("?")[0]
        if path != "/mcp":
            return await _respond(writer, 404)
        if headers.get("authorization") != f"Bearer {self._token}":
            return await _respond(writer, 401)
        if method != "POST":
            # No server-initiated stream: the client falls back to POST only.
            return await _respond(writer, 405, extra={"Allow": "POST"})
        length = int(headers.get("content-length", "0"))
        if length > MAX_BODY_BYTES:
            return await _respond(writer, 413)
        try:
            message = json.loads(await reader.readexactly(length))
        except ValueError:
            return await _respond(writer, 400)
        if not isinstance(message, dict):
            return await _respond(writer, 400)
        if "id" not in message:
            return await _respond(writer, 202)
        await self._stream_reply(reader, writer, message)

    async def _stream_reply(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        message: dict[str, Any],
    ) -> None:
        extra = {"Content-Type": "text/event-stream", "Cache-Control": "no-cache"}
        if message.get("method") == "initialize":
            extra["Mcp-Session-Id"] = "user-agent"
        await _respond(writer, 200, extra=extra, close=False)
        params = message.get("params") or {}
        progress_token = (params.get("_meta") or {}).get("progressToken")
        answer = asyncio.ensure_future(self._dispatch(message))
        self._calls.add(answer)
        answer.add_done_callback(self._calls.discard)
        hangup = asyncio.ensure_future(_hangup(reader))
        try:
            ticks = 0
            while True:
                done, _ = await asyncio.wait(
                    {answer, hangup},
                    timeout=self._keepalive_sec,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if answer in done:
                    break
                if hangup in done:
                    return
                ticks += 1
                if progress_token is None:
                    writer.write(b": keepalive\n\n")
                else:
                    await _event(
                        writer,
                        {
                            "jsonrpc": "2.0",
                            "method": "notifications/progress",
                            "params": {
                                "progressToken": progress_token,
                                "progress": ticks,
                            },
                        },
                    )
                await writer.drain()
        finally:
            hangup.cancel()
            if not answer.done():
                # The client is gone, or the server is closing: nobody reads
                # the answer, so the call must not outlive the connection.
                answer.cancel()
                await asyncio.wait({answer})
        await _event(writer, {"jsonrpc": "2.0", "id": message["id"], **answer.result()})

    async def _dispatch(self, message: dict[str, Any]) -> dict[str, Any]:
        method = message.get("method")
        params = message.get("params") or {}
        if method == "initialize":
            version = params.get("protocolVersion") or PROTOCOL_VERSION
            return {
                "result": {
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": self._info,
                }
            }
        if method == "ping":
            return {"result": {}}
        if method == "tools/list":
            return {
                "result": {
                    "tools": [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": tool.input_schema,
                        }
                        for tool in self._tools.values()
                    ]
                }
            }
        if method == "tools/call":
            return {"result": await self._call(params)}
        return {"error": {"code": -32601, "message": f"Method not found: {method}"}}

    async def _call(self, params: dict[str, Any]) -> dict[str, Any]:
        tool = self._tools.get(params.get("name", ""))
        if tool is None:
            return _tool_result(f"Unknown tool: {params.get('name')}", error=True)
        try:
            result = await tool.handler(params.get("arguments") or {})
        except Exception as error:  # noqa: BLE001 - every failure goes back to the caller
            return _tool_result(str(error) or type(error).__name__, error=True)
        return {**_tool_result(json.dumps(result)), "structuredContent": result}


def _tool_result(text: str, *, error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": error}


REASONS = {
    200: "OK",
    202: "Accepted",
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    405: "Method Not Allowed",
    413: "Content Too Large",
}


async def _respond(
    writer: asyncio.StreamWriter,
    status: int,
    *,
    extra: dict[str, str] | None = None,
    close: bool = True,
) -> None:
    """Write a status line and headers; with ``close``, an empty body too."""

    lines = [f"HTTP/1.1 {status} {REASONS[status]}", "Connection: close"]
    lines += [f"{key}: {value}" for key, value in (extra or {}).items()]
    if close:
        lines.append("Content-Length: 0")
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
    await writer.drain()


async def _hangup(reader: asyncio.StreamReader) -> None:
    """Return when the client closes the connection.

    The request was one POST with ``Connection: close``, so the client sends
    nothing more; the read ends at EOF or with a reset.
    """

    with contextlib.suppress(ConnectionError):
        while await reader.read(4096):
            pass


async def _event(writer: asyncio.StreamWriter, payload: dict[str, Any]) -> None:
    writer.write(f"event: message\ndata: {json.dumps(payload)}\n\n".encode())
    await writer.drain()
