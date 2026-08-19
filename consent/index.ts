// Consent — a small, honest GDPR/cookie layer: a banner with real choices,
// a preferences block for a /cookies page, and hard gating of the analytics
// beacon (wired in page assembly) until 'analytics' is granted. No third-party
// script, no dark patterns: Decline is as prominent as Accept.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { escapeHtml as eh } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'consent', name: 'Consent & cookies', version: '0.1.0', builtin: true,
  description: 'GDPR-friendly consent banner, preference centre, and analytics gating',
  permissions: ['blocks.register', 'settings.own'],
}

export function register(ctx: PluginContext) {
  ctx.settingsSection({
    key: 'consent', label: 'Consent banner',
    description: 'Shown until the visitor chooses. Analytics only runs after the analytics category is granted.',
    fields: [
      { key: 'message', label: 'Message', type: 'textarea', default: 'We use a few cookies to understand how the site is used. You choose.' },
      { key: 'policyHref', label: 'Privacy policy link', default: '/privacy', width: 'half' },
      { key: 'position', label: 'Position', type: 'select', options: [{ value: 'bottom' }, { value: 'bottom-left' }, { value: 'bottom-right' }], default: 'bottom-left', width: 'half' },
      { key: 'marketing', label: 'Offer a “marketing” category', type: 'boolean', default: false },
    ],
  })

  ctx.blocks.register({
    type: 'consent-preferences', label: 'Cookie preferences', group: 'Interactive', icon: 'shield',
    description: 'Lets visitors review and change their consent — put it on your privacy page',
    fields: [{ key: 'title', type: 'text', label: 'Title', default: 'Cookie preferences' }],
    render: (_c, n) =>
      `<div class="wb-consent-prefs" data-blockhouse-consent-prefs>
        <h3>${eh(n.props.title || 'Cookie preferences')}</h3>
        <label class="cp-row"><input type="checkbox" checked disabled> <span><strong>Necessary</strong> — sign-in, security, saving your choice. Always on.</span></label>
        <label class="cp-row"><input type="checkbox" data-consent-cat="analytics"> <span><strong>Analytics</strong> — anonymous page counts, no third parties.</span></label>
        <label class="cp-row" data-consent-marketing hidden><input type="checkbox" data-consent-cat="marketing"> <span><strong>Marketing</strong> — used only if you add marketing tags.</span></label>
        <p><button class="btn btn-primary" data-consent-save>Save choices</button> <span class="cp-status" role="status"></span></p>
      </div>`,
  })
}

/** Banner + tiny consent runtime — injected by page assembly when enabled. */
export function consentHtml(settings: Record<string, any>, opts: { beacon?: boolean } = {}): string {
  const beaconOn = opts.beacon !== false
  const msg = eh(settings.message || 'We use a few cookies to understand how the site is used. You choose.')
  const policy = eh(settings.policyHref || '/privacy')
  const pos = ['bottom', 'bottom-left', 'bottom-right'].includes(settings.position) ? settings.position : 'bottom-left'
  const marketing = !!settings.marketing
  return `
<div id="blockhouse-consent" class="blockhouse-consent pos-${pos}" hidden role="dialog" aria-live="polite" aria-label="Cookie consent">
  <p class="wc-msg">${msg} <a href="${policy}">Details</a></p>
  <div class="wc-actions">
    <button class="wc-btn wc-accept" data-wc="all">Accept</button>
    <button class="wc-btn wc-decline" data-wc="necessary">Decline</button>
    <button class="wc-btn wc-manage" data-wc="manage">Manage</button>
  </div>
  <div class="wc-manage-panel" hidden>
    <label><input type="checkbox" checked disabled> Necessary</label>
    <label><input type="checkbox" data-wc-cat="analytics"> Analytics</label>
    ${marketing ? '<label><input type="checkbox" data-wc-cat="marketing"> Marketing</label>' : ''}
    <button class="wc-btn wc-accept" data-wc="save">Save</button>
  </div>
</div>
<style>
.blockhouse-consent{position:fixed;z-index:9999;max-width:22rem;background:var(--bg-raise,#fff);color:var(--ink,#111);border:1px solid var(--line,#ddd);border-radius:12px;padding:1rem 1.1rem;box-shadow:0 8px 40px #0003;font-size:0.88rem;line-height:1.5}
.blockhouse-consent.pos-bottom{left:50%;transform:translateX(-50%);bottom:1rem}.blockhouse-consent.pos-bottom-left{left:1rem;bottom:1rem}.blockhouse-consent.pos-bottom-right{right:1rem;bottom:1rem}
.wc-msg{margin:0 0 0.7rem}.wc-actions{display:flex;gap:0.45rem;flex-wrap:wrap}
.wc-btn{font:inherit;font-weight:650;padding:0.45rem 0.9rem;border-radius:999px;border:1px solid var(--line,#ccc);background:none;color:inherit;cursor:pointer}
.wc-accept{background:var(--accent,#111);border-color:var(--accent,#111);color:var(--accent-contrast,#fff)}
.wc-manage-panel:not([hidden]){display:grid;gap:0.4rem;margin-top:0.7rem}.wc-manage-panel label{display:flex;gap:0.45rem;align-items:center}
.blockhouse-consent[hidden]{display:none}
</style>
<script>(function(){
var K='blockhouse_consent',el=document.getElementById('blockhouse-consent');if(!el)return;
function read(){var m=document.cookie.match(/(?:^|; )blockhouse_consent=([^;]*)/);return m?decodeURIComponent(m[1]).split(','):null}
function write(cats){var v=encodeURIComponent(cats.join(','));document.cookie='blockhouse_consent='+v+'; path=/; max-age=15552000; samesite=lax';try{localStorage.setItem(K,cats.join(','))}catch(e){}
  document.dispatchEvent(new CustomEvent('blockhouse:consent',{detail:cats}));el.hidden=true;
  ${beaconOn ? "if(cats.indexOf('analytics')>-1&&navigator.sendBeacon){navigator.sendBeacon('/x/analytics/hit',JSON.stringify({p:location.pathname,r:document.referrer}))}" : ''}}
var cur=read();if(!cur)el.hidden=false;
el.addEventListener('click',function(e){var b=e.target.closest('[data-wc]');if(!b)return;var k=b.dataset.wc;
  if(k==='manage'){el.querySelector('.wc-manage-panel').hidden=false;return}
  if(k==='all'){var cats=['necessary','analytics'];${marketing ? "cats.push('marketing');" : ''}write(cats);return}
  if(k==='necessary'){write(['necessary']);return}
  if(k==='save'){var cats=['necessary'];el.querySelectorAll('[data-wc-cat]').forEach(function(c){if(c.checked)cats.push(c.dataset.wcCat)});write(cats)}});
// preference blocks anywhere on the page
document.querySelectorAll('[data-blockhouse-consent-prefs]').forEach(function(p){
  var cur=read()||[];p.querySelectorAll('[data-consent-cat]').forEach(function(c){c.checked=cur.indexOf(c.dataset.consentCat)>-1});
  ${marketing ? "var mk=p.querySelector('[data-consent-marketing]');if(mk)mk.hidden=false;" : ''}
  var save=p.querySelector('[data-consent-save]');if(save)save.addEventListener('click',function(){
    var cats=['necessary'];p.querySelectorAll('[data-consent-cat]').forEach(function(c){if(c.checked)cats.push(c.dataset.consentCat)});
    write(cats);var st=p.querySelector('.cp-status');if(st)st.textContent='Saved.'})});
})()</script>`
}
