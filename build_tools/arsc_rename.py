#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ARSC 字符串池原地替换：resources.arsc 里把 old 字符串替换为 new（仅当 new 编码字节数 <= old 时安全，不改变池布局）
用法: python3 arsc_rename.py <resources.arsc> <old> <new>
"""
import sys, struct

def patch_arsc(path, old, new):
    data = bytearray(open(path, 'rb').read())
    pos = 12  # 跳过 ResTable_header(type+headerSize+size=8B, packageCount=4B)
    patched = 0
    ob8 = old.encode('utf-8'); nb8 = new.encode('utf-8')
    ob16 = old.encode('utf-16le'); nb16 = new.encode('utf-16le')
    while pos + 8 <= len(data):
        ctype, chead, csize = struct.unpack_from('<HHI', data, pos)
        if csize < 8:
            break
        if ctype == 0x0001:  # RES_STRING_POOL_TYPE
            scount = struct.unpack_from('<I', data, pos + 8)[0]
            flags = struct.unpack_from('<I', data, pos + 16)[0]
            soff = struct.unpack_from('<I', data, pos + 20)[0]
            utf8 = bool(flags & 0x100)
            data_base = pos + soff  # stringsStart 相对 chunk 头 = 字符串数据区
            off_tbl = pos + chead   # 偏移表紧跟在 header 后（headerSize）
            for i in range(scount):
                off = struct.unpack_from('<I', data, off_tbl + i * 4)[0]
                sp = data_base + off
                if sp >= len(data):
                    continue
                if utf8:
                    # 格式: [chars_len u8/u16][bytes_len u8/u16][utf8 data]
                    b = data[sp]
                    if b & 0x80:
                        nchars = (b & 0x7f) | (data[sp + 1] << 7); cp = sp + 2
                    else:
                        nchars = b; cp = sp + 1
                    b2 = data[cp]
                    if b2 & 0x80:
                        nbytes = (b2 & 0x7f) | (data[cp + 1] << 7); d0 = cp + 2
                    else:
                        nbytes = b2; d0 = cp + 1
                    s = bytes(data[d0:d0 + nbytes]).decode('utf-8', 'replace')
                    end = d0 + nbytes
                    if s == old and len(nb8) <= len(ob8) and len(new) <= len(old):
                        # 原地覆写：两处长度字节 + 数据（不足补零，长度字段决定了实际读取）
                        if len(nb8) < 0x80:
                            data[sp] = len(new)
                            data[cp] = len(nb8)
                            data[d0:d0 + len(nb8)] = nb8
                            if d0 + len(nb8) < end:
                                data[d0 + len(nb8):end] = b'\x00' * (end - (d0 + len(nb8)))
                        patched += 1
                else:
                    b = struct.unpack_from('<H', data, sp)[0]
                    if b & 0x8000:
                        nchars = (b & 0x7fff) | (struct.unpack_from('<H', data, sp + 2)[0] << 15); cp = sp + 4
                    else:
                        nchars = b; cp = sp + 2
                    s = data[cp:cp + nchars * 2].decode('utf-16le', 'replace')
                    end = cp + nchars * 2
                    if s == old and len(nb16) <= len(ob16) and len(new) <= len(old):
                        struct.pack_into('<H', data, sp, len(new))
                        data[cp:cp + len(nb16)] = nb16
                        if cp + len(nb16) < end:
                            data[cp + len(nb16):end] = b'\x00' * (end - (cp + len(nb16)))
                        patched += 1
        pos += csize
    open(path, 'wb').write(data)
    return patched

if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('usage: arsc_rename.py <arsc> <old> <new>'); sys.exit(1)
    n = patch_arsc(sys.argv[1], sys.argv[2], sys.argv[3])
    print('patched:', n, 'occurrence(s)')
