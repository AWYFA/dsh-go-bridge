// dsh-go-bridge
//
// Exposes the running DSH desktop Web instance on a stable loopback port so
// dsh-go's SSH "attach only" mode can connect to it without knowing the
// desktop port or its rotating login token.
//
// The bridge authenticates dsh-go with its own stable token, then logs in to
// the desktop Web internally and rewrites Host / Origin / Referer for every
// HTTP and WebSocket request.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { startGoBridge } from './lib/bridge.js'

export const name = 'dsh-go-bridge'

export const inject = ['webServer', 'connection']

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function apply(ctx, config = {}) {
  const web = ctx.webServer ?? ctx.get?.('webServer')
  if (!web || typeof web.getOrigin !== 'function') {
    throw new Error('dsh-go-bridge: webServer 不可用')
  }

  const port = Number(config.port) || 8790
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('dsh-go-bridge: port 必须是 1–65535')
  }

  const dataDir = join(homedir(), '.dsh', 'plugins-data', 'dsh-go-bridge')
  const tokenFile = join(dataDir, 'token.txt')
  const infoFile = join(dataDir, 'bridge.json')
  const log = ctx.logger ?? console
  const say = (level, message) => {
    const fn = log?.[level]
    if (typeof fn === 'function') fn.call(log, message)
    else console.log(message)
  }

  let bridge = null
  let disposed = false

  const offInfo = web.register({
    kind: 'exact',
    path: '/dsh-go-bridge',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '只允许本机访问' })
        return
      }
      if (!bridge) {
        sendJson(res, 200, { ok: false, starting: true })
        return
      }
      sendJson(res, 200, {
        ok: true,
        port: bridge.port,
        url: bridge.url,
        token: bridge.token,
        upstream: bridge.upstream,
        hint: 'dsh-go → SSH 主机 → 只连接 → 远端 DSH 端口填 port → 登录令牌填 token。',
      })
    },
  })

  ctx.effect(() => {
    const start = async () => {
      try {
        bridge = await startGoBridge({
          ctx,
          web,
          log: say,
          port,
          tokenFile,
          infoFile,
        })
        if (disposed) {
          bridge.close()
          bridge = null
          return
        }
        say('info', `dsh-go-bridge: 127.0.0.1:${bridge.port} → ${bridge.upstream}`)
      } catch (error) {
        say('warn', `dsh-go-bridge: 启动失败 ${error?.message ?? error}`)
      }
    }
    void start()
    return () => {
      disposed = true
      try {
        offInfo?.()
      } catch {
        // ignore
      }
      if (bridge) {
        try {
          bridge.close()
        } catch {
          // ignore
        }
        bridge = null
      }
    }
  }, 'dsh-go-bridge')
}
