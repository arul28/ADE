#!/usr/bin/env python3
"""Keeps the file times of the iOS build inputs the same across CI runs.

Xcode's build system decides what to rebuild by comparing each input's
modification time, to the nanosecond, with the time it recorded in the build
folder. A fresh checkout gives every file a new time, so a restored build
folder alone rebuilds everything. This script records the time and content
hash of every input next to the build folder, and on the next run gives each
input whose content did not change its old time back.

    ios-mtimes.py save    <manifest> <root>...
    ios-mtimes.py restore <manifest> <root>...

A root is a directory (the app sources). Files
and directories under it are recorded; a directory's hash covers the sorted
names of its entries, because a build step that reads a folder also reads
its listing. `.git` folders and symbolic links are skipped.

A changed file keeps its checkout time, which is newer than the recorded
one, so it rebuilds. A missing manifest, a missing root, or a file that
cannot be read changes nothing: the build is then only slower, never wrong.
"""

import hashlib
import os
import sys

SKIP_DIRS = {".git"}


def walk(roots):
    for root in roots:
        if not os.path.isdir(root):
            print(f"ios-mtimes: no directory {root}, skipped", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            entries = sorted(dirnames + filenames)
            yield dirpath, "d" + hashlib.sha1("\0".join(entries).encode()).hexdigest()
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                if os.path.islink(path):
                    continue
                digest = file_hash(path)
                if digest is not None:
                    yield path, "f" + digest


def file_hash(path):
    digest = hashlib.sha1()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def save(manifest, roots):
    count = 0
    tmp = manifest + ".tmp"
    with open(tmp, "w", encoding="utf-8") as out:
        for path, digest in walk(roots):
            try:
                mtime_ns = os.lstat(path).st_mtime_ns
            except OSError:
                continue
            out.write(f"{digest}\t{mtime_ns}\t{path}\n")
            count += 1
    os.replace(tmp, manifest)
    print(f"ios-mtimes: recorded {count} paths in {manifest}")


def restore(manifest, roots):
    try:
        with open(manifest, encoding="utf-8") as handle:
            recorded = {}
            for line in handle:
                digest, mtime_ns, path = line.rstrip("\n").split("\t", 2)
                recorded[path] = (digest, int(mtime_ns))
    except (OSError, ValueError) as error:
        print(f"ios-mtimes: no usable manifest ({error}); every input keeps its checkout time")
        return
    same = changed = new = 0
    for path, digest in walk(roots):
        entry = recorded.get(path)
        if entry is None:
            new += 1
        elif entry[0] != digest:
            changed += 1
        else:
            try:
                os.utime(path, ns=(entry[1], entry[1]), follow_symlinks=False)
                same += 1
            except OSError:
                changed += 1
    print(f"ios-mtimes: restored {same} times; {changed} changed and {new} new paths keep the checkout time")


def main(argv):
    if len(argv) < 4 or argv[1] not in ("save", "restore"):
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: ios-mtimes.py save|restore <manifest> <root>...", file=sys.stderr)
        return 2
    roots = [os.path.abspath(root) for root in argv[3:]]
    (save if argv[1] == "save" else restore)(argv[2], roots)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
