// Built-in plugin registry. Site plugins can be added here or dropped into a
// project and passed to buildEnv — every plugin goes through the same
// permission approval flow regardless of origin.

import * as forms from './forms/index.ts'
import * as files from './files/index.ts'
import * as newsletter from './newsletter/index.ts'
import * as automations from './automations/index.ts'
import * as data from './data/index.ts'
import * as ai from './ai/index.ts'
import * as search from './search/index.ts'
import * as analytics from './analytics/index.ts'
import * as integrations from './integrations/index.ts'
import * as members from './members/index.ts'
import * as consent from './consent/index.ts'
import * as drive from './drive/index.ts'
import * as commerce from './commerce/index.ts'
import * as mdsync from './mdsync/index.ts'
import * as progress from './progress/index.ts'
import * as ops from './ops/index.ts'
import * as ahrefs from './ahrefs/index.ts'

export const builtinPlugins = {
  forms: { manifest: forms.manifest, register: forms.register },
  files: { manifest: files.manifest, register: files.register },
  newsletter: { manifest: newsletter.manifest, register: newsletter.register },
  automations: { manifest: automations.manifest, register: automations.register },
  data: { manifest: data.manifest, register: data.register },
  search: { manifest: search.manifest, register: search.register },
  analytics: { manifest: analytics.manifest, register: analytics.register },
  integrations: { manifest: integrations.manifest, register: integrations.register },
  members: { manifest: members.manifest, register: members.register },
  consent: { manifest: consent.manifest, register: consent.register },
  progress: { manifest: progress.manifest, register: progress.register },
  drive: { manifest: drive.manifest, register: drive.register },
  commerce: { manifest: commerce.manifest, register: commerce.register },
  mdsync: { manifest: mdsync.manifest, register: mdsync.register },
  ai: { manifest: ai.manifest, register: ai.register },
  ops: { manifest: ops.manifest, register: ops.register },
  ahrefs: { manifest: ahrefs.manifest, register: ahrefs.register },
}
