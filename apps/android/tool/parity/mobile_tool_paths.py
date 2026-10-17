"""Portable Android/Flutter executable discovery for host-side acceptance tools."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Mapping


def _is_executable(path: Path) -> bool:
    return path.is_file() and (os.name == "nt" or os.access(path, os.X_OK))


def _expand(value: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(value)))


def _explicit_executable(environment: Mapping[str, str], variable: str) -> str | None:
    value = environment.get(variable)
    if not value:
        return None
    candidate = _expand(value)
    if _is_executable(candidate):
        return str(candidate.resolve())
    located = shutil.which(value)
    if located:
        return str(Path(located).resolve())
    raise FileNotFoundError(f"{variable} does not name an executable")


def _adb_names() -> tuple[str, ...]:
    return ("adb.exe", "adb") if os.name == "nt" else ("adb", "adb.exe")


def _adb_in_sdk(sdk: Path) -> Path | None:
    for name in _adb_names():
        candidate = sdk / "platform-tools" / name
        if _is_executable(candidate):
            return candidate
    return None


def _home_android_sdks(home: Path) -> tuple[Path, ...]:
    return (
        home / "Library" / "Android" / "sdk",
        home / "Android" / "Sdk",
        home / "AppData" / "Local" / "Android" / "Sdk",
    )


def resolve_adb() -> str:
    """Resolve adb from PIRC_ADB, Android SDK settings, PATH, or common SDK paths."""
    environment = os.environ
    explicit = _explicit_executable(environment, "PIRC_ADB")
    if explicit:
        return explicit

    for variable in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        sdk_value = environment.get(variable)
        if sdk_value:
            candidate = _adb_in_sdk(_expand(sdk_value))
            if candidate:
                return str(candidate.resolve())

    located = shutil.which("adb")
    if located:
        return str(Path(located).resolve())

    for sdk in _home_android_sdks(Path.home()):
        candidate = _adb_in_sdk(sdk)
        if candidate:
            return str(candidate.resolve())

    raise FileNotFoundError(
        "Could not find adb. Set PIRC_ADB, ANDROID_HOME/ANDROID_SDK_ROOT, or add adb to PATH."
    )


def _flutter_names() -> tuple[str, ...]:
    return ("flutter.bat", "flutter") if os.name == "nt" else ("flutter", "flutter.bat")


def resolve_flutter() -> str:
    """Resolve Flutter from PIRC_FLUTTER, PATH, or common user SDK locations."""
    environment = os.environ
    explicit = _explicit_executable(environment, "PIRC_FLUTTER")
    if explicit:
        return explicit

    located = shutil.which("flutter")
    if located:
        return str(Path(located).resolve())

    home = Path.home()
    candidates = (
        home / "development" / "flutter" / "bin",
        home / "flutter" / "bin",
        home / "fvm" / "default" / "bin",
    )
    for directory in candidates:
        for name in _flutter_names():
            candidate = directory / name
            if _is_executable(candidate):
                return str(candidate.resolve())

    raise FileNotFoundError(
        "Could not find Flutter. Set PIRC_FLUTTER or add flutter to PATH."
    )


def android_sdk_root(
    environment: Mapping[str, str] | None = None,
    adb_path: str | Path | None = None,
) -> Path | None:
    """Return an explicit/common SDK root, deriving it from adb when possible."""
    environment = os.environ if environment is None else environment
    for variable in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = environment.get(variable)
        if value:
            return _expand(value).resolve()

    if adb_path is not None:
        adb = Path(adb_path).expanduser().resolve()
        if adb.parent.name.lower() == "platform-tools":
            return adb.parent.parent

    for sdk in _home_android_sdks(Path.home()):
        if _adb_in_sdk(sdk):
            return sdk.resolve()
    return None


def android_tool_environment(
    base: Mapping[str, str] | None = None,
    adb_path: str | Path | None = None,
) -> dict[str, str]:
    """Copy the environment and supply SDK variables if an SDK root is known."""
    environment = dict(os.environ if base is None else base)
    sdk = android_sdk_root(environment, adb_path)
    if sdk is not None:
        environment.setdefault("ANDROID_HOME", str(sdk))
        environment.setdefault("ANDROID_SDK_ROOT", str(sdk))
    return environment
