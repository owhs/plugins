// Connector definitions — the contract every integration follows.
//
// A connector declares how it authenticates (oauth2 / apikey / webhook), what
// settings it needs, how to test the connection, and what actions it exposes to
// automations. Adding a new service means adding one object to this file; the
// OAuth dance, token storage/refresh, the admin UI and the automation actions
// all come from the framework.

export type AuthKind = 'oauth2' | 'apikey' | 'webhook' | 'none'

export interface ConnectorAction {
  key: string                     // automation action becomes `<connector>.<key>`
  label: string
  description?: string
  fields: { key: string; label: string; type?: string; help?: string; required?: boolean }[]
  run: (ctx: ConnectorRunCtx, opts: Record<string, any>, payload: Record<string, any>) => Promise<any>
}

export interface ConnectorRunCtx {
  /** authenticated fetch — refreshes OAuth tokens automatically */
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  config: Record<string, any>     // connector settings (client id, base url, …)
  token: Record<string, any>      // stored credentials
  interpolate: (tpl: string, payload: Record<string, any>) => string
  log: (...a: any[]) => void
}

export interface ConnectorDef {
  id: string
  name: string
  description: string
  icon: string
  auth: AuthKind
  docs?: string
  /** admin-configurable settings (client credentials, endpoints) */
  settings: { key: string; label: string; type?: string; help?: string; secret?: boolean; required?: boolean }[]
  oauth?: {
    authUrl: string
    tokenUrl: string
    scopes: string[]
    extraAuthParams?: Record<string, string>
    /** parse an identity label out of the token/userinfo response */
    identify?: (ctx: ConnectorRunCtx) => Promise<string>
  }
  /** quick connectivity check shown in the studio */
  test?: (ctx: ConnectorRunCtx) => Promise<{ ok: boolean; detail: string }>
  actions: ConnectorAction[]
}

const j = async (res: Response) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

// ---------------------------------------------------------------- Google ----

export const google: ConnectorDef = {
  id: 'google',
  name: 'Google (Gmail + Drive)',
  description: 'Send email as your Google account and push files to Drive.',
  icon: 'mail',
  auth: 'oauth2',
  docs: 'Create an OAuth client (Web application) in Google Cloud Console → Credentials, then paste the client id/secret and add the redirect URI shown below.',
  settings: [
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
  ],
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    identify: async ctx => {
      const r = await ctx.fetch('https://www.googleapis.com/oauth2/v2/userinfo')
      const d = await j(r)
      return d.email || 'google account'
    },
  },
  test: async ctx => {
    const r = await ctx.fetch('https://www.googleapis.com/oauth2/v2/userinfo')
    const d = await j(r)
    return r.ok ? { ok: true, detail: `Connected as ${d.email}` } : { ok: false, detail: d.error?.message || `HTTP ${r.status}` }
  },
  actions: [
    {
      key: 'sendEmail',
      label: 'Send email via Gmail',
      description: 'Sends as the connected Google account (RFC-822 over the Gmail API).',
      fields: [
        { key: 'to', label: 'To', required: true, help: 'Supports {data.email}' },
        { key: 'subject', label: 'Subject', required: true },
        { key: 'body', label: 'Body', type: 'textarea' },
      ],
      run: async (ctx, o, payload) => {
        const to = ctx.interpolate(o.to || '', payload)
        const subject = ctx.interpolate(o.subject || '', payload)
        const body = ctx.interpolate(o.body || '', payload)
        const mime = [
          `To: ${to}`,
          `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          body,
        ].join('\r\n')
        const raw = btoa(unescape(encodeURIComponent(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const res = await ctx.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
        })
        const d = await j(res)
        if (!res.ok) throw new Error(d.error?.message || `Gmail ${res.status}`)
        return { id: d.id }
      },
    },
    {
      key: 'driveUpload',
      label: 'Upload a file to Drive',
      description: 'Creates a text/JSON file in a Drive folder — handy for archiving submissions.',
      fields: [
        { key: 'name', label: 'File name', required: true, help: 'e.g. enquiry-{data.name}.json' },
        { key: 'folderId', label: 'Folder ID', help: 'From the Drive folder URL' },
        { key: 'content', label: 'Content', type: 'textarea', help: 'Blank = the whole event payload as JSON' },
        { key: 'mimeType', label: 'MIME type', help: 'default application/json' },
      ],
      run: async (ctx, o, payload) => {
        const name = ctx.interpolate(o.name || 'blockhouse-file.json', payload)
        const content = o.content ? ctx.interpolate(o.content, payload) : JSON.stringify(payload, null, 2)
        const mimeType = o.mimeType || 'application/json'
        const boundary = 'blockhouse' + Math.random().toString(36).slice(2)
        const metadata: any = { name, mimeType }
        if (o.folderId) metadata.parents = [o.folderId]
        const body =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`
        const res = await ctx.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body,
        })
        const d = await j(res)
        if (!res.ok) throw new Error(d.error?.message || `Drive ${res.status}`)
        return { id: d.id, name: d.name }
      },
    },
  ],
}

// ------------------------------------------------------------------ Xero ----

export const xero: ConnectorDef = {
  id: 'xero',
  name: 'Xero',
  description: 'Create contacts and draft invoices from quotes, forms or data rows.',
  icon: 'building',
  auth: 'oauth2',
  docs: 'Create an app at developer.xero.com → My Apps (Web app). Add the redirect URI below, then paste the client id/secret.',
  settings: [
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
    { key: 'tenantId', label: 'Tenant ID', help: 'Filled automatically after connecting' },
  ],
  oauth: {
    authUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scopes: ['offline_access', 'accounting.contacts', 'accounting.transactions', 'openid', 'email'],
    identify: async ctx => {
      const r = await ctx.fetch('https://api.xero.com/connections')
      const d = await j(r)
      return Array.isArray(d) && d[0] ? (d[0].tenantName || d[0].tenantId) : 'xero tenant'
    },
  },
  test: async ctx => {
    const r = await ctx.fetch('https://api.xero.com/connections')
    const d = await j(r)
    return r.ok && Array.isArray(d) && d.length
      ? { ok: true, detail: `Connected to ${d.map((x: any) => x.tenantName).join(', ')}` }
      : { ok: false, detail: d.Detail || d.error || `HTTP ${r.status}` }
  },
  actions: [
    {
      key: 'createContact',
      label: 'Create a Xero contact',
      fields: [
        { key: 'name', label: 'Name', required: true, help: '{data.name}' },
        { key: 'email', label: 'Email', help: '{data.email}' },
      ],
      run: async (ctx, o, payload) => {
        const res = await ctx.fetch('https://api.xero.com/api.xro/2.0/Contacts', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'xero-tenant-id': ctx.config.tenantId || '' },
          body: JSON.stringify({ Contacts: [{ Name: ctx.interpolate(o.name, payload), EmailAddress: ctx.interpolate(o.email || '', payload) }] }),
        })
        const d = await j(res)
        if (!res.ok) throw new Error(d.Detail || d.Message || `Xero ${res.status}`)
        return { contactId: d.Contacts?.[0]?.ContactID }
      },
    },
    {
      key: 'createInvoice',
      label: 'Create a draft invoice',
      description: 'Maps a quote (or any payload with line items) to an ACCREC invoice.',
      fields: [
        { key: 'contactName', label: 'Contact name', required: true },
        { key: 'reference', label: 'Reference', help: '{row.reference}' },
        { key: 'lineItemsPath', label: 'Line items path', help: 'e.g. row.lines (defaults to row.lines)' },
        { key: 'accountCode', label: 'Account code', help: 'e.g. 200' },
      ],
      run: async (ctx, o, payload) => {
        const path = (o.lineItemsPath || 'row.lines').split('.')
        let lines: any = payload
        for (const p of path) lines = lines?.[p]
        const LineItems = (Array.isArray(lines) ? lines : []).map((l: any) => ({
          Description: l.desc || l.description || 'Item',
          Quantity: Number(l.qty ?? 1),
          UnitAmount: Number(l.price ?? l.unit ?? 0),
          AccountCode: o.accountCode || undefined,
        }))
        const res = await ctx.fetch('https://api.xero.com/api.xro/2.0/Invoices', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'xero-tenant-id': ctx.config.tenantId || '' },
          body: JSON.stringify({
            Invoices: [{
              Type: 'ACCREC', Status: 'DRAFT',
              Contact: { Name: ctx.interpolate(o.contactName, payload) },
              Reference: ctx.interpolate(o.reference || '', payload),
              LineItems: LineItems.length ? LineItems : [{ Description: 'Services', Quantity: 1, UnitAmount: 0 }],
            }],
          }),
        })
        const d = await j(res)
        if (!res.ok) throw new Error(d.Detail || d.Message || `Xero ${res.status}`)
        return { invoiceId: d.Invoices?.[0]?.InvoiceID, number: d.Invoices?.[0]?.InvoiceNumber }
      },
    },
  ],
}

// ---------------------------------------------------------------- Zapier ----

export const zapier: ConnectorDef = {
  id: 'zapier',
  name: 'Zapier / Make',
  description: 'Push any site event into a Zap or Make scenario via a catch hook.',
  icon: 'bolt',
  auth: 'webhook',
  docs: 'In Zapier create a "Webhooks by Zapier → Catch Hook" trigger and paste its URL here. Make.com custom webhooks work identically.',
  settings: [{ key: 'hookUrl', label: 'Catch hook URL', required: true, help: 'https://hooks.zapier.com/hooks/catch/…' }],
  test: async ctx => {
    if (!ctx.config.hookUrl) return { ok: false, detail: 'No hook URL set' }
    const r = await ctx.fetch(ctx.config.hookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockhouse: 'test', at: new Date().toISOString() }),
    })
    return r.ok ? { ok: true, detail: 'Test payload delivered' } : { ok: false, detail: `HTTP ${r.status}` }
  },
  actions: [{
    key: 'send',
    label: 'Send to Zapier',
    fields: [{ key: 'payload', label: 'Payload override (JSON)', type: 'json', help: 'Blank = the whole event payload' }],
    run: async (ctx, o, payload) => {
      const body = o.payload ? JSON.parse(ctx.interpolate(JSON.stringify(o.payload), payload)) : payload
      const r = await ctx.fetch(ctx.config.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error(`Zapier hook ${r.status}`)
      return { status: r.status }
    },
  }],
}

// ------------------------------------------------------------ generic API ----

export const rest: ConnectorDef = {
  id: 'rest',
  name: 'Custom REST API',
  description: 'Any HTTP API with a bearer token, header key or basic auth.',
  icon: 'globe',
  auth: 'apikey',
  docs: 'Point at a base URL and choose how requests authenticate. Actions can then call any path under it.',
  settings: [
    { key: 'baseUrl', label: 'Base URL', required: true, help: 'https://api.example.com/v1' },
    { key: 'authStyle', label: 'Auth style', type: 'select', help: 'bearer · header · basic · none' },
    { key: 'headerName', label: 'Header name', help: 'for the "header" style, e.g. X-API-Key' },
    { key: 'apiKey', label: 'API key / token', secret: true },
  ],
  test: async ctx => {
    if (!ctx.config.baseUrl) return { ok: false, detail: 'No base URL' }
    const r = await ctx.fetch(ctx.config.baseUrl)
    return { ok: r.ok, detail: `HTTP ${r.status} from ${ctx.config.baseUrl}` }
  },
  actions: [{
    key: 'request',
    label: 'Call the API',
    fields: [
      { key: 'path', label: 'Path', required: true, help: '/contacts — appended to the base URL' },
      { key: 'method', label: 'Method', help: 'GET · POST · PUT · PATCH · DELETE' },
      { key: 'body', label: 'JSON body', type: 'json' },
    ],
    run: async (ctx, o, payload) => {
      const url = String(ctx.config.baseUrl || '').replace(/\/$/, '') + ctx.interpolate(o.path || '/', payload)
      const method = (o.method || 'POST').toUpperCase()
      const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
      if (method !== 'GET' && method !== 'DELETE') {
        init.body = o.body ? ctx.interpolate(JSON.stringify(o.body), payload) : JSON.stringify(payload)
      }
      const r = await ctx.fetch(url, init)
      const d = await j(r)
      if (!r.ok) throw new Error(d.error || d.message || `HTTP ${r.status}`)
      return d
    },
  }],
}

export const CONNECTORS: ConnectorDef[] = [google, xero, zapier, rest]
export const byId = (id: string) => CONNECTORS.find(c => c.id === id)
