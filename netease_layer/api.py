"""Talking to NetEase's own web API: the calls the app needs, and nothing else.

Each call is one `weapi` endpoint with its payload encrypted by `crypto`. The service is particular
about the request's identity in two ways found by testing (see `tests/test_live.py`):

  * `Referer` must look like the page the call would come from — a search comes from `/search/`,
    a song's page from `/song/`, and with a bare `/` some endpoints answer an empty body.
  * The account's `MUSIC_U` cookie rides along when there is one; without it the service still
    serves song details, toplists and lyrics, which is enough to start playing.

The account's cookie never leaves this process: the app asks this layer, and the layer remembers the
cookie. That's why the layer is a process of its own — a page can't set a `Cookie` header.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

from . import crypto

BASE = "https://music.163.com"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# What a desktop web client sends before anyone signs in. Without a device id the service is more
# likely to refuse, so these are always sent.
GUEST_COOKIES = {
    "os": "pc",
    "appver": "8.9.75",
    "osver": "Microsoft-Windows-10",
    "channel": "netease",
}

# Endpoints that refuse a bare referer, and the page a browser would have called them from.
REFERERS = {
    "/weapi/search/get": "https://music.163.com/search/",
    "/weapi/cloudsearch/pc": "https://music.163.com/search/",
    "/weapi/cloudsearch/get/web": "https://music.163.com/search/",
    "/weapi/song/lyric": "https://music.163.com/song/",
}


class NeteaseError(Exception):
    """The service refused a call, or answered something that isn't JSON."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


class Client:
    """One account's calls. `cookie` is `MUSIC_U=...` and friends, or empty for a guest."""

    def __init__(self, cookie: str = "") -> None:
        self.cookie = cookie
        # A browser's own memory for a sign-in: every cookie the service sets, kept for the next call. The QR
        # flow spans several requests (ask for a key, then check it), and the account's token only reaches the
        # layer if the session that asked for the key is the one that hears the confirmation.
        import http.cookiejar

        self.jar = http.cookiejar.CookieJar()

    # --- the transport -------------------------------------------------------------------------

    def _cookie_header(self) -> str:
        """The request's `Cookie`: the guest bits, the account's own, then what this session collected.

        The jar has to be spelled out here. `urllib` sends a request's own `Cookie` header *instead of* the
        cookies its `HTTPCookieProcessor` has collected — it does not merge the two — so a jar that was never
        written into this header was never sent at all. That is what made the QR flow stateless: the `NMTID`
        the service hands out with the key, and later the account's token, sat in the jar and went nowhere.

        Later entries win, and the jar is last on purpose: the session's newest cookie (the sign-in's
        `MUSIC_U`, once the phone confirms) is the one the service must see.
        """
        pairs = dict(GUEST_COOKIES)
        for source in (self.cookie, self.jar_cookies()):
            for part in source.split(";"):
                part = part.strip()
                if not part or "=" not in part:
                    continue
                name, value = part.split("=", 1)
                pairs[name.strip()] = value.strip()
        return "; ".join(f"{k}={v}" for k, v in pairs.items())

    def call(self, path: str, payload: dict) -> dict:
        """POST `payload` to `path`, encrypted, and return the answer."""
        answer, _cookies = self.call_with_cookies(path, payload)
        return answer

    def jar_cookies(self) -> str:
        """Everything the jar holds, as a `Cookie` header's text."""
        return "; ".join(f"{c.name}={c.value}" for c in self.jar)

    def cookie_for_account(self) -> str:
        """The account's cookie as this session holds it: the jar's token-bearing entries, or empty.

        The whole point of keeping a jar through the QR flow is to end up with `MUSIC_U` in it. Reading it
        back as a cookie string is what lets the layer remember the account: the jar is this client's memory,
        and the layer's state is the process's.
        """
        kept = {c.name: c.value for c in self.jar}
        if not any(name in kept for name in ("MUSIC_U", "MUSIC_R_U")):
            return ""
        # The token, plus whatever else the session collected that the service expects beside it.
        return "; ".join(f"{name}={value}" for name, value in kept.items() if value != "")

    def call_with_cookies(self, path: str, payload: dict) -> tuple[dict, str]:
        """POST `payload` to `path`, and return the answer with the cookies the reply set.

        The cookies are joined as a `Cookie` header's text (`a=1; b=2`). Only the sign-in needs them: the
        account's credentials arrive that way rather than in the body.
        """
        body = urllib.parse.urlencode(crypto.encrypt(payload)).encode("ascii")
        headers = {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://music.163.com",
            "Referer": REFERERS.get(path, "https://music.163.com/"),
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Cookie": self._cookie_header(),
        }
        request = urllib.request.Request(BASE + path, data=body, headers=headers)
        # Through a jar: whatever the service sets is carried to the next call, as a browser does.
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        try:
            with opener.open(request, timeout=20) as response:
                raw = response.read()
                cookies = self.jar_cookies()
        except urllib.error.HTTPError as error:
            raise NeteaseError(f"{path}: HTTP {error.code}", error.code) from None
        except urllib.error.URLError as error:
            raise NeteaseError(f"{path}: {error.reason}") from None
        if not raw:
            # An empty body is what the service answers when it won't take the request at all.
            raise NeteaseError(f"{path}: the service answered nothing")
        try:
            answer = json.loads(raw)
        except json.JSONDecodeError:
            raise NeteaseError(f"{path}: not JSON") from None
        code = answer.get("code")
        # 200 is served; 200-ish codes carry their own meaning (301 unregistered, 502 wrong password).
        if code not in (200, 301, 502, 800, 801, 802, 803) and code is not None:
            raise NeteaseError(f"{path}: code {code}", code)
        return answer, cookies

    # --- what the app asks for -----------------------------------------------------------------

    def search(self, words: str, kind: int = 1, limit: int = 30, offset: int = 0) -> dict:
        """Search. `kind` 1 songs, 10 albums, 100 artists, 1000 playlists."""
        return self.call(
            "/weapi/search/get",
            {"s": words, "type": kind, "limit": limit, "offset": offset, "csrf_token": ""},
        )

    def song_detail(self, ids: list[int]) -> dict:
        """Several songs at once, with album and artist."""
        listing = json.dumps([{"id": i} for i in ids], separators=(",", ":"))
        return self.call("/weapi/v3/song/detail", {"c": listing, "csrf_token": ""})

    def lyric(self, song_id: int) -> dict:
        """The words: `lrc` is the original, `tlyric` a translation when there is one."""
        return self.call(
            "/weapi/song/lyric",
            {"id": str(song_id), "lv": -1, "tv": -1, "csrf_token": ""},
        )

    def song_url(self, ids: list[int], quality: int = 320000) -> dict:
        """Where the audio is. `quality` in bits per second: 128000, 192000 or 320000."""
        listing = json.dumps(ids, separators=(",", ":"))
        return self.call(
            "/weapi/song/enhance/player/url",
            {"ids": listing, "br": quality, "csrf_token": ""},
        )

    def toplists(self) -> dict:
        """Every chart the service has, with a first page of each one's songs."""
        return self.call("/weapi/toplist/detail", {"csrf_token": ""})

    def playlist(self, playlist_id: int) -> dict:
        return self.call("/weapi/v6/playlist/detail", {"id": str(playlist_id), "n": 1000, "csrf_token": ""})

    def album(self, album_id: int) -> dict:
        return self.call("/weapi/v1/album/" + str(album_id), {"csrf_token": ""})

    def artist_songs(self, artist_id: int, limit: int = 50) -> dict:
        return self.call(
            "/weapi/v1/artist/" + str(artist_id),
            {"ext": True, "private_cloud": True, "top": limit, "csrf_token": ""},
        )

    def recommend_songs(self) -> dict:
        """The daily mix, as the web client shows on its home page."""
        return self.call("/weapi/v1/discovery/recommend/songs", {"csrf_token": ""})

    def recommend_playlists(self) -> dict:
        return self.call("/weapi/personalized/playlist", {"limit": 12, "total": True, "csrf_token": ""})

    def account(self) -> dict:
        """Who is signed in. `account` and `profile` are null for a guest."""
        return self.call("/weapi/w/nuser/account/get", {"csrf_token": ""})

    def user_playlists(self, uid: int, limit: int = 200, offset: int = 0) -> dict:
        """An account's playlists: the ones it made and the ones it collected.

        The answer names each playlist's `subscribed` and `creator.userId`: `subscribed` is the collected
        ones, and `creator.userId == uid` the account's own. `specialType` 5 is 我喜欢的音乐, which the
        service keeps for every account whether or not anything was ever liked.
        """
        return self.call(
            "/weapi/user/playlist",
            {"uid": uid, "limit": limit, "offset": offset, "csrf_token": ""},
        )

    def loved_playlist(self, uid: int) -> int:
        """The id of 我喜欢的音乐 for `uid` (0 when the account has none to name).

        It's a playlist like any other to the service, flagged `specialType` 5, and adding a track to it is
        what 收藏 a song means here.
        """
        for raw in self.user_playlists(uid, 500).get("playlist") or []:
            if isinstance(raw, dict) and raw.get("specialType") == 5:
                return int(raw.get("id") or 0)
        return 0

    def liked_ids(self, uid: int) -> list[int]:
        """Every song 我喜欢的音乐 holds, as ids."""
        loved = self.loved_playlist(uid)
        if not loved:
            return []
        answer = self.playlist(loved)
        playlist = answer.get("playlist") or {}
        return [int(song["id"]) for song in (playlist.get("trackIds") or []) if isinstance(song, dict) and song.get("id")]

    def set_liked(self, uid: int, song_id: int, liked: bool) -> dict:
        """Adds `song_id` to 我喜欢的音乐 (or takes it out), as the app's own heart does.

        The service takes the whole list of ids to add or remove (`trackIds`, a JSON array of strings), and
        `op` says which way. An account with no 我喜欢的音乐 can't be liked into: that's answered, not raised.
        """
        loved = self.loved_playlist(uid)
        if not loved:
            return {"ok": False, "reason": "no-loved-playlist"}
        self.call(
            "/weapi/playlist/manipulate/tracks",
            {
                "op": "add" if liked else "del",
                "pid": str(loved),
                "trackIds": json.dumps([str(song_id)], separators=(",", ":")),
                "imme": "true",
                "csrf_token": "",
            },
        )
        return {"ok": True, "liked": liked}

    def sign_in_cookie(self) -> dict:
        """The QR login's key, and the URL its code encodes.

        Asked on this client's own jar, so the session that hears the confirmation is this one.
        """
        answer = self.call("/weapi/login/qrcode/unikey", {"type": 1, "csrf_token": ""})
        key = answer.get("unikey", "")
        # The service's own QR page; the phone app scans this and confirms.
        return {"key": key, "url": f"https://music.163.com/login?codekey={key}"}

    def sign_in_check(self, key: str) -> dict:
        """Whether the QR has been confirmed, and with it the account's cookie.

        The cookie comes back as `Set-Cookie` headers, not in the body: the answer is
        `{"code":802}` and the account's `MUSIC_U` is on the reply itself. So the cookies are read
        here and handed back inside the answer as `cookie`, which is what the caller wants.
        """
        answer, cookies = self.call_with_cookies(
            "/weapi/login/qrcode/client/login", {"key": key, "type": 1, "csrf_token": ""}
        )
        if cookies:
            answer["cookie"] = cookies
        # 802 is the confirmation: whatever the session collected by now is the account's.
        if answer.get("code") == 802 and self.jar_cookies():
            answer["cookie"] = self.jar_cookies()
        return answer
