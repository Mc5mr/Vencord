import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import urllib.parse
import urllib.request
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


def download(url):
    def allowed(value):
        parsed = urllib.parse.urlsplit(value)
        return parsed.scheme == "https" and parsed.hostname and parsed.hostname.endswith(".oaiusercontent.com") and not parsed.username and not parsed.password and parsed.port in (None, 443)

    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            if not allowed(newurl):
                raise ValueError("Unexpected archive redirect")
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    if not allowed(url):
        raise ValueError("Unexpected archive host")
    with urllib.request.build_opener(Redirect()).open(url, timeout=90) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("Archive exceeds download limit")
    return data


if __name__ == "__main__":
    manifest = json.loads(Path("equicord-release.json").read_text())
    files = prepare(manifest, download(manifest["archive_url"]))
    output = Path("release-files")
    output.mkdir(exist_ok=True)
    for name, content in files.items():
        (output / name).write_bytes(content)
    Path("latest.json").write_text(json.dumps({"tag_name": manifest["tag_name"], "draft": False, "prerelease": False, "assets": [{"name": a["name"], "size": a["size"], "sha256": a["sha256"]} for a in manifest["assets"]]}, indent=2) + "\n")
