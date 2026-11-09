"""Tests for accounts.py on a temporary copy of the layout (never touches the real Secrets or channels.json).
Run: Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\test_accounts.py"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import accounts  # noqa: E402

FAKE = {"installed": {"client_id": "1234567890-abcdefghijklmnop.apps.googleusercontent.com", "project_id": "test-proj",
                      "client_secret": "GOCSPX" + "-FAKEFAKEFAKEFAKEFAKE1234", "redirect_uris": ["http://localhost"]}}


class AccountsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        t = self.tmp
        os.makedirs(os.path.join(t, "Secrets", "vault"))
        os.makedirs(os.path.join(t, "Data", "dashboard"))
        self.saved = {k: getattr(accounts, k) for k in ("ROOT", "SECRETS", "CHANNELS_JSON", "CHANNEL_IDS", "AUDIT",
                                                        "REMOVED_JSON", "REMOVED_DIR")}
        accounts.ROOT = t
        accounts.SECRETS = os.path.join(t, "Secrets")
        accounts.CHANNELS_JSON = os.path.join(t, "channels.json")
        accounts.CHANNEL_IDS = os.path.join(t, "Data", "dashboard", "channel_ids.json")
        accounts.AUDIT = os.path.join(t, "Data", "dashboard", "audit.jsonl")
        accounts.REMOVED_JSON = os.path.join(t, "Data", "dashboard", "removed.json")
        accounts.REMOVED_DIR = os.path.join(t, "Secrets", "_removed")
        with open(accounts.CHANNELS_JSON, "w") as f:
            json.dump({"old": {"title": "Old", "client_secret": "client_secret_x.json", "token": "token_old.json"}}, f)

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(accounts, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_parse_rejects(self):
        for bad in ("nope", "[]", json.dumps({"type": "service_account"}), json.dumps({"installed": {"client_id": "x"}})):
            with self.assertRaises(accounts.AccountError):
                accounts.parse_client_json(bad)

    def test_add_info_masked_and_remove(self):
        key = accounts.add_channel("Dapur Santai", client_json=json.dumps(FAKE), language="id", slot_utc_hour=12)
        self.assertEqual(key, "dapursantai")
        cfg = accounts.load_channels()
        self.assertTrue(cfg[key]["pending"])
        self.assertEqual(list(cfg)[0], "old")  # order kept
        info = accounts.client_info(cfg[key]["client_secret"])
        blob = json.dumps({k: v for k, v in info.items() if k != "file"})  # file name = Google default, holds the public client id
        self.assertNotIn(FAKE["installed"]["client_secret"], blob)
        self.assertNotIn(FAKE["installed"]["client_id"], blob)
        self.assertEqual(info["project_id"], "test-proj")
        with self.assertRaises(accounts.AccountError):
            accounts.add_channel("Dapur Santai", client_file=cfg[key]["client_secret"])
        r = accounts.reveal(key, cfg[key], "client_secret")
        self.assertEqual(r["value"], FAKE["installed"]["client_secret"])
        self.assertEqual(accounts.audit_log(key)[0]["action"], "reveal_client_secret")
        accounts.finish_pending(key, "UCabc")
        self.assertNotIn("pending", accounts.load_channels()[key])
        res = accounts.remove_channel(key)
        self.assertNotIn(key, accounts.load_channels())
        self.assertIn(cfg[key]["client_secret"], res["moved"])  # only user of that client -> archived
        self.assertFalse(os.path.exists(os.path.join(accounts.SECRETS, cfg[key]["client_secret"])))
        self.assertNotIn(key, accounts.channel_ids())
        with open(accounts.REMOVED_JSON) as f:
            self.assertIn(key, json.load(f))

    def test_shared_client_kept_on_remove(self):
        a = accounts.add_channel("Satu", client_json=json.dumps(FAKE))
        name = accounts.load_channels()[a]["client_secret"]
        b = accounts.add_channel("Dua", client_file=name)
        res = accounts.remove_channel(b)
        self.assertNotIn(name, res["moved"])
        self.assertTrue(os.path.exists(os.path.join(accounts.SECRETS, name)))

    def test_api_key(self):
        with self.assertRaises(accounts.AccountError):
            accounts.set_api_key("old", "not-a-key")
        k = "AIza" + "B" * 35
        out = accounts.set_api_key("old", k)
        self.assertNotIn(k, json.dumps(out))
        self.assertEqual(accounts.get_api_key("old"), k)
        self.assertNotIn(k, open(accounts.apikey_path("old"), "rb").read().decode("latin1"))  # encrypted on disk
        self.assertNotIn(k, open(accounts.AUDIT).read())
        accounts.remove_api_key("old")
        self.assertIsNone(accounts.get_api_key("old"))

    def test_bad_names(self):
        for t in ("", "a", "!!!", "x" * 61):
            with self.assertRaises(accounts.AccountError):
                accounts.add_channel(t, client_json=json.dumps(FAKE))
        with self.assertRaises(accounts.AccountError):
            accounts._client_path("../evil.json")

    def test_add_without_client_then_downloads(self):
        key = accounts.add_channel("Tanpa Json")
        self.assertIsNone(accounts.load_channels()[key]["client_secret"])
        self.assertTrue(accounts.load_channels()[key]["pending"])
        d = os.path.join(self.tmp, "dl")
        os.makedirs(d)
        old = accounts.downloads_dir
        accounts.downloads_dir = lambda: d
        try:
            with open(os.path.join(d, "client_secret_x (2).json"), "w") as f:
                json.dump(FAKE, f)
            files = accounts.find_downloads()["files"]
            self.assertTrue(files[0]["valid"])
            self.assertNotIn(FAKE["installed"]["client_secret"], json.dumps(files))
            with self.assertRaises(accounts.AccountError):
                accounts.take_download("../client_secret_x.json")
        finally:
            accounts.downloads_dir = old
        accounts.remove_channel(key)


if __name__ == "__main__":
    unittest.main(verbosity=1)
