// Commerce — sell from the site with the product data you already have.
// Products come from a Data table (sku/title/price/stock) or from a content
// type with a price field. Carts live in the browser; checkout is validated
// and priced SERVER-side, orders land in a table your automations can react
// to (commerce.order.created / .paid), stock decrements, and payment is
// pluggable: Stripe Checkout, or manual/invoice for quote-first businesses.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { escapeHtml as eh } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'commerce', name: 'Commerce', version: '0.1.0', builtin: true,
  description: 'Sell things from your site: a basket, a checkout and a list of orders. Takes card payments through Stripe, or lets you invoice.',
  permissions: ['routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'events.emit', 'events.listen', 'net.fetch', 'blocks.register', 'content.read', 'actions.register'],
}

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Commerce', icon: 'cart' })

  ctx.settingsSection({
    key: 'commerce', label: 'Commerce',
    description: 'Where products come from, how money is taken, where orders go.',
    fields: [
      { key: 'source', label: 'Product source', type: 'select', options: [{ value: 'table', label: 'Data table' }, { value: 'concept', label: 'Content type' }], default: 'table', width: 'half' },
      { key: 'table', label: 'Table id (source: table)', type: 'text', default: 'products', width: 'half', help: 'Fields it should have: sku · title · price · stock (optional)' },
      { key: 'concept', label: 'Content type (source: concept)', type: 'text', default: 'product', width: 'half', help: 'Uses fields.price / fields.sku; stock is not tracked' },
      { key: 'currency', label: 'Currency', type: 'select', options: [{ value: 'GBP' }, { value: 'EUR' }, { value: 'USD' }], default: 'GBP', width: 'half' },
      { key: 'provider', label: 'Payment', type: 'select', options: [{ value: 'manual', label: 'Manual / invoice (no card)' }, { value: 'stripe', label: 'Stripe Checkout' }], default: 'manual', width: 'half' },
      { key: 'stripeKey', label: 'Stripe secret key', type: 'text', width: 'half', help: 'sk_live_… or sk_test_… — used server-side only' },
      { key: 'notify', label: 'Notify on new orders (email)', type: 'text', width: 'half' },
      { key: 'successPath', label: 'Thank-you page', type: 'text', default: '/thanks', width: 'half' },
    ],
  })

  const orders = ctx.store.rows('orders')

  async function settings() {
    const site = await ctx.env.site()
    return { source: 'table', table: 'products', concept: 'product', currency: 'GBP', provider: 'manual', successPath: '/thanks', ...(site.plugins?.commerce?.settings || {}) }
  }

  // ---------- the catalogue (server-side truth for prices & stock) ----------

  async function catalogue(): Promise<Map<string, { sku: string; title: string; price: number; stock: number | null; rowId?: string }>> {
    const s = await settings()
    const map = new Map()
    if (s.source === 'concept') {
      const docs = await ctx.content.listDocs(s.concept, { published: true })
      for (const d of docs) {
        const price = Number(d.fields?.price)
        if (!isFinite(price)) continue
        map.set(String(d.fields?.sku || d.slug), { sku: String(d.fields?.sku || d.slug), title: d.title, price, stock: null })
      }
    } else {
      const rows = await ctx.env.secure.rowsList(`data:t:${s.table}`, 2000).catch(() => [])
      for (const r of rows) {
        const price = Number(r.price)
        if (!r.sku || !isFinite(price)) continue
        map.set(String(r.sku), { sku: String(r.sku), title: String(r.title || r.sku), price, stock: r.stock == null || r.stock === '' ? null : Number(r.stock), rowId: r.id })
      }
    }
    return map
  }

  // ---------- public API (mounted at /x/commerce) ----------

  ctx.routes.public(app => {
    // price a cart — the runtime calls this so the page always shows true prices
    app.post('/quote', async c => {
      const { items } = await c.req.json()
      const cat = await catalogue()
      const s = await settings()
      const lines = []
      let total = 0
      for (const it of Array.isArray(items) ? items.slice(0, 50) : []) {
        const p = cat.get(String(it.sku))
        if (!p) continue
        const qty = Math.max(1, Math.min(999, parseInt(it.qty, 10) || 1))
        lines.push({ sku: p.sku, title: p.title, price: p.price, qty, subtotal: +(p.price * qty).toFixed(2), stock: p.stock })
        total += p.price * qty
      }
      return c.json({ lines, total: +total.toFixed(2), currency: s.currency })
    })

    app.post('/checkout', async c => {
      const body = await c.req.json()
      const email = String(body.email || '').toLowerCase().trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'valid email required' }, 400)
      const cat = await catalogue()
      const s = await settings()
      const lines = []
      let total = 0
      for (const it of Array.isArray(body.items) ? body.items.slice(0, 50) : []) {
        const p = cat.get(String(it.sku))
        if (!p) return c.json({ error: `unknown item: ${it.sku}` }, 400)
        const qty = Math.max(1, Math.min(999, parseInt(it.qty, 10) || 1))
        if (p.stock != null && p.stock < qty) return c.json({ error: `only ${p.stock} of "${p.title}" left` }, 409)
        lines.push({ sku: p.sku, title: p.title, price: p.price, qty })
        total += p.price * qty
      }
      if (!lines.length) return c.json({ error: 'the cart is empty' }, 400)
      total = +total.toFixed(2)

      const order = {
        email, name: String(body.name || '').slice(0, 120), company: String(body.company || '').slice(0, 120),
        address: String(body.address || '').slice(0, 600), note: String(body.note || '').slice(0, 500),
        lines, total, currency: s.currency, status: 'new', provider: s.provider, at: Date.now(),
      }
      const orderId = await orders.insert(order)

      // stock down NOW (oversell beats undersell for small shops; failed payments restock via admin)
      if (s.source === 'table') {
        for (const l of lines) {
          const p = cat.get(l.sku)!
          if (p.stock != null && p.rowId) {
            const row = await ctx.env.secure.rowGet(`data:t:${s.table}`, p.rowId).catch(() => null)
            if (row) await ctx.env.secure.rowUpdate(`data:t:${s.table}`, p.rowId, { ...row, stock: p.stock - l.qty }).catch(() => {})
          }
        }
      }

      await ctx.events.emit('order.created', { orderId, email, total, currency: s.currency, lines })
      if (s.notify) {
        await ctx.mail.send({
          to: s.notify, subject: `Order ${orderId.slice(-6)} — ${s.currency} ${total}`,
          text: `${email}${order.company ? ` (${order.company})` : ''}\n\n${lines.map(l => `${l.qty}× ${l.title} — ${l.price}`).join('\n')}\n\nTotal: ${s.currency} ${total}\nStatus: ${s.provider === 'stripe' ? 'awaiting payment' : 'new (manual)'}`,
        }).catch(() => {})
      }

      if (s.provider === 'stripe') {
        if (!s.stripeKey) return c.json({ error: 'Stripe is selected but no key is configured' }, 500)
        const site = await ctx.env.site()
        const params = new URLSearchParams({ mode: 'payment', 'customer_email': email, success_url: `${site.url}${s.successPath}?order=${orderId}`, cancel_url: `${site.url}${body.cancelPath || '/'}` })
        lines.forEach((l, i) => {
          params.set(`line_items[${i}][quantity]`, String(l.qty))
          params.set(`line_items[${i}][price_data][currency]`, s.currency.toLowerCase())
          params.set(`line_items[${i}][price_data][unit_amount]`, String(Math.round(l.price * 100)))
          params.set(`line_items[${i}][price_data][product_data][name]`, l.title)
        })
        params.set('metadata[blockhouse_order]', orderId)
        const r = await ctx.fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST', headers: { authorization: `Bearer ${s.stripeKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: params,
        })
        const session: any = await r.json()
        if (!r.ok) {
          await orders.update(orderId, { ...order, status: 'failed', error: session?.error?.message })
          return c.json({ error: `Stripe: ${session?.error?.message || r.status}` }, 502)
        }
        await orders.update(orderId, { ...order, status: 'awaiting-payment', stripeSession: session.id })
        return c.json({ ok: true, orderId, redirect: session.url })
      }

      return c.json({ ok: true, orderId, message: 'Order received — we will confirm by email.' })
    })

    // Stripe webhook (checkout.session.completed) — set the endpoint to /x/commerce/stripe
    app.post('/stripe', async c => {
      const evt = await c.req.json().catch(() => null)
      if (evt?.type !== 'checkout.session.completed') return c.json({ ok: true, ignored: true })
      const orderId = evt.data?.object?.metadata?.blockhouse_order
      const row = orderId ? await orders.get(orderId) : null
      if (!row) return c.json({ ok: true, ignored: true })
      await orders.update(orderId, { ...row, status: 'paid', paidAt: Date.now() })
      await ctx.events.emit('order.paid', { orderId, email: row.email, total: row.total, currency: row.currency })
      return c.json({ ok: true })
    })
  })

  // ---------- admin API ----------

  ctx.routes.api(app => {
    app.get('/orders', async c => c.json({ orders: await orders.list(300) }))
    app.post('/orders/:id/status', async c => {
      const row = await orders.get(c.req.param('id'))
      if (!row) return c.json({ error: 'not found' }, 404)
      const to = String((await c.req.json()).to || '')
      if (!['new', 'awaiting-payment', 'paid', 'fulfilled', 'cancelled', 'refunded'].includes(to)) return c.json({ error: 'bad status' }, 400)
      await orders.update(row.id, { ...row, status: to })
      if (to === 'paid') await ctx.events.emit('order.paid', { orderId: row.id, email: row.email, total: row.total, currency: row.currency })
      if (to === 'fulfilled') await ctx.events.emit('order.fulfilled', { orderId: row.id, email: row.email })
      return c.json({ ok: true })
    })
    app.get('/summary', async c => {
      const all = await orders.list(1000)
      const paid = all.filter((o: any) => ['paid', 'fulfilled'].includes(o.status))
      return c.json({
        orders: all.length, paid: paid.length,
        revenue: +paid.reduce((t: number, o: any) => t + (o.total || 0), 0).toFixed(2),
        currency: (await settings()).currency,
      })
    })
  })

  // ---------- blocks ----------

  ctx.blocks.register({
    type: 'add-to-cart', label: 'Add to cart', group: 'Commerce', icon: 'cart',
    description: 'A buy button — give it a SKU, or leave blank on a product page to use fields.sku',
    fields: [
      { key: 'sku', type: 'text', label: 'SKU', help: 'Blank = the page’s fields.sku' },
      { key: 'label', type: 'text', label: 'Label', default: 'Add to cart' },
    ],
    render: (c, n) => {
      c.collect.enhancers.add('cart')
      const sku = n.props.sku || c.doc?.fields?.sku || ''
      return `<button class="btn btn-primary wb-addcart" data-blockhouse-enhance="cart" data-add-sku="${eh(sku)}" ${sku ? '' : 'disabled title="No SKU on this page"'}>${eh(n.props.label || 'Add to cart')}</button>`
    },
  })

  ctx.blocks.register({
    type: 'cart', label: 'Cart & checkout', group: 'Commerce', icon: 'cart',
    description: 'The cart page: line items, totals priced by the server, and the checkout form',
    fields: [{ key: 'title', type: 'text', label: 'Title', default: 'Your cart' }],
    render: (_c, n) => { _c.collect.enhancers.add('cart'); return `<div class="wb-cart" data-blockhouse-enhance="cart" data-cart>
      <h2>${eh(n.props.title || 'Your cart')}</h2>
      <div data-cart-lines><p class="cart-note">Your cart is empty.</p></div>
      <form class="cart-checkout wb-form" hidden>
        <h3>Checkout</h3>
        <div class="form-grid">
          <label>Name<input name="name" required></label>
          <label>Email<input type="email" name="email" required></label>
          <label class="span2">Company<input name="company"></label>
          <label class="span2">Delivery address<textarea name="address" rows="2"></textarea></label>
          <label class="span2">Notes<textarea name="note" rows="2"></textarea></label>
        </div>
        <button class="btn btn-primary btn-large" type="submit">Place order</button>
        <p class="cart-status" role="status"></p>
      </form>
    </div>` },
  })

  // automations can push orders onward (CRM, fulfilment, spreadsheets)
  ctx.actions.register({
    id: 'commerce.order.status', label: 'Commerce: set order status',
    fields: [
      { key: 'orderId', type: 'text', label: 'Order id', help: 'Usually {{event.orderId}}' },
      { key: 'to', type: 'select', label: 'Status', options: [{ value: 'paid' }, { value: 'fulfilled' }, { value: 'cancelled' }] },
    ],
    run: async (opts: any) => {
      const row = await orders.get(String(opts.orderId || ''))
      if (!row) throw new Error(`no order ${opts.orderId}`)
      await orders.update(row.id, { ...row, status: opts.to })
      return { ok: true }
    },
  })
}
