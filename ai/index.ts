// AI bridge — connects the studio and automations to any OpenAI-compatible
// endpoint (or an MCP-style HTTP agent). Powers the editor's "assist" actions
// (improve text, draft meta descriptions) and the `ai.generate` automation
// action for agent-triggered flows. Degrades gracefully when unconfigured.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { interpolate } from '../automations/index.ts'

export const manifest: PluginManifest = {
  id: 'ai', name: 'AI assist', version: '0.1.0', builtin: true,
  description: 'Writing help inside the editor, and automatic replies that use an AI service you sign up for.',
  permissions: ['routes.api', 'settings.own', 'net.fetch', 'actions.register', 'events.listen', 'events.emit'],
}

const TASKS: Record<string, string> = {
  improve: 'Improve the following text for clarity and flow. Keep the meaning, tone and language. Return only the improved text, no preamble.',
  shorten: 'Rewrite the following text to roughly half its length without losing key information. Return only the text.',
  expand: 'Expand the following text with one or two supporting sentences. Match the tone. Return only the text.',
  meta: 'Write a compelling SEO meta description (max 155 characters) for a page with the following content. Return only the description.',
  headline: 'Suggest a sharper headline for the following content. Return only the headline.',
  alt: 'Write concise, descriptive alt text (max 120 chars) for an image in this context. Return only the alt text.',
}

export function register(ctx: PluginContext) {
  async function config() {
    return {
      endpoint: await ctx.settings.get('endpoint', ''),
      apiKey: await ctx.settings.get('apiKey', ''),
      model: await ctx.settings.get('model', ''),
    }
  }

  async function complete(system: string, prompt: string): Promise<string> {
    const cfg = await config()
    if (!cfg.endpoint) throw new Error('AI endpoint not configured (studio → Plugins → AI assist)')
    const res = await ctx.fetch(cfg.endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model || 'default',
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        max_tokens: 1000,
      }),
    })
    if (!res.ok) throw new Error(`AI endpoint error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json: any = await res.json()
    return json.choices?.[0]?.message?.content?.trim() || ''
  }

  ctx.adminPanel({ label: 'AI assist', icon: 'sparkle', settingsOnly: true })

  ctx.routes.api(app => {
    app.get('/config', async c => {
      const cfg = await config()
      return c.json({ endpoint: cfg.endpoint, model: cfg.model, hasKey: !!cfg.apiKey })
    })
    app.put('/config', async c => {
      const body = await c.req.json()
      if (body.endpoint !== undefined) await ctx.settings.set('endpoint', String(body.endpoint))
      if (body.model !== undefined) await ctx.settings.set('model', String(body.model))
      if (body.apiKey) await ctx.settings.set('apiKey', String(body.apiKey))
      return c.json({ ok: true })
    })
    app.post('/assist', async c => {
      const { task, text, instruction } = await c.req.json()
      const system = instruction || TASKS[task]
      if (!system) return c.json({ error: `unknown task — one of: ${Object.keys(TASKS).join(', ')}` }, 400)
      if (!text) return c.json({ error: 'text required' }, 400)
      try {
        return c.json({ result: await complete(system, String(text).slice(0, 12000)) })
      } catch (e: any) {
        return c.json({ error: String(e?.message || e) }, 502)
      }
    })
  })

  // automation action: run a prompt with the event payload interpolated,
  // optionally POST the result onward (agent hand-off / MCP-style trigger)
  ctx.actions.register({
    type: 'ai.generate', label: 'Generate with AI',
    run: async (o, payload) => {
      const result = await complete(o.system || 'You are a helpful assistant. Reply with only the requested output.', interpolate(o.prompt || '{data}', payload))
      if (o.forwardTo) {
        await ctx.fetch(o.forwardTo, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ result, payload }),
        })
      }
      return { result: result.slice(0, 2000) }
    },
  })
}
