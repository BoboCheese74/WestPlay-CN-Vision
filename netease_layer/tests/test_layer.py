"""The layer's own checks, runnable without the game or the network.

    python -m unittest discover -s netease_layer/tests

`AES` is checked against FIPS-197's published vector; the flatter answers against the shapes NetEase
actually returns. The live calls are in `test_live.py`, which needs the network and is skipped unless
`NETEASE_LIVE=1` is set.
"""

import unittest

from netease_layer import api, crypto, server


class CryptoTests(unittest.TestCase):
    def test_aes_matches_the_published_vector(self):
        # FIPS-197 C.1: AES-128, key 000102...0f, plaintext 00112233...ff.
        key = bytes(range(16))
        plain = bytes.fromhex("00112233445566778899aabbccddeeff")
        # CBC over one block with a zero IV is ECB over that block.
        got = crypto.aes_cbc(plain, key, bytes(16))
        self.assertEqual(got[:16].hex(), "69c4e0d86a7b0430d8cdb78070b4c55a")

    def test_the_sbox_is_the_standard_one(self):
        sbox = crypto._sbox()
        self.assertEqual(sbox[0x00], 0x63)
        self.assertEqual(sbox[0x01], 0x7C)
        self.assertEqual(sbox[0x53], 0xED)
        self.assertEqual(sbox[0xFF], 0x16)

    def test_encrypt_gives_a_params_and_a_key_of_the_right_width(self):
        body = crypto.encrypt({"s": "x", "csrf_token": ""})
        self.assertEqual(set(body), {"params", "encSecKey"})
        # 1024-bit modulus: 128 bytes, so 256 hex characters.
        self.assertEqual(len(body["encSecKey"]), 256)
        # Base64 of whole blocks.
        self.assertEqual(len(body["params"]) % 4, 0)

    def test_every_request_uses_a_fresh_secret(self):
        a = crypto.encrypt({"s": "x"})
        b = crypto.encrypt({"s": "x"})
        self.assertNotEqual(a["params"], b["params"], "the secret must differ per call")
        self.assertNotEqual(a["encSecKey"], b["encSecKey"])


class FlattenTests(unittest.TestCase):
    """NetEase's deep JSON, flattened to what the page reads."""

    def test_a_song_flattens_its_artists_and_picture(self):
        raw = {
            "id": 1,
            "name": "A Song",
            "ar": [{"id": 7, "name": "Someone"}],
            "al": {"id": 9, "name": "An Album", "picUrl": "http://p"},
            "dt": 215000,
        }
        song = server._song(raw)
        self.assertEqual(song["name"], "A Song")
        self.assertEqual(song["artists"], ["Someone"])
        self.assertEqual(song["artistIds"], [7])
        self.assertEqual(song["album"], "An Album")
        self.assertEqual(song["duration"], 215000)
        self.assertTrue(song["picture"].startswith("http://p"))

    def test_an_old_style_song_still_flattens(self):
        # The search endpoint answers `artists`/`album` where the detail one answers `ar`/`al`.
        raw = {"id": 2, "name": "Old", "artists": [{"name": "X"}], "album": {"name": "Y"}, "duration": 1000}
        song = server._song(raw)
        self.assertEqual((song["artists"], song["album"], song["duration"]), (["X"], "Y", 1000))

    def test_a_lyric_answer_keeps_both_languages(self):
        got = server._lyric_answer({"lrc": {"lyric": "[00:00]hi"}, "tlyric": {"lyric": "[00:00]你好"}})
        self.assertEqual(got["lrc"], "[00:00]hi")
        self.assertEqual(got["translation"], "[00:00]你好")

    def test_a_missing_translation_is_empty_not_missing(self):
        got = server._lyric_answer({"lrc": {"lyric": "[00:00]hi"}})
        self.assertEqual(got["translation"], "")

    def test_a_url_answer_says_when_there_is_no_right_to_the_song(self):
        got = server._url_answer({"data": [{"url": None, "code": -110}]})
        self.assertEqual(got["url"], "")
        self.assertEqual(got["code"], -110)

    def test_a_toplaylist_carries_its_first_songs(self):
        answer = {"list": [{"id": 3, "name": "Chart", "coverImgUrl": "http://c", "tracks": [{"id": 4, "name": "T"}]}]}
        got = server._toplists_answer(answer)
        self.assertEqual(len(got["toplists"]), 1)
        self.assertEqual(got["toplists"][0]["name"], "Chart")
        self.assertEqual(got["toplists"][0]["tracks"][0]["name"], "T")

    def test_a_guest_account_is_not_signed_in(self):
        got = server._account_answer({"account": None, "profile": None})
        self.assertFalse(got["signedIn"])


class SignInTests(unittest.TestCase):
    """The QR sign-in's four answers, and what the layer makes of them.

    These are the codes NetEase's `/weapi/login/qrcode/client/login` really returns: 800 gone, 801 waiting,
    802 scanned (the phone hasn't confirmed yet), 803 authorized. Reading them shifted by one is what made the
    page say 登录成功 while the layer held no account, so each is pinned here.
    """

    class Reply:
        """A client that answers one canned QR check (and holds a cookie jar, if told to)."""

        def __init__(self, answer: dict, jar: str = "") -> None:
            self.answer = answer
            self.jar = jar

        def sign_in_check(self, _key: str) -> dict:
            return self.answer

        def cookie_for_account(self) -> str:
            return self.jar

    def setUp(self):
        # Each test starts a fresh sign-in and nobody signed in: the layer holds one account at a time, and a
        # previous test's account would otherwise be what these read.
        with server._lock:
            server._signin = None
            server._signin_key = ""
            server._state["cookie"] = ""
            server._state["nickname"] = ""
            server._state["userId"] = 0

    def poll(self, answer: dict, jar: str = "") -> dict:
        return server._signin_poll(self.Reply(answer, jar), "a-key")

    def test_800_is_a_spent_code(self):
        self.assertEqual(self.poll({"code": 800})["state"], "expired")

    def test_801_is_still_waiting(self):
        self.assertEqual(self.poll({"code": 801})["state"], "waiting")

    def test_802_is_scanned_and_not_yet_confirmed(self):
        # The one that used to be taken for success: the phone has scanned, nothing is signed in.
        self.assertEqual(self.poll({"code": 802})["state"], "scanned")

    def test_803_is_the_confirmation_when_it_carries_the_token(self):
        got = self.poll({"code": 803, "cookie": "MUSIC_U=token; __csrf=x"})
        self.assertEqual(got["state"], "confirmed")
        self.assertTrue(server._answer_health()["signedIn"])

    def test_803_with_the_token_only_in_the_session_jar_is_confirmed_too(self):
        # The usual case: the token arrived as `Set-Cookie` and is in the jar, not in the flattened answer.
        got = self.poll({"code": 803}, jar="MUSIC_U=from-jar; __csrf=x")
        self.assertEqual(got["state"], "confirmed")
        self.assertTrue(server._answer_health()["signedIn"])

    def test_803_that_brings_no_token_is_not_reported_as_success(self):
        # Authorized but with no account's token: saying 登录成功 would be a lie, so the code is given up.
        self.assertEqual(self.poll({"code": 803})["state"], "expired")
        self.assertFalse(server._answer_health()["signedIn"])

    def test_a_token_on_any_reply_is_taken_as_the_confirmation(self):
        self.assertEqual(self.poll({"code": 802, "cookie": "MUSIC_U=t"})["state"], "confirmed")

    def test_a_guest_cookie_never_signs_anyone_in(self):
        # Every QR check sets this device cookie; it belongs to nobody.
        self.assertEqual(self.poll({"code": 801, "cookie": "NMTID=device"})["state"], "waiting")
        self.assertFalse(server._account_cookie("NMTID=device"))


class MinePlaylistsTests(unittest.TestCase):
    """The account's playlists: its own, the ones it collected, and 我喜欢的音乐."""

    ANSWER = {
        "playlist": [
            # 我喜欢的音乐: `specialType` 5, the one every account has.
            {"id": 1, "name": "我喜欢的音乐", "creator": {"userId": 42}, "subscribed": False,
             "specialType": 5, "trackCount": 120},
            # The account's own.
            {"id": 2, "name": "Mine", "creator": {"userId": 42}, "subscribed": False, "trackCount": 8},
            # Someone else's, collected.
            {"id": 3, "name": "Theirs", "creator": {"userId": 99}, "subscribed": True, "trackCount": 30},
            # 我喜欢的音乐 with nothing in it: the service still sends it, and it's nothing to open.
            {"id": 4, "name": "我喜欢的音乐", "creator": {"userId": 42}, "specialType": 5,
             "subscribed": False, "trackCount": 0},
        ]
    }

    def test_each_playlist_says_whose_it_is(self):
        got = {each["id"]: each for each in server._mine_playlists(self.ANSWER, 42)["playlists"]}
        self.assertTrue(got[1]["loved"], "我喜欢的音乐 is the loved one")
        self.assertFalse(got[1]["mine"], "and not counted among the ones the account made")
        self.assertTrue(got[2]["mine"])
        self.assertFalse(got[2]["collected"])
        self.assertTrue(got[3]["collected"], "someone else's, collected")
        self.assertFalse(got[3]["mine"])

    def test_an_empty_loved_playlist_is_left_out(self):
        ids = [each["id"] for each in server._mine_playlists(self.ANSWER, 42)["playlists"]]
        self.assertNotIn(4, ids)
        self.assertEqual(len(ids), 3)

    def test_a_guest_has_none_to_name(self):
        self.assertEqual(server._mine_playlists({"playlist": []}, 0)["playlists"], [])


class CookieHeaderTests(unittest.TestCase):
    """What goes in the `Cookie` header: the jar's cookies must be in it, or the QR flow has no session."""

    def test_the_jar_rides_the_header(self):
        # `urllib` sends a request's own `Cookie` header *instead of* the jar's, so the jar has to be written
        # into the header by hand. Missing that made every request a fresh stranger, and the sign-in stateless.
        client = api.Client("")
        with server._lock:
            pass
        # A jar filled the way a reply fills it.
        import http.cookiejar

        cookie = http.cookiejar.Cookie(
            version=0, name="MUSIC_U", value="tok", port=None, port_specified=False, domain="music.163.com",
            domain_specified=True, domain_initial_dot=False, path="/", path_specified=True, secure=False,
            expires=None, discard=True, comment=None, comment_url=None, rest={}, rfc2109=False,
        )
        client.jar.set_cookie(cookie)
        header = client._cookie_header()
        self.assertIn("MUSIC_U=tok", header)
        # And the account's own token is readable back out of the session.
        self.assertIn("MUSIC_U=tok", client.cookie_for_account())

    def test_a_jar_without_the_account_token_reads_as_nobody(self):
        client = api.Client("")
        import http.cookiejar

        cookie = http.cookiejar.Cookie(
            version=0, name="NMTID", value="device", port=None, port_specified=False, domain="music.163.com",
            domain_specified=True, domain_initial_dot=False, path="/", path_specified=True, secure=False,
            expires=None, discard=True, comment=None, comment_url=None, rest={}, rfc2109=False,
        )
        client.jar.set_cookie(cookie)
        self.assertEqual(client.cookie_for_account(), "")


class LikeTests(unittest.TestCase):
    """收藏: a song into 我喜欢的音乐, and taking it back out."""

    def setUp(self):
        with server._lock:
            server._state["cookie"] = ""
            server._state["userId"] = 0
            server._liked["uid"] = 0
            server._liked["ids"] = []

    def test_a_guest_cannot_like_anything(self):
        got = server._set_liked(33894312, True)
        self.assertFalse(got["ok"])
        self.assertEqual(got["reason"], "signed-out")

    def test_liking_without_a_song_is_refused(self):
        self.assertEqual(server._set_liked(0, True)["reason"], "no-song")

    def test_the_kept_list_follows_a_heart(self):
        # The list is the account's own: a like adds it, an unlike takes it out. Read straight from the kept
        # list (asking the route would go to the service for an account's own).
        with server._lock:
            server._liked["uid"] = 42
            server._liked["ids"] = [1, 2]
        server._note_liked(3, True)
        self.assertEqual(server._liked_now(), [1, 2, 3])
        server._note_liked(2, False)
        self.assertEqual(server._liked_now(), [1, 3])
        # Liking one already there doesn't list it twice.
        server._note_liked(3, True)
        self.assertEqual(server._liked_now(), [1, 3])

    def test_forgetting_starts_the_list_over(self):
        with server._lock:
            server._liked["uid"] = 42
            server._liked["ids"] = [1, 2]
        server._forget_liked()
        with server._lock:
            self.assertEqual(server._liked["uid"], 0)
            self.assertEqual(server._liked["ids"], [])


if __name__ == "__main__":
    unittest.main()
