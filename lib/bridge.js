// dsh-go 固定端口桥
//
// dsh-go 的「只连接」模式需要的是 DSH Web API：GET /?token= 换 cookie，
// 然后走 /api/remote.mux WebSocket。桌面 App 的 Web 服务本身是这套协议，
// 但它的端口和 token 每次启动都会变。这里起一个固定端口的小代理：
//
//   dsh-go --ssh-tunnel--> 127.0.0.1:<固定端口> --bridge--> 桌面 Web
//
// 对 dsh-go 只暴露一个稳定 token；bridge 自己换成当前桌面 token/cookie，
// 并重写 Host，让桌面 Host fence 接受。

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const COOKIE_NAME = 'dsh-auth-go-bridge'

function ensureToken(file) {
  try {
    if (existsSync(file)) {
      const value = readFileSync(file, 'utf8').trim()
      if (value.length >= 32) return value
    }
  } catch {
    // regenerate below
  }
  const value = randomBytes(32).toString('base64url')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 运行期仍可用，只是重启后 token 会变
  }
  return value
}

function cookieValueFor(token) {
  return createHash('sha256').update(`dsh-go-bridge:${token}`).digest('base64url')
}

function parseCookies(header) {
  const out = new Map()
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return out
}

function setCookieHeader(value) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=31536000',
  ].join('; ')
}

function writeSimple(res, status, body, headers = {}) {
  const bytes = Buffer.from(body)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(bytes)
}

export async function startGoBridge({ ctx, web, log, port = 8790, tokenFile, infoFile }) {
  if (!web || typeof web.getOrigin !== 'function') {
    throw new Error('go-bridge: webServer 不可用')
  }
  const origin = web.getOrigin()
  if (!origin) throw new Error('go-bridge: 桌面 Web origin 为空')
  const upstream = new URL(origin)
  const upstreamHost = upstream.hostname
  const upstreamPort = Number(upstream.port || 80)
  const upstreamAuthority = upstream.host
  const upstreamOrigin = upstream.origin

  // The WebView loads http://127.0.0.1:<forward port>; DSH's HTTP fence checks
  // Origin/Referer against the *desktop* origin, so they must travel upstream
  // as http://127.0.0.1:<desktop port>, not the tunnel's local port.
  function rewriteBrowserHeaders(headers) {
    if (headers.origin) headers.origin = upstreamOrigin
    if (headers.referer) {
      try {
        const ref = new URL(headers.referer)
        headers.referer = upstreamOrigin + ref.pathname + ref.search
      } catch {
        headers.referer = upstreamOrigin + '/'
      }
    }
    return headers
  }

  const bridgeToken = ensureToken(tokenFile)
  const bridgeCookie = cookieValueFor(bridgeToken)

  let upstreamCookie = ''
  let upstreamCookieAt = 0
  let refreshing = null

  const connection = ctx.connection ?? ctx.get?.('connection')

  async function fetchUpstreamCookie() {
    if (!connection || typeof connection.authenticatedUrl !== 'function') {
      throw new Error('go-bridge: connection.authenticatedUrl 不可用')
    }
    const loginUrl = connection.authenticatedUrl(origin)
    const target = new URL(loginUrl)
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            host: upstreamAuthority,
            accept: 'text/html,application/xhtml+xml',
          },
        },
        (res) => {
          const raw = res.headers['set-cookie'] ?? []
          const list = Array.isArray(raw) ? raw : [raw]
          const auth = list.find((item) => /^dsh-auth-[^=]+=/i.test(String(item)))
          res.resume()
          if (res.statusCode !== 303 && res.statusCode !== 302) {
            reject(new Error(`go-bridge: 上游登录返回 HTTP ${res.statusCode}`))
            return
          }
          if (!auth) {
            reject(new Error('go-bridge: 上游登录没有返回 dsh-auth cookie'))
            return
          }
          resolve(String(auth).split(';')[0])
        },
      )
      req.on('error', reject)
      req.setTimeout(10000, () => req.destroy(new Error('go-bridge: 上游登录超时')))
      req.end()
    })
  }

  async function ensureUpstreamCookie(force = false) {
    if (!force && upstreamCookie && Date.now() - upstreamCookieAt < 10 * 60 * 1000) {
      return upstreamCookie
    }
    if (!refreshing) {
      refreshing = fetchUpstreamCookie()
        .then((value) => {
          upstreamCookie = value
          upstreamCookieAt = Date.now()
          return value
        })
        .finally(() => {
          refreshing = null
        })
    }
    return await refreshing
  }

  function authorized(req) {
    return parseCookies(req.headers.cookie).get(COOKIE_NAME) === bridgeCookie
  }

  function login(req, res) {
    let target
    try {
      target = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      writeSimple(res, 400, 'bad request\n')
      return
    }
    if (target.pathname !== '/') {
      writeSimple(res, 401, 'unauthorized\n')
      return
    }
    if (target.searchParams.get('token') !== bridgeToken) {
      writeSimple(res, 401, 'bad token\n')
      return
    }
    res.writeHead(303, {
      location: './',
      'set-cookie': setCookieHeader(bridgeCookie),
      'cache-control': 'no-store',
    })
    res.end()
  }

  function proxyHttp(req, res) {
    const attempt = (authCookie, retried) => {
      const headers = rewriteBrowserHeaders({ ...req.headers })
      delete headers.host
      delete headers.cookie
      headers.host = upstreamAuthority
      headers.cookie = authCookie
      const upstreamReq = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          headers,
        },
        (upstreamRes) => {
          if (
            !retried &&
            (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403)
          ) {
            upstreamRes.resume()
            ensureUpstreamCookie(true)
              .then((next) => attempt(next, true))
              .catch((error) => writeSimple(res, 502, `bridge upstream auth failed: ${error.message}\n`))
            return
          }
          const outHeaders = { ...upstreamRes.headers }
          delete outHeaders['set-cookie']
          delete outHeaders['transfer-encoding']
          res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
          upstreamRes.pipe(res)
        },
      )
      upstreamReq.on('error', (error) => {
        if (!res.headersSent) writeSimple(res, 502, `bridge upstream error: ${error.message}\n`)
        else res.destroy(error)
      })
      req.pipe(upstreamReq)
    }

    ensureUpstreamCookie()
      .then((cookie) => attempt(cookie, false))
      .catch((error) => writeSimple(res, 502, `bridge auth failed: ${error.message}\n`))
  }

  function proxyUpgrade(req, socket, head) {
    if (!authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    ensureUpstreamCookie()
      .then((cookie) => {
        const headers = rewriteBrowserHeaders({ ...req.headers })
        delete headers.host
        delete headers.cookie
        headers.host = upstreamAuthority
        headers.cookie = cookie
        const upstreamReq = http.request({
          host: upstreamHost,
          port: upstreamPort,
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          headers,
        })
        upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
          const lines = ['HTTP/1.1 101 Switching Protocols']
          for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
            lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`)
          }
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          if (upstreamHead?.length) socket.write(upstreamHead)
          if (head?.length) upstreamSocket.write(head)
          upstreamSocket.pipe(socket)
          socket.pipe(upstreamSocket)
          const close = () => {
            try {
              upstreamSocket.destroy()
            } catch {
              // ignore
            }
            try {
              socket.destroy()
            } catch {
              // ignore
            }
          }
          upstreamSocket.on('error', close)
          socket.on('error', close)
          upstreamSocket.on('close', close)
          socket.on('close', close)
        })
        upstreamReq.on('response', (upstreamRes) => {
          const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}`]
          for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
            lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`)
          }
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          upstreamRes.pipe(socket)
        })
        upstreamReq.on('error', () => {
          try {
            socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
          } catch {
            // ignore
          }
          socket.destroy()
        })
        upstreamReq.end()
      })
      .catch((error) => {
        try {
          socket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n`)
        } catch {
          // ignore
        }
        socket.destroy(error)
      })
  }

  const server = http.createServer((req, res) => {
    const pathname = (() => {
      try {
        return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      } catch {
        return '/'
      }
    })()

    if (pathname === '/healthz') {
      writeSimple(res, 200, '{"ok":true,"app":"dsh-go-bridge"}\n', {
        'content-type': 'application/json; charset=utf-8',
      })
      return
    }

    if (pathname === '/' && (req.url ?? '').includes('token=')) {
      login(req, res)
      return
    }

    if (!authorized(req)) {
      writeSimple(res, 401, 'unauthorized\n')
      return
    }

    proxyHttp(req, res)
  })
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head))

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  const info = {
    ok: true,
    port,
    url: `http://127.0.0.1:${port}/`,
    token: bridgeToken,
    upstream: origin,
    at: new Date().toISOString(),
  }
  if (infoFile) {
    try {
      mkdirSync(dirname(infoFile), { recursive: true })
      writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
    } catch {
      // ignore
    }
  }

  return {
    ...info,
    close() {
      try {
        server.close()
      } catch {
        // ignore
      }
    },
  }
}
