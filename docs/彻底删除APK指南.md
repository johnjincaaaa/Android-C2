# APK 彻底删除指南（雄鹰终端等测试包）

适用：Pixel 2 XL（adb 序列号 911KPRW2096598），系统 Android 11，已 root（Magisk）。

目标包：`com.zq.final`（雄鹰终端 v7.4.9）、可类推 `com.xhl.nanchuan`（日南川 v2.2.9）。

原理：普通 "卸载" 只删 APK 与 /data/data，**不清理** dalvik 缓存、外部存储残留、以及已开启的无障碍授权记录 —— 要 "彻底" 必须按下面顺序做。



***

## 第 0 步：确认包名（通用）



```
adb shell pm list packages -3 | grep -iE "zq|nanchuan"
```

有输出即已安装。下面以 `com.zq.final` 为例，替换成实际包名即可。

## 第 1 步：先移除设备管理员权限（最关键！否则卸载会被系统拒绝）

```bash
# 检查是否激活了设备管理员
adb shell dumpsys device_policy | grep -A3 ActiveAdmin
# 若有输出（如 com.zq.final/com.nest.craft.spark.receiver.AdminEventWatcher）→ 必须移除：

# 方式 A（UI，无 root）：设置 → 安全/更多安全设置 → 设备管理应用 → 取消勾选"雄鹰终端"
# 方式 B（root）：改配置文件（改完必须重启才生效）
adb shell su -c "cp /data/system/device_policies.xml /data/system/device_policies.xml.bak"
adb shell su -c "sed -i '/<admin name=\"com.zq.final/,/<\/admin>/d' /data/system/device_policies.xml"
adb reboot && adb wait-for-device
```

> 实测：雄鹰终端注册了 `AdminEventWatcher`（含 wipe-data 权限），普通卸载会被拦截挂起，
> 必须先移除管理员权限并**重启**，`pm uninstall` 才能成功。

## 第 2 步：撤销无障碍服务（必须，否则 app 借无障碍保活 / 自拉起）



```
# 置空无障碍服务列表 + 关闭无障碍总开关
adb shell settings put secure enabled_accessibility_services ""
adb shell settings put secure accessibility_enabled 0
# 验证已清空
adb shell settings get secure enabled_accessibility_services   # 应无输出
```

## 第 3 步：强杀进程 + 清应用数据（防保活拉起）

雄鹰终端带 keepalive 守护（DaemonGuardService / TimedRecoveryWatcher / PkgEventWatcher），

force-stop 后会被自动拉起，必须先清数据再卸载：



```
adb shell am force-stop com.zq.final
adb shell pm clear com.zq.final        # 清除 /data/data 数据 + 停止所有后台
# 再次确认进程不在
adb shell pidof com.zq.final           # 应无输出
```

## 第 4 步：卸载 APK

方式 A（adb，推荐）：



```
adb uninstall com.zq.final             # 普通卸载；有残留再走第 4 步
adb uninstall com.xhl.nanchuan         # 另一个测试包，按需执行
```

方式 B（手机设置）：设置 → 应用 → 雄鹰终端 → 卸载。

卸载后桌面无图标属正常（该包本来就没有 LAUNCHER 图标）。

## 第 5 步：root 残留清理（彻底删除的核心）

卸载通常已删 `/data/app` 与 `/data/data`；以下逐个确认并清理残留：



```
adb shell su -c "ls -d /data/data/com.zq.final /data/user/0/com.zq.final /data/app/*/com.zq.final-* 2>/dev/null"
# 有任何输出则删除：
adb shell su -c "rm -rf /data/data/com.zq.final /data/user/0/com.zq.final /data/app/*/com.zq.final-*"

# dalvik/oat 编译缓存残留
adb shell su -c "find /data/dalvik-cache -iname '*zq.final*' -exec rm -rf {} + 2>/dev/null"
# 残留包扫描（应无输出）
adb shell su -c "find /data -iname '*zq.final*' 2>/dev/null | head"

# 外部存储残留（应用数据/大文件目录）
adb shell su -c "rm -rf /sdcard/Android/data/com.zq.final /sdcard/Android/obb/com.zq.final"
adb shell su -c "find /sdcard -maxdepth 2 -iname '*zq*' 2>/dev/null | head"   # 人工确认后删
```

## 第 6 步：验证彻底删除



```
adb shell pm list packages -3 | grep zq          # 无输出 = 包已卸载
adb shell settings get secure enabled_accessibility_services   # 无输出 = 无障碍授权已清
adb shell su -c "ls /data/data/ | grep zq"       # 无输出 = 数据目录已清
adb shell su -c "find /data/dalvik-cache /sdcard/Android -iname '*zq*' 2>/dev/null | head"   # 无输出
```

四项全空即彻底删除完成。面板上该设备会显示离线（服务器数据库记录保留，不影响其他设备）。



***

## 附：顺带清理服务器 / 本地的 APK 构建产物（可选）



```
# 服务器构建产物
rm -f /root/xyzcs_front/uploads/build_900001.apk

# 本地（Windows PowerShell）
Remove-Item -LiteralPath "C:\Users\29124\Desktop\雄鹰 V2\雄鹰v2\huamu\build_tools\pkgs" -Recurse -Force
```

## 提醒



* 第 4 步涉及 root 删除，删前已用 `ls/find` 先确认路径存在，**不要**直接对不确定路径执行 `rm -rf`。

* 若日后重新装机，装完必须重新开启无障碍服务才会回传（命令见《雄鹰终端数据不回传修复说明.md》）。