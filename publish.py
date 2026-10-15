import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

EXPECTED = {"Mc5mr-Equicord-Installer.exe", "Mc5mr-Equicord-Installer.exe.sha256", "desktop.asar", "desktop.sha256"}


def prepare(manifest, archive):
    if not re.fullmatch(r"equicord-v[1-9][0-9]*-[1-9][0-9]*", manifest["tag_name"]):
        raise ValueError("Invalid release version")
    if hashlib.sha256(archive).hexdigest() != manifest["archive_sha256"]:
        raise ValueError("Archive checksum mismatch")
    assets = {asset["name"]: asset for asset in manifest["assets"]}
    if set(assets) != EXPECTED or len(manifest["assets"]) != len(EXPECTED):
        raise ValueError("Unexpected release assets")
    result = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        for entry in source.infolist():
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Unsafe archive entry")
            if entry.is_dir():
                continue
            if path.name not in EXPECTED or path.name in result:
                raise ValueError("Unexpected or duplicate archive file")
            asset = assets[path.name]
            if entry.file_size != asset["size"] or not 0 < entry.file_size <= 128 * 1024 * 1024:
                raise ValueError("Invalid asset size")
            data = source.read(entry)
            if hashlib.sha256(data).hexdigest() != asset["sha256"]:
                raise ValueError("Asset checksum mismatch")
            result[path.name] = data
    if set(result) != EXPECTED:
        raise ValueError("Incomplete release archive")
    for filename, checksum in [("desktop.asar", "desktop.sha256"), ("Mc5mr-Equicord-Installer.exe", "Mc5mr-Equicord-Installer.exe.sha256")]:
        if result[checksum].decode("ascii").strip() != hashlib.sha256(result[filename]).hexdigest():
            raise ValueError("Published checksum file mismatch")
    return result


def read_parts(manifest):
    tag = manifest["tag_name"]
    if not re.fullmatch(r"equicord-v[1-9][0-9]*-[1-9][0-9]*", tag):
        raise ValueError("Invalid release version")
    parts = manifest["archive_parts"]
    if not isinstance(parts, list) or not 1 <= len(parts) <= 32:
        raise ValueError("Invalid compiled archive parts")
    result = []
    total = 0
    for index, part in enumerate(parts):
        expected_path = f"release-parts/{tag}/part-{index:03}.bin"
        if part["path"] != expected_path or not 0 < part["size"] <= 2 * 1024 * 1024:
            raise ValueError("Invalid compiled archive part")
        path = Path(expected_path)
        if path.is_symlink() or not path.is_file() or path.stat().st_size != part["size"]:
            raise ValueError("Compiled archive part is missing or changed")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != part["sha256"]:
            raise ValueError("Compiled archive part checksum mismatch")
        total += len(data)
        if total > 64 * 1024 * 1024:
            raise ValueError("Archive exceeds size limit")
        result.append(data)
    return b"".join(result)


if __name__ == "__main__":
    manifest = json.loads(Path("equicord-release.json").read_text())
    files = prepare(manifest, read_parts(manifest))
    output = Path("release-files")
    output.mkdir(exist_ok=True)
    for name, content in files.items():
        (output / name).write_bytes(content)
    Path("latest.json").write_text(json.dumps({"tag_name": manifest["tag_name"], "draft": False, "prerelease": False, "assets": [{"name": a["name"], "size": a["size"], "sha256": a["sha256"]} for a in manifest["assets"]]}, indent=2) + "\n")
