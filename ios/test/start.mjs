// 橙子音乐 · iOS 测试版启动入口
//
// 作用：在本地起一个与云端正式版同构的服务（静态站点 + /api/* 音源接口），
// 用于每次改动后的更新测试 —— 测试通过后才按工作流推云端。
//
// 测试版直接服务 ../www（正式版的构建产物目录），因此：
//   · 改代码 → node tools/build_web.js --out www --platform ios 后刷新页面即生效（无需重启）；
//   · 正式版推送云端落地后，测试版内容与云端正式版自动一致（同一份 www）。
//
// 启动：  node test/start.mjs          （默认端口 3000）
// 可选：  PORT=3001 node test/start.mjs
// 访问：  电脑  http://localhost:3000
//         手机（同一 Wi-Fi）http://<本机IP>:3000
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WWW = path.join(HERE, '..', 'www')

const child = spawn(process.execPath, [path.join(WWW, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT || '3000' },
})
child.on('exit', (code) => process.exit(code ?? 0))
