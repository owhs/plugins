// Reading progress — a thin bar that tracks how far down the page (or how far
// through the article) the visitor has read. One block, no dependencies, no
// layout shift: the bar is either fixed to an edge of the viewport or sticky
// where it was placed.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { escapeAttr as ea } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'progress', name: 'Reading progress', version: '0.1.0', builtin: true,
  description: 'A thin line across the top of the page showing how far down a reader has got.',
  permissions: ['blocks.register'],
}

const POSITIONS = [
  { value: 'fixed-top', label: 'Fixed to the top of the viewport' },
  { value: 'fixed-bottom', label: 'Fixed to the bottom of the viewport' },
  { value: 'fixed-under-header', label: 'Fixed under the site header' },
  { value: 'sticky', label: 'Sticky where it is placed' },
  { value: 'inline', label: 'Inline where it is placed' },
]

export function register(ctx: PluginContext) {
  ctx.blocks.register({
    type: 'progress', label: 'Reading progress', group: 'Interactive', icon: 'chart',
    description: 'A progress line that follows the scroll position of the page or of the article',
    fields: [
      { key: 'position', type: 'select', label: 'Position', default: 'fixed-top', options: POSITIONS },
      { key: 'measure', type: 'select', label: 'Measure', default: 'page', width: 'half',
        help: 'The whole page, or just the article body',
        options: [{ value: 'page', label: 'Whole page' }, { value: 'main', label: 'Main content' }] },
      { key: 'thickness', type: 'number', label: 'Thickness (px)', default: 3, width: 'half' },
      { key: 'colour', type: 'select', label: 'Colour', default: 'accent', width: 'half',
        options: [
          { value: 'accent', label: 'Theme accent' },
          { value: 'ink', label: 'Theme ink' },
          { value: 'custom', label: 'Custom' },
        ] },
      { key: 'customColour', type: 'color', label: 'Custom colour', default: '#17a05c', width: 'half' },
      { key: 'gradient', type: 'select', label: 'Gradient', default: 'none', width: 'half',
        options: [
          { value: 'none', label: 'Solid' },
          { value: 'fade', label: 'Fade in from transparent' },
          { value: 'two', label: 'Blend to a second colour' },
        ] },
      { key: 'gradientTo', type: 'color', label: 'Second colour', default: '#a9b534', width: 'half' },
      { key: 'glow', type: 'boolean', label: 'Glow', default: false, width: 'half' },
      { key: 'track', type: 'boolean', label: 'Show the unread track', default: false, width: 'half' },
      { key: 'radius', type: 'boolean', label: 'Round the leading edge', default: false, width: 'half' },
      { key: 'hideAtTop', type: 'boolean', label: 'Hide until the visitor scrolls', default: true, width: 'half' },
    ],
    defaults: {
      position: 'fixed-top', measure: 'page', thickness: 3, colour: 'accent',
      customColour: '#17a05c', gradient: 'none', gradientTo: '#a9b534',
      glow: false, track: false, radius: false, hideAtTop: true,
    },
    render: (_ctx, n) => {
      const p = n.props || {}
      const pos = POSITIONS.some(x => x.value === p.position) ? p.position : 'fixed-top'
      const h = Math.max(1, Math.min(24, Number(p.thickness) || 3))
      const base = p.colour === 'custom' ? String(p.customColour || '#17a05c')
        : p.colour === 'ink' ? 'var(--ink, #111)' : 'var(--accent, #17a05c)'
      const to = String(p.gradientTo || '#a9b534')
      const fill = p.gradient === 'two' ? `linear-gradient(90deg, ${base}, ${to})`
        : p.gradient === 'fade' ? `linear-gradient(90deg, transparent, ${base})`
          : base
      const style = [
        `--wp-h:${h}px`,
        `--wp-fill:${fill}`,
        `--wp-glow:${p.glow ? `0 0 ${Math.max(6, h * 3)}px ${base}` : 'none'}`,
        `--wp-track:${p.track ? 'color-mix(in oklch, currentColor 12%, transparent)' : 'transparent'}`,
        `--wp-radius:${p.radius ? '99px' : '0'}`,
      ].join(';')
      return `<div class="wp-progress pos-${ea(pos)}"${p.hideAtTop ? ' data-wp-hide="1"' : ''}` +
        ` data-wp-measure="${ea(p.measure === 'main' ? 'main' : 'page')}" style="${ea(style)}" aria-hidden="true">` +
        `<span class="wp-bar"></span>${PROGRESS_CSS}${PROGRESS_JS}</div>`
    },
  })
}

/** Scoped once per page — repeated <style> text is deduplicated by the browser. */
const PROGRESS_CSS = `<style>
.wp-progress { --wp-p: 0; display: block; width: 100%; height: var(--wp-h); background: var(--wp-track); z-index: 120; pointer-events: none; }
.wp-progress.pos-fixed-top { position: fixed; inset: 0 0 auto 0; }
.wp-progress.pos-fixed-bottom { position: fixed; inset: auto 0 0 0; }
.wp-progress.pos-fixed-under-header { position: fixed; inset: var(--header-h, 0) 0 auto 0; }
.wp-progress.pos-sticky { position: sticky; top: var(--header-h, 0); }
.wp-progress.pos-inline { position: relative; }
.wp-progress[data-wp-hide="1"] { opacity: 0; transition: opacity .2s; }
.wp-progress[data-wp-hide="1"].is-scrolled { opacity: 1; }
.wp-bar {
  display: block; height: 100%; width: 100%;
  transform: scaleX(var(--wp-p)); transform-origin: left center;
  background: var(--wp-fill); box-shadow: var(--wp-glow);
  border-radius: 0 var(--wp-radius) var(--wp-radius) 0;
  will-change: transform;
}
@media (prefers-reduced-motion: no-preference) { .wp-bar { transition: transform .08s linear; } }
</style>`

/** Self-contained behaviour: one rAF-throttled scroll listener per bar. */
const PROGRESS_JS = `<script>
(function () {
  var els = document.querySelectorAll('.wp-progress:not([data-wp-ready])')
  for (var i = 0; i < els.length; i++) (function (el) {
    el.dataset.wpReady = '1'
    var useMain = el.dataset.wpMeasure === 'main', ticking = false
    function measure() {
      ticking = false
      var p = 0
      if (useMain) {
        var m = document.querySelector('main') || document.body, r = m.getBoundingClientRect()
        var total = r.height - innerHeight
        p = total > 0 ? (-r.top) / total : (r.bottom <= innerHeight ? 1 : 0)
      } else {
        var t = document.documentElement.scrollHeight - innerHeight
        p = t > 0 ? scrollY / t : 0
      }
      p = Math.max(0, Math.min(1, p))
      el.style.setProperty('--wp-p', String(p))
      el.classList.toggle('is-scrolled', scrollY > 4)
    }
    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(measure) } }
    addEventListener('scroll', onScroll, { passive: true })
    addEventListener('resize', onScroll, { passive: true })
    measure()
  })(els[i])
})()
<\/script>`
