"""NetEase Cloud Music, served to WestPlay over the loopback.

The package the app talks to: `api` makes the service's calls, `crypto` speaks its `weapi`, `server`
is the HTTP face, and `__main__` runs it.
"""

__all__ = ["api", "crypto", "server"]
