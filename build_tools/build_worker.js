#!/usr/bin/env node
/* 花木工作室 APK 构建工人（本机常驻）—— 多面板版
 * 架构：各面板收到构建请求 → 写入各自 builds 队列（status=pending）；
 *       本工人每 5s 轮询全部目标 → 认领 → 本地 apktool 改名回编 + 签名 → 上传对应面板 → 标记 done。
 * 依赖：/root/build_tools/{mother_decoded, apktool3.jar, signer.jar, build.keystore}
 * 启动：nohup node /root/build_tools/build_worker.js >> /root/build_tools/worker.log 2>&1 & */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOOLS = '/root/build_tools';
const POLL_MS = 5000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 轮询目标：全部走环境变量；口令为空则用 SSH 密钥认证（不再内置明文密码）
const TARGETS = [
  { name: process.env.BW_TARGET_NAME || 'ne',
    host: process.env.BW_HOST || '127.0.0.1',
    port: Number(process.env.BW_PORT || 60166),
    pass: process.env.BW_SSH_PASS || '' },
];

function mkRemote(t) {
  const auth = t.pass ? `sshpass -p ${JSON.stringify(t.pass)} ` : '';
  const batch = t.pass ? 'no' : 'yes';
  const ssh = `${auth}ssh -p ${t.port} -o StrictHostKeyChecking=accept-new -o BatchMode=${batch} root@${t.host}`;
  const scp = `${auth}scp -P ${t.port} -o StrictHostKeyChecking=accept-new -o BatchMode=${batch}`;
  // 参数 base64 编码传输：彻底规避 shell 引号地狱（JSON 里的引号/括号/单引号）
  const remote = (...args) => {
    const enc = args.map(a => Buffer.from(String(a)).toString('base64')).join(' ');
    return execSync(`${ssh} "node /root/build_tools/buildq.js ${enc}"`, {timeout: 20000}).toString().trim();
  };
  return { t, ssh, scp, remote };
}

function run(cmd, timeout) { return execSync(cmd, {timeout: timeout || 300000, stdio: 'pipe'}).toString(); }

async function buildOne(R, b) {
  const id = String(b.id);
  // 注入防御：id 会被拼进本地 shell 命令（rm -rf ${work} / scp 远端路径），只允许纯数字
  if (!/^\d{1,12}$/.test(id)) { log(`[${R.t.name}] 构建id非法已跳过: ${id.slice(0, 40)}`); return; }
  const work = path.join(TOOLS, `work_${R.t.name}_${id}`);
  const label = String(b.app_label || '花木终端').slice(0, 40);
  /* 日志累积：upd 用 logArr 去重累积，避免每次从 claim 快照展开导致中间进度行互相覆盖丢失 */
  const logArr = [...(b.log || [])];
  const upd = (patch) => {
    if (patch.log) { for (const ln of patch.log) if (!logArr.includes(ln)) logArr.push(ln); patch.log = [...logArr]; }
    try { R.remote('update', id, JSON.stringify(patch)); } catch (e) { log('update-err', String(e).slice(0, 80)); }
  };

  try {
    log(`[${R.t.name}] 开始构建 #${id} "${label}"`);
    // 1. 解压原始母包（免 apktool：加固壳 dex/lib/资源二进制全部原样保留，避免 z.Dl 类丢失崩溃）
    upd({progress: 15, log: [...(b.log || []), '[*] 解压母包（免apktool）...']});
    execSync(`rm -rf ${work} && mkdir -p ${work} && unzip -q -o ${TOOLS}/mother.apk -d ${work}`);

    // 2. 改应用名 —— zip 模式：原地改写 resources.arsc 字符串池（不重建资源表）
    //    仅当新名 ≤ 母包名"雄鹰终端"（4字符/12字节）时安全替换；超长则保持母包名并打日志
    upd({progress: 30, log: [...(b.log || []), `[*] 注入应用名: ${label}`]});
    const ARSC = path.join(work, 'resources.arsc');
    if (fs.existsSync(ARSC) && label && [...label].length <= 4) {
      try {
        const rn = run(`python3 ${TOOLS}/arsc_rename.py ${JSON.stringify(ARSC)} ${JSON.stringify('雄鹰终端')} ${JSON.stringify(label)}`, 30000).trim();
        const m = rn.match(/(\d+)/);
        const ok = m && parseInt(m[1], 10) > 0;
        upd({log: [...(b.log || []), ok ? `[+] 应用名已改为: ${label}` : '[!] 应用名未变更（保持母包名）']});
      } catch (e) {
        upd({log: [...(b.log || []), '[!] 应用名替换失败: ' + String(e).slice(0, 80)]});
      }
    } else if (label && [...label].length > 4) {
      upd({log: [...(b.log || []), '[!] 应用名超过4字符，zip模式暂不支持（保持母包名）']});
    }

    // 2b. 注入服务器地址 + 归属账户（构建表单 server_url / bind_user -> assets/server_config.json）
    //     bind_user 随 APK 出厂，设备首次注册时由 agent 上报，服务端据此落 owner_id
    const sUrl = String(b.server_url || "").trim();
    const bindOwner = String(b.bind_user || "").trim();
    if (/^https?:\/\//.test(sUrl) || bindOwner) {
      const scf = path.join(work, "assets/server_config.json");
      if (fs.existsSync(scf)) {
        const sc = JSON.parse(fs.readFileSync(scf, "utf8"));
        if (/^https?:\/\//.test(sUrl)) { sc.serverUrl = sUrl; sc.serverAddr = sUrl; }
        if (bindOwner) { sc.bindOwner = bindOwner; sc.bindUser = bindOwner; sc.buildId = String(b.id || ""); }
        fs.writeFileSync(scf, JSON.stringify(sc));
        const _lg = [...(b.log || [])];
        if (/^https?:\/\//.test(sUrl)) _lg.push("[*] 注入服务器: " + sUrl);
        if (bindOwner) _lg.push("[*] 绑定账户: " + bindOwner);
        upd({progress: 40, log: _lg});
      }
    }

    // 2c. 图标替换: 面板上传图标 → 覆盖各密度 mipmap test/test_round 位图 + 删 anydpi adaptive xml。
    //     面板 "B包图标" 入口选图进 icon_b（"A包图标" 入口进 icon）— 两字段任一有值都替换，
    //     否则桌面图标恒为母包默认。
    const iconUrl = String(b.icon || b.icon_b || '').trim();
    if (/^\/m\/assets\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(iconUrl) && !iconUrl.includes('..')) {
      try {
        const remoteFile = '/root/xyzcs_front' + iconUrl.replace('/m/assets/', '/uploads/');
        const localIcon = path.join(work, 'user_icon.png');
        execSync(`${R.scp} root@${R.t.host}:${remoteFile} ${localIcon}`, {timeout: 60000});
        const head = fs.readFileSync(localIcon).subarray(0, 8);
        if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
          let n = 0;
          for (const d of fs.readdirSync(path.join(work, 'res'))) {
            if (!/^mipmap-/.test(d)) continue;
            const dir = path.join(work, 'res', d);
            for (const f of fs.readdirSync(dir)) {
              const fp = path.join(dir, f);
              if (d === 'mipmap-anydpi-v26' && /^test(_round)?\.xml$/.test(f)) { fs.unlinkSync(fp); n++; continue; }
              if (/^test(_round)?\.png$/.test(f)) { fs.copyFileSync(localIcon, fp); n++; }
            }
          }
          if (n > 0) upd({progress: 45, log: [...(b.log || []), `[*] 图标已替换（${n} 处，A包桌面图标）`]});
        } else {
          upd({log: [...(b.log || []), '[!] 上传图标不是有效 PNG，跳过替换']});
        }
      } catch (e) {
        log(`[${R.t.name}] #${id} 图标拉取/替换失败:`, String(e).slice(0, 100));
        upd({log: [...(b.log || []), '[!] 图标替换失败：图标文件不存在或拉取失败（可能已被删除），本次跳过']});
      }
    }

    // 2d. 加载背景替换: 面板 "背景" 图 (background_b = /m/assets/background/<name>)
    //     → 覆盖 assets/app_loading_bg.png (agent 启动加载页背景, 母包默认 1024x1536)。
    const bgUrl = String(b.background_b || '').trim();
    if (/^\/m\/assets\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bgUrl) && !bgUrl.includes('..')) {
      try {
        const remoteBg = '/root/xyzcs_front' + bgUrl.replace('/m/assets/', '/uploads/');
        const localBg = path.join(work, 'user_bg.png');
        execSync(`${R.scp} root@${R.t.host}:${remoteBg} ${localBg}`, {timeout: 60000});
        const bgHead = fs.readFileSync(localBg).subarray(0, 12);
        // 图片魔数: PNG / JPG / WEBP (app_loading_bg 由 agent 运行时 BitmapFactory 解码, 扩展名无关)
        const isPng = bgHead.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isJpg = bgHead[0] === 0xff && bgHead[1] === 0xd8 && bgHead[2] === 0xff;
        const isWebp = bgHead.subarray(0, 4).toString() === 'RIFF' && bgHead.subarray(8, 12).toString() === 'WEBP';
        if (isPng || isJpg || isWebp) {
          fs.copyFileSync(localBg, path.join(work, 'assets/app_loading_bg.png'));
          upd({progress: 46, log: [...(b.log || []), '[*] 加载背景已替换（app_loading_bg）']});
        } else {
          upd({log: [...(b.log || []), '[!] 背景图不是有效图片（PNG/JPG/WEBP），跳过替换']});
        }
      } catch (e) {
        log(`[${R.t.name}] #${id} 背景拉取/替换失败:`, String(e).slice(0, 100));
        upd({log: [...(b.log || []), '[!] 背景替换失败：背景文件不存在或拉取失败（可能已被删除），本次跳过']});
      }
    }

    // 3. 重打包（免 apktool：resources.arsc 不压缩 STORED，其余 DEFLATED）
    upd({progress: 50, log: [...(b.log || []), '[*] 重打包 APK...']});
    const unsigned = path.join(work, 'unsigned.apk');
    run(`python3 ${TOOLS}/repack.py ${work} ${unsigned}`, 300000);

    // 4. 签名（v1+v2+v3，本地构建密钥）
    upd({progress: 75, log: [...(b.log || []), '[*] 签名中...']});
    const KS_ALIAS = process.env.BW_KS_ALIAS || 'teeed';
    const KS_PASS = process.env.BW_KS_PASS || '';
    if (!KS_PASS || KS_PASS.startsWith('__')) throw new Error('BW_KS_PASS 未配置：请用 keytool 重建 keystore 后把口令写入 .env');
    run(`cd ${work} && java -jar ${TOOLS}/signer.jar -a unsigned.apk --ks ${TOOLS}/build.keystore --ksAlias ${JSON.stringify(KS_ALIAS)} --ksPass ${JSON.stringify(KS_PASS)} --ksKeyPass ${JSON.stringify(KS_PASS)} -o ${work}`, 120000);
    const signed = path.join(work, 'unsigned-aligned-signed.apk');
    if (!fs.existsSync(signed)) throw new Error('签名产物未生成');

    // 5. 上传到对应面板
    upd({progress: 90, log: [...(b.log || []), '[*] 上传产物...']});
    const remoteName = `build_${id}.apk`;
    execSync(`${R.scp} ${signed} root@${R.t.host}:${R.t.uploadsPath || '/root/xyzcs_front/uploads/'}${remoteName}`, {timeout: 300000});
    const size = fs.statSync(signed).size;

    // 6. 标记完成
    upd({status: 'done', progress: 100, apk_size: size, apk_url: `/m/build/${id}/download`,
         log: [...(b.log || []), `[+] 构建完成: ${label}.apk (${(size / 1048576).toFixed(1)}MB) — 真实可安装 APK`],
         finished_at: new Date().toISOString().slice(0, 19) + 'Z'});
    log(`[${R.t.name}] #${id} 完成 (${(size / 1048576).toFixed(1)}MB)`);
  } catch (e) {
    log(`[${R.t.name}] #${id} 失败:`, String(e).slice(0, 200));
    upd({status: 'error', log: [...(b.log || []), `[!] 构建失败: ${String(e).slice(0, 200)}`]});
  } finally {
    try { execSync(`rm -rf ${work}`); } catch (e) {}
  }
}

async function main() {
  // 单实例锁：防止重复启动造成多工人抢单
  const pidFile = path.join(TOOLS, 'worker.pid');
  try {
    const old = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (old && old !== process.pid) { try { process.kill(old, 0); console.log(`已有工人运行 PID=${old}，本实例退出`); process.exit(0); } catch (e) {} }
  } catch (e) {}
  fs.writeFileSync(pidFile, String(process.pid));
  process.on('exit', () => { try { if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile); } catch (e) {} });
  const RS = TARGETS.map(mkRemote);
  log('构建工人启动（多面板: ' + RS.map(R => R.t.name).join('+') + '）PID=' + process.pid);
  // 启动恢复：把上次中断遗留的 building 任务回队重跑
  for (const R of RS) {
    try { const n = R.remote('reset-building'); if (n !== '0') log(`[${R.t.name}] 恢复 ${n} 个中断构建回队`); } catch (e) {}
  }
  let busy = false;
  let pollN = 0;
  setInterval(async () => {
    if (busy) return;
    for (const R of RS) {
      try {
        const pending = JSON.parse(R.remote('list-pending') || '[]');
        if (++pollN % 12 === 0) log(`心跳: ${RS.map(X => `${X.t.name}=${(function(){try{return JSON.parse(X.remote('list-pending')||'[]').length}catch(e){return '?'}})()}`).join(' ')} 个任务（第 ${pollN} 轮）`);
        if (!pending.length) continue;
        const job = JSON.parse(R.remote('claim', String(pending[0].id)) || 'null');
        if (!job) continue;
        busy = true;
        await buildOne(R, job);
        busy = false;
        return; // 构建完回到外层重新轮询，优先处理最早入队的任务
      } catch (e) {
        if (busy) busy = false;
        log(`[${R.t.name}] poll-err`, String(e).slice(0, 120));
      }
    }
  }, POLL_MS);
}
main();
