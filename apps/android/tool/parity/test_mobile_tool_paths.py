"""Host-side tests for portable Android/Flutter tool discovery."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from mobile_tool_paths import android_tool_environment, resolve_adb, resolve_flutter


class MobileToolPathsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def executable(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755)
        return path

    def environment(self, values, which=None):
        return (
            patch.dict(os.environ, values, clear=True),
            patch("mobile_tool_paths.shutil.which", return_value=which),
            patch("mobile_tool_paths.Path.home", return_value=self.home),
        )

    def test_explicit_overrides_take_precedence(self):
        adb = self.executable(self.root / "custom" / "adb")
        flutter = self.executable(self.root / "custom" / "flutter")
        patches = self.environment({"PIRC_ADB": str(adb), "PIRC_FLUTTER": str(flutter)})
        with patches[0], patches[1], patches[2]:
            self.assertEqual(resolve_adb(), str(adb.resolve()))
            self.assertEqual(resolve_flutter(), str(flutter.resolve()))

    def test_android_home_precedes_path_adb(self):
        sdk_adb = self.executable(self.root / "sdk" / "platform-tools" / "adb")
        path_adb = self.root / "path" / "adb"
        patches = self.environment({"ANDROID_HOME": str(sdk_adb.parents[1])}, str(path_adb))
        with patches[0], patches[1], patches[2]:
            self.assertEqual(resolve_adb(), str(sdk_adb.resolve()))

    def test_path_is_used_when_no_sdk_environment_is_set(self):
        path_adb = self.root / "path" / "adb"
        patches = self.environment({}, str(path_adb))
        with patches[0], patches[1], patches[2]:
            self.assertEqual(resolve_adb(), str(path_adb.resolve()))

    def test_common_macos_sdk_fallback_uses_home(self):
        adb = self.executable(
            self.home / "Library" / "Android" / "sdk" / "platform-tools" / "adb"
        )
        patches = self.environment({})
        with patches[0], patches[1], patches[2]:
            self.assertEqual(resolve_adb(), str(adb.resolve()))

    def test_common_flutter_sdk_fallback_uses_home(self):
        flutter = self.executable(self.home / "development" / "flutter" / "bin" / "flutter")
        patches = self.environment({})
        with patches[0], patches[1], patches[2]:
            self.assertEqual(resolve_flutter(), str(flutter.resolve()))

    def test_android_environment_preserves_jdk_and_derives_sdk_from_adb(self):
        adb = self.executable(self.root / "sdk" / "platform-tools" / "adb")
        env = android_tool_environment({"JAVA_HOME": "/custom/jdk"}, adb_path=adb)
        self.assertEqual(env["ANDROID_HOME"], str(adb.parents[1].resolve()))
        self.assertEqual(env["ANDROID_SDK_ROOT"], str(adb.parents[1].resolve()))
        self.assertEqual(env["JAVA_HOME"], "/custom/jdk")


if __name__ == "__main__":
    unittest.main()
