#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实验：免 apktool 方案 —— 直接解压 mother.apk，改 assets/server_config.json，重打包（arsc STORED）"""
import zipfile, json, os, shutil, sys

BASE = r'C:\Users\29124\Desktop\雄鹰 V2\雄鹰v2\huamu\build_tools'
SRC = os.path.join(BASE, 'mother.apk')
WORK = os.path.join(BASE, 'exp_zip_work')
DST = os.path.join(BASE, 'exp_zip_unsigned.apk')
NEW_URL = 'https://jinc.beer'

def main():
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK)

    # 1. 解压（二进制原样）
    with zipfile.ZipFile(SRC) as z:
        z.extractall(WORK)
    print('[1] 解压完成', len(os.listdir(WORK)), '顶层条目')

    # 2. 改 assets/server_config.json
    scf = os.path.join(WORK, 'assets', 'server_config.json')
    with open(scf, 'r', encoding='utf-8') as f:
        sc = json.load(f)
    sc['serverUrl'] = NEW_URL
    sc['serverAddr'] = NEW_URL
    with open(scf, 'w', encoding='utf-8') as f:
        json.dump(sc, f, ensure_ascii=False, indent=2)
    print('[2] server_config.json ->', json.dumps(sc, ensure_ascii=False))

    # 3. 重打包：resources.arsc 不压缩(STORED)，其余 DEFLATED
    if os.path.exists(DST):
        os.remove(DST)
    n_stored = 0
    with zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(WORK):
            for f in files:
                fp = os.path.join(root, f)
                arc = os.path.relpath(fp, WORK).replace('\\', '/')
                if arc == 'resources.arsc':
                    z.write(fp, arc, compress_type=zipfile.ZIP_STORED)
                    n_stored += 1
                else:
                    z.write(fp, arc, compress_type=zipfile.ZIP_DEFLATED)
    print('[3] 重打包完成 ->', DST, os.path.getsize(DST), 'bytes; arsc STORED x', n_stored)

    # 4. 校验关键文件二进制一致性
    with zipfile.ZipFile(SRC) as z1, zipfile.ZipFile(DST) as z2:
        for probe in ['classes.dex', 'classes2.dex', 'assets/libdxs.so', 'assets/0.bt', 'AndroidManifest.xml', 'resources.arsc']:
            a = z1.read(probe)
            b = z2.read(probe)
            print('[4]', probe, '一致' if a == b else '!!!不一致')

if __name__ == '__main__':
    main()
