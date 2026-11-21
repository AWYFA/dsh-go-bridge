/**
 * dsh-go-bridge — 浏览器半侧：设置页里的「dsh-go 桥」。
 *
 * 手写 ModuleLoader bundle，无构建步骤。数据走宿主同进程里的
 * /dsh-go-bridge（loopback-only），不在前端保存 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-go-bridge',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const INFO_URL = (() => {
      try {
        return new URL('dsh-go-bridge', document.baseURI).pathname
      } catch {
        return '/dsh-go-bridge'
      }
    })()

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 },
      header: { display: 'flex', flexDirection: 'column', gap: 4 },
      h1: { margin: 0, fontSize: 18, color: 'var(--dsw-alias-label-primary)' },
      sub: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      title: { fontSize: 14, color: 'var(--dsw-alias-label-primary)' },
      desc: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      status: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        wordBreak: 'break-all',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.5,
      },
      btn: {
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: 12,
      },
      primary: {
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
      },
      steps: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 },
      step: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
    }

    function copyText(text) {
      if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.left = '-1000px'
      document.body.appendChild(el)
      el.select()
      try {
        document.execCommand('copy')
      } finally {
        el.remove()
      }
      return Promise.resolve()
    }

    function SettingsPage() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [reveal, setReveal] = useState(false)
      const [copied, setCopied] = useState(false)

      const load = useCallback(async () => {
        try {
          const res = await fetch(INFO_URL, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const next = await res.json()
          setData(next)
          setError('')
        } catch (err) {
          setError(err?.message ?? String(err))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = window.setInterval(load, 10000)
        return () => window.clearInterval(timer)
      }, [load])

      const onCopy = async () => {
        if (!data?.token) return
        try {
          await copyText(data.token)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch {
          setError('复制失败，请手动选中 token')
        }
      }

      const running = Boolean(data?.ok)
      const starting = Boolean(data?.starting)
      const statusText = loading
        ? '读取中…'
        : error
          ? `读取失败：${error}`
          : running
            ? `运行中 · 127.0.0.1:${data.port}`
            : starting
              ? '正在启动…'
              : '未运行'

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.header },
          h('h1', { style: S.h1 }, 'dsh-go 固定桥'),
          h(
            'div',
            { style: S.sub },
            '给 dsh-go 的 SSH「只连接」模式一个固定本地端口。桌面 DSH 的端口和 token 变化由桥自动跟随，dsh-go 那边不用改。',
          ),
        ),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h(
              'div',
              { style: S.status },
              h('span', {
                style: {
                  ...S.dot,
                  background: running
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-label-secondary)',
                },
              }),
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, statusText),
            ),
            h('button', { type: 'button', style: S.btn, onClick: load, disabled: loading }, '刷新'),
          ),
          data?.upstream
            ? h(
                'div',
                { style: S.rowText },
                h('div', { style: S.desc }, '当前桌面 Web'),
                h('div', { style: S.mono }, data.upstream),
              )
            : null,
          error
            ? h('div', { style: { ...S.desc, color: 'var(--dsw-alias-state-error-primary)' } }, error)
            : null,
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.rowText },
            h('div', { style: S.title }, '登录令牌'),
            h('div', { style: S.desc }, 'dsh-go 里「登录令牌」填这一串；它只对本机桥有效，不会发给桌面 Web。'),
          ),
          h('input', {
            style: S.input,
            readOnly: true,
            value: data?.token ?? '',
            type: reveal ? 'text' : 'password',
            placeholder: running ? '' : '桥启动后生成',
            onFocus: (event) => event.currentTarget.select(),
            'aria-label': 'dsh-go bridge token',
          }),
          h(
            'div',
            { style: S.row },
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', style: S.btn, onClick: () => setReveal((v) => !v) }, reveal ? '隐藏' : '显示'),
              h('button', { type: 'button', style: S.primary, onClick: onCopy, disabled: !data?.token }, copied ? '已复制' : '复制 token'),
            ),
            h('div', { style: S.desc }, '换 token：删掉插件数据目录里的 token.txt，再重启插件。'),
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.rowText },
            h('div', { style: S.title }, '在 dsh-go 里这样填'),
            h('div', { style: S.desc }, '添加 SSH 主机，连接方式选「只连接」，不要选托管启动。'),
          ),
          h(
            'ol',
            { style: S.steps },
            h('li', { style: S.step }, 'SSH 主机：这台电脑的地址、22 端口、你的用户名和密钥/密码。'),
            h('li', { style: S.step }, `远端 DSH 端口：${data?.port ?? 8790}`),
            h('li', { style: S.step }, '登录令牌：上面那串，复制过去。'),
            h('li', { style: S.step }, '连上后聊天和「电脑 DSH 网页版」都应该能打开；网页版白页就先完全关掉再重开。'),
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.rowText },
            h('div', { style: S.title }, '安全'),
            h('div', { style: S.desc }, '桥只监听 127.0.0.1，必须经 SSH 隧道访问，不要把端口暴露到公网。token 等于这台电脑 DSH 的完整访问权，别发到群里或截图里。'),
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-go-bridge',
            order: 46,
            label: () => 'dsh-go 桥',
          },
          (props) => h(SettingsPage, props),
        ),
      )
    }

    return { apply, inject: ['slots'], name: 'dsh-go-bridge' }
  },
})
