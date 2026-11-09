"""Leak tests for the shareable package built by build_release.py (builds into a temp folder, never into dist\\).
Run: Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\test_release.py

Secrets\\ is only hashed here to prove none of its files ended up in the zip; nothing from it is printed or copied.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_release as br  # noqa: E402


def sha(b):
    return hashlib.sha256(b).hexdigest()


class ReleaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.pkg, cls.zip = br.build(cls.tmp, "YouTubeStudioManager-test")
        with zipfile.ZipFile(cls.zip) as z:
            cls.entries = {n: z.read(n) for n in z.namelist() if not n.endswith("/")}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def rels(self):
        return {n.split("/", 1)[1]: b for n, b in self.entries.items()}

    def test_scan_clean(self):
        markers = br.owner_markers()
        self.assertTrue(markers or not os.path.exists(os.path.join(br.ROOT, "Secrets")), "owner markers are empty")
        self.assertEqual(br.scan_zip(self.zip, markers), [])

    def test_no_file_from_secrets(self):
        names, hashes = set(), set()
        for dirpath, _, files in os.walk(os.path.join(br.ROOT, "Secrets")):
            for fn in files:
                names.add(fn.lower())
                with open(os.path.join(dirpath, fn), "rb") as f:
                    hashes.add(sha(f.read()))
        for rel, data in self.rels().items():
            self.assertNotIn(os.path.basename(rel).lower(), names - {"channels.json"}, rel)
            self.assertNotIn(sha(data), hashes, f"{rel} is identical to a file in Secrets")

    def test_no_owner_folders_or_logs(self):
        for rel in self.rels():
            top = rel.split("/")[0].lower()
            self.assertNotIn(top, {"secrets", "data", "channels"}, rel)
            low = rel.lower()
            for bad in ("channel_ids.json", "audit", "quota.json", "removed_channels", ".dpapi", "__pycache__", ".venv"):
                self.assertNotIn(bad, low, rel)

    def test_expected_files(self):
        r = self.rels()
        for need in ("YouTubeStudioManager.cmd", "README.md", "requirements.txt", "Tools/youtube/channels.json",
                     "Tools/youtube/yt.py", "Tools/youtube/vault.py", "Tools/dashboard/server.py",
                     "Tools/dashboard/static/index.html", "Tools/dashboard/static/logo.svg"):
            self.assertIn(need, r)
        self.assertEqual(json.loads(r["Tools/youtube/channels.json"]), {})
        self.assertIn(b"GNU GENERAL PUBLIC LICENSE", r["LICENSE"])
        self.assertIn(b"Version 3", r["LICENSE"])
        self.assertIn(b"GNU General Public License v3", r["README.md"])
        self.assertIn(b"google-auth-oauthlib", r["requirements.txt"])
        self.assertIn(b"\r\n", r["YouTubeStudioManager.cmd"])

    def test_repo_files_clean(self):
        files = br.repo_files()
        self.assertNotIn("Tools/youtube/channels.json", files)  # user data: created on first run, ignored by git
        self.assertIn(b"GNU GENERAL PUBLIC LICENSE", files["LICENSE"])
        self.assertEqual(br.scan(sorted(files.items()), br.owner_markers(), need_channels=False), [])
        ignore = files[".gitignore"].decode()
        for need in ("Secrets/", "Data/", "Channels/", "Tools/youtube/channels.json", ".venv/", "client_secret*.json"):
            self.assertIn(need, ignore)

    def test_scan_catches_leaks(self):
        fake_secret = b"GOCSPX-" + b"x" * 24
        fake_token = b'{"refresh_token": "' + b"1//0" + b"y" * 30 + b'"}'
        bad = [("Tools/youtube/channels.json", b"{}"), ("Secrets/client.json", b"{}"), ("Data/dashboard/channel_ids.json", b"{}"),
               ("Tools/x.json", fake_secret), ("Tools/t.json", fake_token),
               ("Tools/dashboard/credential_audit.jsonl", b""), ("Tools/a.js", b"const k = 'mychannelkey';")]
        problems = br.scan(bad, {"mychannelkey"})
        for frag in ("Secrets/client.json", "Data/dashboard/channel_ids.json", "Tools/x.json", "Tools/t.json",
                     "credential_audit", "Tools/a.js"):
            self.assertTrue(any(frag in p for p in problems), frag)
        self.assertFalse(any("x" * 24 in p for p in problems), "messages must not contain the secret value")
        self.assertTrue(br.scan([("Tools/youtube/channels.json", b'{"a": {}}')]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
