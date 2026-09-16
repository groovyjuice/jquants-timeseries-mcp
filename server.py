from __future__ import annotations

"""Compatibility entrypoint for the J-Quants MCP service.

The actual MCP implementation lives in server_actions.py and routes all
J-Quants time-series requests through GitHub Actions.  Keeping this thin
entrypoint lets the existing Render service continue using `python server.py`
without falling back to direct J-Quants API calls from Render.
"""

from server_actions import main, mcp

__all__ = ["mcp", "main"]


if __name__ == "__main__":
    main()
