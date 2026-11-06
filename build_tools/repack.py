#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""免 apktool 重打包：把 APK 解压目录重新打成 APK（resources.arsc 强制 STORED 不压缩，其余 DEFLATED）
用法: python3 repack.py <work_dir> <out_apk>
"""
import zipfile, os, sys

def repack(work, out):
    if os.path.exists(out):
        os.remove(out)
    n = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(work):
            for f in files:
                fp = os.path.join(root, f)
                arc = os.path.relpath(fp, work).replace('\\', '/')
                ct = zipfile.ZIP_STORED if arc == 'resources.arsc' else zipfile.ZIP_DEFLATED
                z.write(fp, arc, compress_type=ct)
                if arc == 'resources.arsc':
                    n += 1
    return os.path.getsize(out), n

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('usage: repack.py <work_dir> <out_apk>'); sys.exit(1)
    size, n = repack(sys.argv[1], sys.argv[2])
    print(f'repacked -> {sys.argv[2]} ({size} bytes, arsc STORED x {n})')
