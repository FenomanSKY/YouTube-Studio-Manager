"""python -I Tools/youtube/test_vault.py   (from the project folder, with the Tools/youtube/.venv python)"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vault  # noqa: E402


class VaultTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = vault.path_for(self.dir, "token_x.json")

    def test_path(self):
        self.assertEqual(self.path, os.path.join(self.dir, "vault", "token_x.dpapi"))

    def test_roundtrip_and_keep(self):
        tok = {"refresh_token": "r", "token": "a", "client_id": "c"}
        vault.save(self.path, tok, login_at="2026-11-01T00:00:00+00:00", migrated_from="token_x.json")
        with open(self.path, "rb") as f:
            raw = f.read()
        self.assertTrue(raw.startswith(vault.MAGIC))
        self.assertNotIn(b"refresh_token", raw)  # encrypted, not plain JSON
        rec = vault.load(self.path)
        self.assertEqual(rec["token"], tok)
        self.assertEqual(rec["login_at"], "2026-11-01T00:00:00+00:00")
        rec2 = vault.save(self.path, dict(tok, token="b"), keep=rec)
        self.assertEqual(rec2["login_at"], rec["login_at"])
        self.assertEqual(rec2["migrated_from"], "token_x.json")
        self.assertEqual(vault.load(self.path)["token"]["token"], "b")

    def test_missing(self):
        self.assertIsNone(vault.load(self.path))

    def test_damaged(self):
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, "wb") as f:
            f.write(vault.MAGIC + b"garbage")
        with self.assertRaises(vault.VaultError):
            vault.load(self.path)
        with open(self.path, "wb") as f:
            f.write(b'{"token": {}}')
        with self.assertRaises(vault.VaultError):
            vault.load(self.path)

    def test_wrong_entropy(self):
        blob = vault.protect(b"x")
        old = vault.ENTROPY
        try:
            vault.ENTROPY = b"other"
            with self.assertRaises(vault.VaultError):
                vault.unprotect(blob)
        finally:
            vault.ENTROPY = old


if __name__ == "__main__":
    unittest.main()
